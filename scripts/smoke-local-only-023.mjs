#!/usr/bin/env node
// Aceptación de "Solo modelos locales" sobre un chat cloud ya existente. El provider Anthropic
// apunta a un servidor HTTP loopback sintético, pero conserva locality=cloud por contrato del
// provider: no hay Internet, credenciales reales ni costo. La primera generación debe llegar al
// servidor; después de activar models.localOnly, la segunda debe fallar en UI sin otro POST.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { assertCleanShutdown, launchAtPort, stop, waitForRenderedRoot } from './smoke-release-functional.mjs';

const MODEL_NAME = 'claude-local-only-fixture';
const FIRST_PROMPT = 'Respondé solamente: CLOUD_ANTES_OK';
const SECOND_PROMPT = 'Este mensaje debe quedar bloqueado por Solo local.';
const FIRST_RESPONSE = 'CLOUD_ANTES_OK';
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke localOnly: ${message}`);
}

function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Smoke localOnly: falta la ruta después de ${flag}`);
  return value;
}

async function until(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(75);
  }
  throw new Error(`Smoke localOnly: timeout esperando ${description}`);
}

async function forceStop(instance) {
  try { instance.cdp?.socket?.close(); } catch { /* rescate de un smoke fallido */ }
  if (instance.child?.exitCode === null) instance.child.kill();
  const deadline = Date.now() + 3_000;
  while (instance.child?.exitCode === null && Date.now() < deadline) await delay(25);
}

function writeSse(response, event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

const postRequests = [];
const modelServer = createServer((request, response) => {
  if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      data: [{
        type: 'model', id: MODEL_NAME, display_name: 'Fixture cloud localOnly',
        max_input_tokens: 8_192, capabilities: { thinking: { supported: false }, image_input: { supported: false } },
      }],
      has_more: false, first_id: MODEL_NAME, last_id: MODEL_NAME,
    }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/messages') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Endpoint no habilitado.' } }));
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    postRequests.push(body);
    response.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
    });
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_local_only_1', type: 'message', role: 'assistant', content: [], model: MODEL_NAME,
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: FIRST_RESPONSE } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } },
      { type: 'message_stop' },
    ];
    for (const event of events) writeSse(response, event);
    response.end();
  });
});

await new Promise((done, reject) => {
  modelServer.once('error', reject);
  modelServer.listen(0, '127.0.0.1', done);
});
const address = modelServer.address();
if (!address || typeof address === 'string') throw new Error('Smoke localOnly: el servidor sintético no obtuvo puerto.');
const baseUrl = `http://127.0.0.1:${address.port}`;

const dev = process.argv.includes('--dev');
const exePath = resolve(dev
  ? 'node_modules/electron/dist/electron.exe'
  : (cliValue('--exe') ?? 'apps/desktop/release/win-unpacked/SaurioLLM.exe'));
assert(existsSync(exePath), `no existe el ejecutable: ${exePath}`);

const tempRoot = mkdtempSync(join(tmpdir(), 'saurio-local-only-023-'));
const profile = join(tempRoot, 'perfil aislado');
const projectPath = join(tempRoot, 'proyecto cloud existente');
let app;
let completed = false;

