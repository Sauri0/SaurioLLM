// Aceptación real de cierre con un run activo. El modelo es un servidor OpenAI-compatible local
// controlado que deja un SSE abierto; no usa Ollama, Internet ni APIs pagas.
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CdpClient, launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown } from './smoke-release-functional.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const ACTIVE_STATES = new Set([
  'created', 'preparing', 'queued', 'generating', 'parsing',
  'awaiting_permission', 'executing_tool', 'compacting', 'cancelling',
]);

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke cierre activo: ${message}`);
}

function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`falta la ruta después de ${flag}`);
  return value;
}

async function freePort() {
  const server = createTcpServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  await new Promise((done) => server.close(done));
  if (!address || typeof address === 'string') throw new Error('no se pudo reservar puerto para inspector main');
  return address.port;
}

async function waitUntil(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Smoke cierre activo: timeout: ${message}`);
}

async function forceStop(instance) {
  try { instance.cdp?.socket?.close(); } catch { /* sólo cleanup de un smoke ya fallido */ }
  if (instance.child?.exitCode === null) instance.child.kill();
  const deadline = Date.now() + 3_000;
  while (instance.child?.exitCode === null && Date.now() < deadline) await delay(25);
}

async function connectMainInspector(port, child) {
  let lastError;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron terminó antes de abrir inspector main: ${child.exitCode}`);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = targets.find((item) => item.webSocketDebuggerUrl);
      if (target) {
        const client = new CdpClient(target.webSocketDebuggerUrl);
        await client.ready();
        return client;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`inspector main no respondió: ${String(lastError ?? 'sin detalle')}`);
}

function readRun(dbPath, runId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT state, finished_at AS finishedAt, last_event_seq AS lastEventSeq FROM runs WHERE id = ?').get(runId);
  } finally {
    db.close();
  }
}

function readTerminalEvents(dbPath, runId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT payload_json AS payload FROM run_events WHERE run_id = ? AND type = 'run.state' ORDER BY seq")
      .all(runId)
      .map((row) => JSON.parse(row.payload));
  } finally {
    db.close();
  }
}

const serverState = { chatRequests: 0, openStreams: 0, lastStreamClosedAt: undefined };
const openResponses = new Set();
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
    request.resume();
    serverState.chatRequests += 1;
    serverState.openStreams += 1;
    openResponses.add(response);
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-shutdown-smoke', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1_000),
      model: 'slow-local', choices: [{ index: 0, delta: { role: 'assistant', content: 'Trabajando…' }, finish_reason: null }],
    })}\n\n`);
    response.on('close', () => {
      if (openResponses.delete(response)) serverState.openStreams -= 1;
      serverState.lastStreamClosedAt = Date.now();
    });
    return; // permanece abierto hasta que AbortSignal cancele el fetch
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

