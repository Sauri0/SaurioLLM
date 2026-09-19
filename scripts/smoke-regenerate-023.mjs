#!/usr/bin/env node
// Aceptación real de Regenerar. Usa un servidor OpenAI-compatible local y opera las dos
// regeneraciones desde la UI; no usa Ollama, Internet ni APIs pagas.
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown } from './smoke-release-functional.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const PROMPT = 'Explicá por qué el cielo se ve azul en una sola oración.';
const ANSWERS = ['Respuesta original.', 'Alternativa uno.', 'Alternativa dos.'];

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke regenerar: ${message}`);
}

function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`falta la ruta después de ${flag}`);
  return value;
}

async function waitUntil(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Smoke regenerar: timeout: ${message}`);
}

async function forceStop(instance) {
  try { instance.cdp?.socket?.close(); } catch { /* cleanup de un smoke fallido */ }
  if (instance.child?.exitCode === null) instance.child.kill();
  const deadline = Date.now() + 3_000;
  while (instance.child?.exitCode === null && Date.now() < deadline) await delay(25);
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((part) => typeof part === 'string' ? part : (part?.text ?? '')).join('\n');
}

function assertRegenerationRequest(request, excludedAnswers) {
  assert(request?.model === 'slow-local', `modelo inesperado en request: ${request?.model}`);
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  assert(messages.some((message) => message.role === 'user' && messageText(message).includes(PROMPT)),
    'el prompt no contiene el pedido original');
  const serialized = JSON.stringify(messages);
  for (const answer of excludedAnswers) {
    assert(!serialized.includes(answer), `el prompt regenerado incluyó una respuesta anterior: ${answer}`);
  }
}

async function clickButton(cdp, label, position = 'first') {
  const clicked = await cdp.evaluate(`(() => {
    const matches = [...document.querySelectorAll('button')]
      .filter((button) => button.textContent?.trim() === ${JSON.stringify(label)} && !button.disabled);
    const button = ${JSON.stringify(position)} === 'last' ? matches.at(-1) : matches[0];
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, `no se encontró el botón habilitado "${label}" (${position})`);
}

async function regenerateLatest(cdp, expectedRequestCount) {
  await clickButton(cdp, 'Regenerar respuesta', 'last');
  await waitUntil(
    () => cdp.evaluate(`document.querySelector('[role="dialog"]')?.textContent?.includes('Regenerar respuesta') === true`),
    'no apareció la confirmación de regeneración',
  );
  const confirmed = await cdp.evaluate(`(() => {
    const button = document.querySelector('.saurio-text-dialog .saurio-btn-primary');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert(confirmed, 'el diálogo no permitió confirmar la regeneración');
  await waitUntil(() => serverState.chatRequests.length === expectedRequestCount,
    `el provider local no recibió el request ${expectedRequestCount}`);
}

const serverState = { chatRequests: [] };
const modelServer = createHttpServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'slow-local', object: 'model', owned_by: 'saurio-smoke', context_length: 8_192 }],
    }));
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: String(error) }));
        return;
      }
      const index = serverState.chatRequests.push(body) - 1;
      const text = ANSWERS[index] ?? `Alternativa extra ${index}.`;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(`data: ${JSON.stringify({
        id: `chatcmpl-regenerate-${index}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1_000),
        model: 'slow-local', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: `chatcmpl-regenerate-${index}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1_000),
        model: 'slow-local', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 32 + index, completion_tokens: 4 },
      })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    return;
  }
  response.writeHead(404).end();
});
await new Promise((done, reject) => {
  modelServer.once('error', reject);
  modelServer.listen(0, '127.0.0.1', done);
});
const modelAddress = modelServer.address();
if (!modelAddress || typeof modelAddress === 'string') throw new Error('servidor local sin puerto');
const modelBaseUrl = `http://127.0.0.1:${modelAddress.port}`;

const dev = process.argv.includes('--dev');
const exePath = resolve(dev
  ? 'node_modules/electron/dist/electron.exe'
  : (cliValue('--exe') ?? 'apps/desktop/release/win-unpacked/SaurioLLM.exe'));
if (!existsSync(exePath)) throw new Error(`no existe el ejecutable: ${exePath}`);