try {
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, 'evidencia.txt'), 'Proyecto aislado para probar models.localOnly.\n', 'utf8');
  const appArgs = dev ? [resolve('apps/desktop')] : [];

  // Siembra exclusivamente por IPC real: provider Anthropic con endpoint loopback, pero locality
  // cloud autoritativa; chat explícito y consentimiento sintético, sin ninguna llamada externa.
  app = await launchAtPort(exePath, profile, appArgs);
  await waitForRenderedRoot(app.cdp);
  await app.cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });
  const project = await app.cdp.invoke('project:open', { path: projectPath });
  const provider = await app.cdp.invoke('providers:add', {
    preset: 'anthropic', label: 'Cloud sintética localOnly', baseUrl,
  });
  assert(provider.locality === 'cloud', `el fixture no quedó clasificado cloud: ${provider.locality}`);
  const chat = await app.cdp.invoke('chat:create', {
    projectId: project.id, agentId: 'agent_builtin_lead', mode: 'ask', modelSelection: 'explicit',
    modelRef: { providerId: provider.id, name: MODEL_NAME, locality: 'cloud' }, confirmed: true,
  });
  await app.cdp.invoke('settings:set', { key: 'ui.projects.lastProjectId', value: project.id });
  await app.cdp.invoke('settings:set', { key: 'ui.projects.lastChatId', value: chat.id });
  assertCleanShutdown(await stop(app), 'siembra del chat cloud existente');
  app = undefined;

  app = await launchAtPort(exePath, profile, appArgs);
  await waitForRenderedRoot(app.cdp);
  await until(
    () => app.cdp.evaluate('document.querySelector(\'textarea[aria-label="Mensaje para el agente"]\') instanceof HTMLTextAreaElement'),
    'el compositor del chat restaurado',
  );
  await app.cdp.evaluate('window.__localOnlyEvents = []; window.saurio.onEvent(\'runtime:event\', (events) => window.__localOnlyEvents.push(...events));');
  assert(await app.cdp.invoke('settings:get', { key: 'models.localOnly' }) !== true,
    'el perfil aislado empezó con models.localOnly activado');

  const first = await app.cdp.invoke('run:start', { chatId: chat.id, text: FIRST_PROMPT, mode: 'ask' });
  await until(() => postRequests.length === 1, 'el primer POST cloud sintético');
  await until(
    () => app.cdp.evaluate(`window.__localOnlyEvents.some((event) => event.runId === ${JSON.stringify(first.runId)} && event.type === 'run.state' && event.to === 'completed')`),
    'el primer run completado',
  );
  await until(
    () => app.cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(FIRST_RESPONSE)})`),
    'la primera respuesta visible',
  );
  assert(postRequests[0]?.model === MODEL_NAME, `el primer POST usó modelo inesperado: ${postRequests[0]?.model}`);

  await app.cdp.invoke('settings:set', { key: 'models.localOnly', value: true });
  assert(await app.cdp.invoke('settings:get', { key: 'models.localOnly' }) === true,
    'models.localOnly no quedó persistido');
  const postsBeforeBlockedRun = postRequests.length;
  const second = await app.cdp.invoke('run:start', { chatId: chat.id, text: SECOND_PROMPT, mode: 'ask' });
  await until(
    () => app.cdp.evaluate(`window.__localOnlyEvents.some((event) => event.runId === ${JSON.stringify(second.runId)} && event.type === 'run.state' && event.to === 'failed')`),
    'el segundo run bloqueado',
  );
  const secondEvents = await app.cdp.evaluate(`window.__localOnlyEvents.filter((event) => event.runId === ${JSON.stringify(second.runId)})`);
  const visibleError = secondEvents.find((event) => event.type === 'run.error')?.error?.message;
  assert(typeof visibleError === 'string' && visibleError.includes('Solo modelos locales'),
    `el run no informó el bloqueo localOnly: ${visibleError}`);
  await until(
    () => app.cdp.evaluate(`document.querySelector('[role="alert"]')?.textContent?.includes('Solo modelos locales') === true`),
    'el error localOnly visible en el chat',
  );
  await delay(750);
  assert(postRequests.length === postsBeforeBlockedRun,
    `el provider recibió ${postRequests.length - postsBeforeBlockedRun} POST adicionales después del bloqueo`);

  assertCleanShutdown(await stop(app), 'cierre final');
  app = undefined;
  completed = true;
  console.log(JSON.stringify({
    ok: true,
    executable: exePath,
    providerLocality: provider.locality,
    firstRun: 'completed',
    blockedRun: 'failed-visible',
    postRequestsBeforeLocalOnly: postsBeforeBlockedRun,
    postRequestsAfterLocalOnly: postRequests.length,
    additionalPostsAfterLocalOnly: postRequests.length - postsBeforeBlockedRun,
    externalCalls: 0,
    profile,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false, profile, baseUrl, postRequests: postRequests.length, error: String(error),
  }, null, 2));
  throw error;
} finally {
  if (app) await forceStop(app);
  modelServer.closeAllConnections();
  await new Promise((done) => modelServer.close(done));
  const resolvedTemp = resolve(tempRoot);
  if (completed && resolve(resolvedTemp, '..') === resolve(tmpdir()) && basename(resolvedTemp).startsWith('saurio-local-only-023-')) {
    rmSync(resolvedTemp, { recursive: true, force: true });
  } else if (!completed) {
    console.error(`Smoke localOnly falló; se preservó el perfil: ${resolvedTemp}`);
  }
}