const tempRoot = mkdtempSync(join(tmpdir(), 'saurio-shutdown-active-023-'));
const profile = join(tempRoot, 'perfil aislado');
const dialogLogPath = join(tempRoot, 'shutdown-dialogs.json');
const dbPath = join(profile, 'saurio.db');
const smokeEvidenceDir = resolve('smoke/shutdown-active-023');
const contextScreenshotPath = join(smokeEvidenceDir, 'context-inspector.png');
const inspectorPort = await freePort();
const firstAppArgs = [...(dev ? [resolve('apps/desktop')] : []), `--inspect=127.0.0.1:${inspectorPort}`];
let first;
let reopened;
let main;
let completed = false;
try {
  first = await launchAtPort(exePath, profile, firstAppArgs);
  await waitForRenderedRoot(first.cdp);
  console.log('[smoke cierre activo] Electron listo para preparar el perfil');

  const electron = `process.getBuiltinModule('module').createRequire(process.cwd() + '/shutdown-smoke-inspector.cjs')('electron')`;
  const fs = `process.getBuiltinModule('fs')`;

  await first.cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });
  const project = await first.cdp.invoke('project:createManaged', { name: 'Cierre activo' });
  const provider = await first.cdp.invoke('providers:add', {
    preset: 'custom', label: 'Modelo local lento del smoke', baseUrl: modelBaseUrl,
  });
  const chat = await first.cdp.invoke('chat:create', {
    projectId: project.id,
    agentId: 'agent_builtin_lead',
    mode: 'ask',
    modelSelection: 'explicit',
    modelRef: { providerId: provider.id, name: 'slow-local', locality: 'local' },
  });
  await first.cdp.invoke('settings:set', { key: 'ui.projects.lastProjectId', value: project.id });
  await first.cdp.invoke('settings:set', { key: 'ui.projects.lastChatId', value: chat.id });
  const setupExit = await stop(first);
  first = undefined;
  assertCleanShutdown(setupExit, 'preparación del perfil del cierre activo');

  // Un proceso nuevo reproduce el arranque normal con proyecto/chat restaurados y evita que una
  // recarga artificial conserve listeners IPC del preload asociados al mundo JS anterior.
  first = await launchAtPort(exePath, profile, firstAppArgs);
  await waitForRenderedRoot(first.cdp);
  main = await connectMainInspector(inspectorPort, first.child);
  await main.evaluate(`(() => {
    const electron = ${electron};
    const fs = ${fs};
    const logPath = ${JSON.stringify(dialogLogPath)};
    globalThis.__saurioShutdownResponses = [0, 1];
    globalThis.__saurioShutdownDialogs = [];
    const original = electron.dialog.showMessageBox.bind(electron.dialog);
    electron.dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options?.title === 'Hay trabajo en curso') {
        const response = globalThis.__saurioShutdownResponses.shift();
        if (response === undefined) throw new Error('fixture sin respuesta de cierre');
        globalThis.__saurioShutdownDialogs.push({ title: options.title, buttons: options.buttons, response });
        fs.writeFileSync(logPath, JSON.stringify(globalThis.__saurioShutdownDialogs));
        return { response, checkboxChecked: false };
      }
      if (options?.title === 'No se pudo cerrar de forma segura') {
        globalThis.__saurioShutdownDialogs.push({ title: options.title, buttons: options.buttons, response: 0 });
        fs.writeFileSync(logPath, JSON.stringify(globalThis.__saurioShutdownDialogs));
        return { response: 0, checkboxChecked: false };
      }
      return original(...args);
    };
  })()`);
  console.log('[smoke cierre activo] perfil restaurado e inspector main listo');
  await waitUntil(
    () => first.cdp.evaluate('Boolean(document.querySelector(".context-inspector"))'),
    'el chat restaurado no montó el inspector de contexto',
  );
  await first.cdp.evaluate(`(() => {
    globalThis.__saurioSmokeRuntimeEvents = [];
    globalThis.__saurioSmokeOffRuntime = window.saurio.onEvent('runtime:event', (events) => {
      globalThis.__saurioSmokeRuntimeEvents.push(...events);
    });
  })()`);
  // `.context-inspector` se monta en un hijo; el cableado runtime:event vive en el useEffect del
  // AppLayout padre y corre después de los efectos de hijos. Un usuario real no puede enviar en esa
  // misma microtarea, pero el IPC del smoke sí: cedemos un frame para medir el flujo real.
  await delay(100);
  const prompt = 'Respondé lentamente; este run queda activo para verificar el cierre seguro.';
  const { runId } = await first.cdp.invoke('run:start', { chatId: chat.id, text: prompt, mode: 'ask' });
  await waitUntil(() => serverState.openStreams === 1, 'el provider local no recibió el run');
  console.log('[smoke cierre activo] run local activo');

  try {
    await waitUntil(
      () => first.cdp.evaluate('document.querySelector(".context-inspector")?.textContent.includes("Uso ≈") === true'),
      'el inspector no recibió context.built',
    );
  } catch (error) {
    const inspectorState = await first.cdp.evaluate(`({
      inspector: document.querySelector('.context-inspector')?.textContent,
      chat: document.querySelector('.chat-header')?.innerText,
      bodyHasChunk: document.body.innerText.includes('Trabajando…'),
      contextEvents: globalThis.__saurioSmokeRuntimeEvents
        ?.filter((event) => event.type === 'context.built')
        .map((event) => ({ chatId: event.chatId, hasInspection: Boolean(event.budget?.inspection) })),
    })`);
    throw new Error(`${error.message}; estado renderer: ${JSON.stringify(inspectorState)}`, { cause: error });
  }
  const contextInspection = await first.cdp.evaluate(`(() => {
    const details = document.querySelector('.context-inspector');
    details.open = true;
    const text = details.innerText;
    return { text, open: details.open };
  })()`);
  assert(contextInspection.open, 'el detalle del inspector no se pudo abrir');
  assert(contextInspection.text.includes(project.path), `el inspector no mostró la raíz real: ${contextInspection.text}`);
  assert(contextInspection.text.includes('Instrucciones del agente'), 'el inspector no mostró la fuente system/agente');
  assert(contextInspection.text.includes('Historial'), 'el inspector no mostró la procedencia del historial');
  assert(/Límite (confirmado|provisional): 8[.\s]?192/.test(contextInspection.text),
    `el inspector no mostró el límite efectivo con procedencia: ${contextInspection.text}`);
  mkdirSync(smokeEvidenceDir, { recursive: true });
  const contextScreenshot = await first.cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(contextScreenshotPath, Buffer.from(contextScreenshot.data, 'base64'));
  console.log(`[smoke cierre activo] inspector verificó raíz, fuentes, historial y límite (${contextScreenshotPath})`);

  const windowExpression = `${electron}.BrowserWindow.getAllWindows()[0]`;
  await main.evaluate(`${windowExpression}.close()`); // respuesta 0: Seguir trabajando
  await waitUntil(() => existsSync(dialogLogPath), 'no apareció la primera confirmación');
  await delay(100);
  const firstDialogs = JSON.parse(readFileSync(dialogLogPath, 'utf8'));
  assert(firstDialogs.length === 1 && firstDialogs[0].response === 0, 'la primera confirmación no eligió Seguir trabajando');
  assert(JSON.stringify(firstDialogs[0].buttons) === JSON.stringify(['Seguir trabajando', 'Detener y cerrar']), 'botones de cierre inesperados');
  assert(first.child.exitCode === null, 'Seguir trabajando cerró el proceso');
  assert(await main.evaluate(`${electron}.BrowserWindow.getAllWindows().length`) === 1, 'Seguir trabajando destruyó la ventana');
  assert(serverState.openStreams === 1, 'Seguir trabajando canceló el stream activo');
  const activeRow = readRun(dbPath, runId);
  assert(activeRow && ACTIVE_STATES.has(activeRow.state), `el run dejó de estar activo tras continuar: ${activeRow?.state}`);
  console.log('[smoke cierre activo] Seguir trabajando preservó ventana y run');

  const secondCloseStartedAt = Date.now();
  // El proceso puede completar el cierre antes de que el inspector devuelva el resultado de
  // BrowserWindow.close(); una desconexión acá sólo es éxito si el child efectivamente termina.
  let closeInspectorError;
  try {
    await main.evaluate(`${windowExpression}.close()`); // respuesta 1: Detener y cerrar
  } catch (error) {
    closeInspectorError = error;
  }
  // Igual que `stop()` del helper compartido: los dos debuggers se desconectan antes de esperar el
  // proceso. Mantener el inspector Node abierto puede retener al main aun después de app.quit().
  void main.close().catch(() => {});
  main = undefined;
  void first.cdp.close().catch(() => {});
  await waitUntil(() => first.child.exitCode !== null, 'Electron no cerró después de detener', 15_000);
  if (first.child.exitCode === null && closeInspectorError) throw closeInspectorError;
  const processExitedAt = Date.now();
  console.log('[smoke cierre activo] Electron informó exit');
  const firstExit = { forced: false, exitCode: first.child.exitCode, elapsedMs: processExitedAt - secondCloseStartedAt };
  first = undefined;
  assertCleanShutdown(firstExit, 'cierre con run activo');
  assert(serverState.openStreams === 0, 'el proceso cerró sin abortar el stream del run');
  assert(serverState.lastStreamClosedAt !== undefined && serverState.lastStreamClosedAt <= processExitedAt,
    'el stream se cerró después del proceso principal');
  console.log('[smoke cierre activo] proceso cerrado después de abortar el stream');

  const dialogs = JSON.parse(readFileSync(dialogLogPath, 'utf8'));
  assert(dialogs.length === 2 && dialogs[1].response === 1, 'la segunda confirmación no eligió Detener y cerrar');
  assert(!dialogs.some((entry) => entry.title === 'No se pudo cerrar de forma segura'), 'el cierre mostró un error inesperado');
  const terminalRow = readRun(dbPath, runId);
  assert(terminalRow?.state === 'cancelled' && terminalRow.finishedAt, `estado final no persistido: ${terminalRow?.state}`);
  const terminalEvents = readTerminalEvents(dbPath, runId);
  assert(terminalEvents.some((event) => event.to === 'cancelled'), 'falta evento run.state -> cancelled antes del cierre');
  console.log('[smoke cierre activo] estado y evento cancelled persistidos');

  reopened = await launchAtPort(exePath, profile, dev ? [resolve('apps/desktop')] : []);
  await waitForRenderedRoot(reopened.cdp);
  await reopened.cdp.invoke('project:open', { path: project.path });
  const history = await reopened.cdp.invoke('chat:history', { chatId: chat.id });
  assert(history.messages.some((message) => message.role === 'user' && message.content === prompt),
    'el mensaje del run cancelado no sobrevivió a la reapertura');
  console.log('[smoke cierre activo] historial recuperado al reabrir');
  const reopenExit = await stop(reopened);
  reopened = undefined;
  assertCleanShutdown(reopenExit, 'reapertura después de cierre activo');

  completed = true;
  console.log(JSON.stringify({
    ok: true,
    mode: dev ? 'dev' : 'packaged',
    dialogs,
    run: { id: runId, stateBeforeFirstClose: activeRow.state, persistedState: terminalRow.state },
    streamClosedBeforeProcessExit: true,
    closeElapsedMs: firstExit.elapsedMs,
    historyRestored: true,
    contextInspector: { root: project.path, sourceAndHistoryVisible: true, screenshot: contextScreenshotPath },
    externalCalls: 0,
  }, null, 2));
} finally {
  if (main) void main.close().catch(() => {});
  if (first) await forceStop(first);
  if (reopened) await forceStop(reopened);
  for (const response of openResponses) response.destroy();
  let modelServerClosed = false;
  const closeModelServer = new Promise((done) => modelServer.close(() => {
    modelServerClosed = true;
    done();
  }));
  modelServer.closeAllConnections?.();
  await Promise.race([closeModelServer, delay(2_000)]);
  if (!modelServerClosed) {
    console.error('El servidor local del smoke no cerró en 2 s; se libera el handle sin borrar la evidencia.');
    modelServer.unref();
  }
  const resolvedTemp = resolve(tempRoot);
  if (completed && resolve(resolvedTemp, '..') === resolve(tmpdir()) && basename(resolvedTemp).startsWith('saurio-shutdown-active-023-')) {
    rmSync(resolvedTemp, { recursive: true, force: true });
  } else if (!completed) {
    console.error(`Smoke de cierre activo falló; se preservó el perfil y el log de diálogos: ${resolvedTemp}`);
  }
}
