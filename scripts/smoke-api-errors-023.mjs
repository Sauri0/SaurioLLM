// Proveedor HTTP sintético local: errores de generación y recuperación, sin inferencia paga.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown } from './smoke-release-functional.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(test, message) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (await test()) return; await delay(100); }
  throw new Error(message);
}
let status = 200;
const requests = [];
const server = createServer((req, res) => {
  if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'api-fixture', context_length: 8192 }] }));
  if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    requests.push({ status, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (status !== 200) return res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `Fixture HTTP ${status}`, type: status === 401 ? 'authentication_error' : 'rate_limit_error' } }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'RECUPERACION_API_OK' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const root = mkdtempSync(join(tmpdir(), 'saurio-api-errors-023-'));
const profile = join(root, 'perfil');
const workspace = join(root, 'proyecto otra unidad');
mkdirSync(workspace);
writeFileSync(join(workspace, 'evidencia.txt'), 'Archivo aislado.');
let app;
try {
  const dev = process.argv.includes('--dev');
  const exe = resolve(dev ? 'node_modules/electron/dist/electron.exe' : 'apps/desktop/release/win-unpacked/SaurioLLM.exe');
  const args = dev ? [resolve('apps/desktop')] : [];
  app = await launchAtPort(exe, profile, args);
  await waitForRenderedRoot(app.cdp);
  await app.cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });
  const project = await app.cdp.invoke('project:open', { path: workspace });
  const provider = await app.cdp.invoke('providers:add', { preset: 'custom', label: 'API fixture', baseUrl: `http://127.0.0.1:${server.address().port}` });
  const chat = await app.cdp.invoke('chat:create', { projectId: project.id, agentId: 'agent_builtin_lead', mode: 'ask', modelSelection: 'explicit', modelRef: { providerId: provider.id, name: 'api-fixture', locality: 'local' } });
  await app.cdp.invoke('settings:set', { key: 'ui.projects.lastProjectId', value: project.id });
  await app.cdp.invoke('settings:set', { key: 'ui.projects.lastChatId', value: chat.id });
  assertCleanShutdown(await stop(app), 'preparación');
  app = await launchAtPort(exe, profile, args);
  await waitForRenderedRoot(app.cdp);
  await until(() => app.cdp.evaluate(`Boolean(document.querySelector('textarea[aria-label="Mensaje para el agente"]'))`), 'compositor ausente');
  await app.cdp.evaluate(`window.__apiEvents = []; window.saurio.onEvent('runtime:event', events => window.__apiEvents.push(...events));`);
  const results = [];
  for (const code of [401, 429, 200]) {
    console.log(`Probando HTTP ${code}…`);
    status = code;
    const { runId } = await app.cdp.invoke('run:start', { chatId: chat.id, text: `Prueba ${code}`, mode: 'ask' });
    await until(() => app.cdp.evaluate(`window.__apiEvents.some(e => e.runId === ${JSON.stringify(runId)} && e.type === 'run.state' && ['failed','completed'].includes(e.to))`), `run ${code} no terminó`);
    const events = await app.cdp.evaluate(`window.__apiEvents.filter(e => e.runId === ${JSON.stringify(runId)})`);
    const terminal = events.find(e => e.type === 'run.state' && ['failed', 'completed'].includes(e.to));
    assert(terminal.to === (code === 200 ? 'completed' : 'failed'), `estado incorrecto para ${code}`);
    const visible = code === 200 ? 'RECUPERACION_API_OK' : events.find(e => e.type === 'run.error')?.error?.message;
    assert(visible, `no hay mensaje de error para ${code}`);
    const target = code === 200 ? 'document.body' : `document.querySelector('[role="alert"].saurio-banner.danger')`;
    await until(() => app.cdp.evaluate(`${target}?.innerText.includes(${JSON.stringify(visible)}) === true`), `UI no muestra resultado ${code}`);
    results.push({ code, terminal: terminal.to, visible: true });
  }
  assert(requests.length >= 3 && requests.every(r => r.body.model === 'api-fixture'), 'solicitudes inesperadas');
  assert(requests[0].body.messages.some(message => typeof message.content === 'string' && message.content.includes(workspace)), 'raíz real ausente del prompt');
  assertCleanShutdown(await stop(app), 'final'); app = undefined;
  console.log(JSON.stringify({ ok: true, results, requests: requests.map(r => r.status), workspace, externalCalls: 0, profile, limitation: 'Proveedor HTTP sintético local; no certifica proveedor externo ni bloqueo de nube.' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ profile, requests: requests.map(r => r.status), error: String(error) }));
  throw error;
} finally {
  if (app) await stop(app);
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