const tempRoot = mkdtempSync(join(tmpdir(), 'saurio-regenerate-023-'));
const profile = join(tempRoot, 'perfil aislado');
const evidenceDir = resolve('smoke/regenerate-023');
const screenshotPath = join(evidenceDir, 'regenerated-twice.png');
let setup;
let app;
let completed = false;
try {
  setup = await launchAtPort(exePath, profile, dev ? [resolve('apps/desktop')] : []);
  await waitForRenderedRoot(setup.cdp);
  await setup.cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });
  const project = await setup.cdp.invoke('project:createManaged', { name: 'Regenerar' });
  const provider = await setup.cdp.invoke('providers:add', {
    preset: 'custom', label: 'Modelo local de regeneración', baseUrl: modelBaseUrl,
  });
  const chat = await setup.cdp.invoke('chat:create', {
    projectId: project.id,
    agentId: 'agent_builtin_lead',
    mode: 'ask',
    modelSelection: 'explicit',
    modelRef: { providerId: provider.id, name: 'slow-local', locality: 'local' },
  });
  await setup.cdp.invoke('settings:set', { key: 'ui.projects.lastProjectId', value: project.id });
  await setup.cdp.invoke('settings:set', { key: 'ui.projects.lastChatId', value: chat.id });
  const setupExit = await stop(setup);
  setup = undefined;
  assertCleanShutdown(setupExit, 'preparación del perfil');

  app = await launchAtPort(exePath, profile, dev ? [resolve('apps/desktop')] : []);
  await waitForRenderedRoot(app.cdp);
  await waitUntil(
    () => app.cdp.evaluate(`document.querySelector('.chat-input__model')?.textContent?.includes('slow-local') === true`),
    'el chat restaurado no quedó listo',
  );

  const original = await app.cdp.invoke('run:start', { chatId: chat.id, text: PROMPT, mode: 'ask' });
  await waitUntil(() => serverState.chatRequests.length === 1, 'el provider local no recibió la respuesta original');
  await waitUntil(
    () => app.cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(ANSWERS[0])})
      && [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Regenerar respuesta')`),
    'la UI no mostró la respuesta original con su acción Regenerar',
  );
  assertRegenerationRequest(serverState.chatRequests[0], []);

  await regenerateLatest(app.cdp, 2);
  await waitUntil(
    () => app.cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(ANSWERS[1])})`),
    'la UI no mostró la primera alternativa',
  );
  assertRegenerationRequest(serverState.chatRequests[1], [ANSWERS[0]]);

  await regenerateLatest(app.cdp, 3);
  await waitUntil(
    () => app.cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(ANSWERS[2])})`),
    'la UI no mostró la segunda alternativa',
  );
  assertRegenerationRequest(serverState.chatRequests[2], [ANSWERS[0], ANSWERS[1]]);

  const history = await app.cdp.invoke('chat:history', { chatId: chat.id });
  const matchingUsers = history.messages.filter((message) => message.role === 'user' && message.content.includes(PROMPT));
  const assistants = history.messages.filter((message) => message.role === 'assistant');
  assert(matchingUsers.length === 1, `el historial duplicó el pedido original (${matchingUsers.length})`);
  assert(ANSWERS.every((answer) => assistants.some((message) => message.content === answer)),
    `el historial no conservó las tres respuestas: ${assistants.map((message) => message.content).join(' | ')}`);
  assert(new Set(assistants.filter((message) => ANSWERS.includes(message.content)).map((message) => message.originRunId)).size === 3,
    'las respuestas original y alternativas no quedaron correlacionadas con tres runs distintos');
  const alternativeLabels = await app.cdp.evaluate(
    `[...document.querySelectorAll('.chat-message-list__alternative')].filter((node) => node.textContent?.includes('Respuesta alternativa')).length`,
  );
  assert(alternativeLabels === 2, `la UI no separó las dos alternativas (${alternativeLabels})`);

  mkdirSync(evidenceDir, { recursive: true });
  const screenshot = await app.cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  const appExit = await stop(app);
  app = undefined;
  assertCleanShutdown(appExit, 'cierre después de regenerar');
  completed = true;
  console.log(JSON.stringify({
    ok: true,
    mode: dev ? 'dev' : 'packaged',
    originalRunId: original.runId,
    chatRequests: serverState.chatRequests.length,
    sameModel: serverState.chatRequests.every((request) => request.model === 'slow-local'),
    previousAnswersExcluded: true,
    userMessageCount: matchingUsers.length,
    assistantAnswers: assistants.filter((message) => ANSWERS.includes(message.content)).map((message) => ({
      content: message.content, originRunId: message.originRunId,
    })),
    alternativeLabels,
    screenshot: screenshotPath,
    externalCalls: 0,
  }, null, 2));
} finally {
  if (setup) await forceStop(setup);
  if (app) await forceStop(app);
  await new Promise((done) => modelServer.close(done));
  const resolvedTemp = resolve(tempRoot);
  if (completed && resolve(resolvedTemp, '..') === resolve(tmpdir()) && basename(resolvedTemp).startsWith('saurio-regenerate-023-')) {
    rmSync(resolvedTemp, { recursive: true, force: true });
  } else if (!completed) {
    console.error(`Smoke Regenerar falló; se preservó el perfil: ${resolvedTemp}`);
  }
}
