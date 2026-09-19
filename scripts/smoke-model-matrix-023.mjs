#!/usr/bin/env node
// Matriz empaquetada de modelos: configura por UI un Ollama attach loopback y Anthropic (NUBE)
// contra el mismo servidor determinista. Comprueba selección/persistencia/generación de ambos y,
// al retirar el modelo cloud del catálogo, el error visible sin fallback al local. No usa Internet,
// motores reales ni claves reales.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { assertCleanShutdown, launchAtPort, stop, waitForRenderedRoot } from './smoke-release-functional.mjs';

const LOCAL_MODEL = 'local-matrix-fixture';
const CLOUD_MODEL = 'claude-matrix-fixture';
const LOCAL_RESPONSE = 'MATRIX_LOCAL_OK';
const CLOUD_RESPONSE = 'MATRIX_CLOUD_OK';
const REMOVED_ERROR = `El modelo ${CLOUD_MODEL} fue retirado del catálogo de prueba (404).`;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const stage = (name) => console.log(`[model-matrix ${new Date().toISOString()}] ${name}`);

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke model matrix: ${message}`);
}

async function withTimeout(promise, timeoutMs, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Smoke model matrix: CDP no respondió en ${timeoutMs} ms durante ${description}`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    if (await withTimeout(Promise.resolve().then(predicate), Math.min(5_000, remaining), description)) return;
    await delay(75);
  }
  throw new Error(`Smoke model matrix: timeout esperando ${description}`);
}

async function waitFor(cdp, expression, description, timeoutMs = 30_000) {
  await waitUntil(() => cdp.evaluate(expression), description, timeoutMs);
}

async function clickText(cdp, text, rootSelector) {
  const clicked = await withTimeout(cdp.evaluate(`(() => {
    const root = ${rootSelector ? `document.querySelector(${JSON.stringify(rootSelector)})` : 'document'};
    const button = [...(root?.querySelectorAll('button') ?? [])]
      .find((item) => item.textContent?.trim() === ${JSON.stringify(text)} && !item.disabled);
    if (!button) return false;
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`), 5_000, `clic ${JSON.stringify(text)}`);
  assert(clicked, `no se encontró el botón habilitado ${JSON.stringify(text)}`);
  await delay(100);
}

async function click(cdp, selector) {
  const rect = await withTimeout(cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement) || element.hasAttribute('disabled')) return undefined;
    element.scrollIntoView({ block: 'center' });
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`), 5_000, `ubicar clic ${selector}`);
  assert(rect, `no se encontró un elemento clickeable para ${selector}`);
  await withTimeout(cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 }), 5_000, `presionar ${selector}`);
  await withTimeout(cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 }), 5_000, `soltar ${selector}`);
  await delay(100);
}

async function fill(cdp, selector, value) {
  const focused = await cdp.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return false;
    field.focus();
    return true;
  })()`);
  assert(focused, `no se encontró ${selector}`);
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.call('Input.insertText', { text: value });
  await delay(80);
}

async function setSelect(cdp, selector, value) {
  const changed = await cdp.evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    if (!(select instanceof HTMLSelectElement)) return false;
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert(changed, `no se pudo elegir ${value} en ${selector}`);
  await delay(100);
}

async function fillProviderField(cdp, label, value) {
  const selector = await cdp.evaluate(`(() => {
    const form = document.querySelector('.saurio-providers-form');
    const field = [...(form?.querySelectorAll('label') ?? [])]
      .find((item) => item.textContent?.trim().startsWith(${JSON.stringify(label)}))?.querySelector('input');
    if (!(field instanceof HTMLInputElement)) return undefined;
    const id = 'matrix-' + ${JSON.stringify(label)}.replace(/[^a-z]/gi, '').toLowerCase();
    field.setAttribute('data-matrix-field', id);
    return '[data-matrix-field="' + id + '"]';
  })()`);
  assert(selector, `no se encontró el campo ${label} del formulario de proveedores`);
  await fill(cdp, selector, value);
  await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.removeAttribute('data-matrix-field')`);
}

async function chooseModel(cdp, modelName) {
  const selected = await cdp.evaluate(`(() => {
    const option = [...document.querySelectorAll('.saurio-model-select__option')]
      .find((item) => item.querySelector('strong')?.textContent?.trim() === ${JSON.stringify(modelName)});
    const button = option?.querySelector('.saurio-model-select__option-select');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert(selected, `no apareció ${modelName} como opción seleccionable`);
  await delay(150);
}

async function waitForPersistedSelection(cdp, projectId, modelName, description, chatId) {
  await waitUntil(async () => {
    const chats = await cdp.invoke('chat:list', { projectId });
    return chats.some((chat) => (chatId === undefined || chat.id === chatId)
      && chat.modelSelection === 'explicit' && chat.modelRef?.name === modelName);
  }, description);
}

async function capture(cdp, outputDir, name) {
  const screenshot = await withTimeout(cdp.call('Page.captureScreenshot', { format: 'png' }), 5_000, `captura ${name}`);
  writeFileSync(join(outputDir, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  const state = await withTimeout(cdp.evaluate(`({
    text: document.body.innerText,
    titles: [...document.querySelectorAll('.saurio-row__title')].map((node) => node.textContent?.trim()),
    model: document.querySelector('.chat-input__model')?.textContent?.trim(),
    alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent?.trim()),
  })`), 5_000, `estado de captura ${name}`);
  writeFileSync(join(outputDir, `${name}.json`), JSON.stringify(state, null, 2));
}

async function forceStop(instance) {
  try { instance.cdp?.socket?.close(); } catch { /* rescate de un smoke fallido */ }
  if (instance.child?.exitCode === null) instance.child.kill();
  const deadline = Date.now() + 3_000;
  while (instance.child?.exitCode === null && Date.now() < deadline) await delay(25);
}

async function closeFixtureServer(server) {
  server.closeAllConnections?.();
  await withTimeout(new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  }), 5_000, 'cierre del fixture HTTP');
}

function sse(response, type, payload) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

let cloudListed = true;
const requests = { local: [], cloud: [], catalog: { local: 0, cloud: 0 } };
const server = createServer((request, response) => {
  const sendJson = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (request.method === 'GET' && request.url === '/api/version') return sendJson(200, { version: 'matrix-fixture' });
  if (request.method === 'GET' && request.url === '/api/ps') return sendJson(200, { models: [] });
  if (request.method === 'GET' && request.url === '/api/tags') {
    requests.catalog.local += 1;
    return sendJson(200, { models: [{
      name: LOCAL_MODEL, model: LOCAL_MODEL, size: 12_345_678, digest: 'local-matrix-digest',
      details: { family: 'matrix', parameter_size: '1B', quantization_level: 'Q4_0', context_length: 8192 }, capabilities: ['completion'],
    }] });
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    requests.catalog.cloud += 1;
    return sendJson(200, cloudListed ? { data: [{
      type: 'model', id: CLOUD_MODEL, display_name: 'Cloud matrix fixture', max_input_tokens: 8192,
      capabilities: { thinking: { supported: false }, image_input: { supported: false } },
    }], has_more: false, first_id: CLOUD_MODEL, last_id: CLOUD_MODEL } : { data: [], has_more: false });
  }
  if (request.method === 'POST' && request.url === '/api/chat') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.local.push(body);
      if (body.model !== LOCAL_MODEL) return sendJson(404, { error: `modelo local inesperado: ${body.model}` });
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(`${JSON.stringify({ model: LOCAL_MODEL, message: { role: 'assistant', content: LOCAL_RESPONSE }, done: false })}\n`);
      response.end(`${JSON.stringify({ model: LOCAL_MODEL, done: true, done_reason: 'stop', prompt_eval_count: 8, eval_count: 3 })}\n`);
    });
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/messages') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.cloud.push(body);
      if (!cloudListed || body.model !== CLOUD_MODEL) {
        return sendJson(404, { type: 'error', error: { type: 'not_found_error', message: REMOVED_ERROR } });
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      sse(response, 'message_start', { type: 'message_start', message: {
        id: 'msg_matrix', type: 'message', role: 'assistant', content: [], model: CLOUD_MODEL, stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      } });
      sse(response, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse(response, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: CLOUD_RESPONSE } });
      sse(response, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sse(response, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
      sse(response, 'message_stop', { type: 'message_stop' });
      response.end();
    });
    return;
  }
  return sendJson(404, { error: 'Endpoint de smoke no habilitado.' });
});

await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Smoke model matrix: el servidor local no obtuvo puerto.');
const baseUrl = `http://127.0.0.1:${address.port}`;
const exePath = resolve('apps/desktop/release/win-unpacked/SaurioLLM.exe');
assert(existsSync(exePath), `no existe el ejecutable empaquetado: ${exePath}`);
const installerPath = resolve('apps/desktop/release/SaurioLLM-Setup-0.2.3.exe');
assert(existsSync(installerPath), `no existe el instalador integrado: ${installerPath}`);
const installerHash = createHash('sha256').update(readFileSync(installerPath)).digest('hex');
const expectedInstallerHash = process.env.SAURIO_SMOKE_INSTALLER_SHA256?.trim().toLowerCase();
if (expectedInstallerHash) assert(installerHash === expectedInstallerHash, `SHA-256 del instalador inesperado: ${installerHash}`);
const outputDir = resolve('smoke/model-matrix-023', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const tempRoot = mkdtempSync(join(tmpdir(), 'saurio-model-matrix-023-'));
const profile = join(tempRoot, 'perfil aislado');
let app;
let completed = false;

try {
  mkdirSync(outputDir, { recursive: true });
  stage('inicio: paquete verificado, perfil aislado y fixture loopback listos');
  app = await launchAtPort(exePath, profile);
  const { cdp } = app;
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForRenderedRoot(cdp);
  await waitFor(cdp, 'document.querySelector(\'[role="dialog"][aria-label="Asistente de primer arranque"]\') !== null', 'el asistente de primer arranque');
  await clickText(cdp, 'Tengo una clave de API', '[role="dialog"]');
  await waitFor(cdp, 'document.querySelector(".saurio-settings-nav") !== null', 'Ajustes tras elegir la ruta API del asistente');
  await clickText(cdp, 'APIs y costos', '.saurio-settings-nav');
  await waitFor(cdp, 'document.querySelector(".saurio-providers-form") !== null', 'el formulario de proveedores');
  await setSelect(cdp, '.saurio-providers-form select', 'ollama');
  await fillProviderField(cdp, 'Nombre', 'Ollama local matrix');
  await fillProviderField(cdp, 'Base URL', baseUrl);
  await clickText(cdp, 'Agregar proveedor', '.saurio-providers-form');
  await waitFor(cdp, `document.body.innerText.includes('Ollama local matrix')`, 'el proveedor Ollama local guardado por UI');

  await setSelect(cdp, '.saurio-providers-form select', 'anthropic');
  await fillProviderField(cdp, 'Nombre', 'Anthropic cloud matrix');
  await fillProviderField(cdp, 'Base URL', baseUrl);
  await fillProviderField(cdp, 'Clave de API', 'matrix-loopback-key');
  await clickText(cdp, 'Agregar proveedor', '.saurio-providers-form');
  await waitFor(cdp, `document.body.innerText.includes('Anthropic cloud matrix')`, 'el proveedor Anthropic cloud guardado por UI');
  stage('proveedores: Ollama local attach y Anthropic cloud configurados por UI');
  await capture(cdp, outputDir, '01-proveedores-configurados');

  const providers = await cdp.invoke('providers:list', undefined);
  const localProvider = providers.find((provider) => provider.label === 'Ollama local matrix');
  const cloudProvider = providers.find((provider) => provider.label === 'Anthropic cloud matrix');
  assert(localProvider?.locality === 'local', `Ollama attach no quedó local: ${localProvider?.locality}`);
  assert(cloudProvider?.locality === 'cloud', `Anthropic no quedó cloud: ${cloudProvider?.locality}`);

  await clickText(cdp, 'Chats');
  await waitFor(cdp, 'document.querySelector(".saurio-sidebar") !== null', 'la vista Chats');
  await clickText(cdp, 'Nuevo proyecto', '.saurio-sidebar');
  await waitFor(cdp, 'document.querySelector(".saurio-text-dialog")?.textContent?.includes("Nuevo proyecto") === true', 'el diálogo Nuevo proyecto');
  await fill(cdp, '.saurio-text-dialog input', 'Matriz de modelos');
  await clickText(cdp, 'Crear proyecto', '.saurio-text-dialog');
  await waitFor(cdp, 'document.querySelector("button[title=\\"Modelo del próximo chat\\"]") instanceof HTMLButtonElement', 'el selector del próximo chat');
  const project = (await cdp.invoke('project:recent', undefined)).find((item) => item.name === 'Matriz de modelos');
  assert(project, 'el proyecto creado por UI no apareció en recientes');

  await click(cdp, 'button[title="Modelo del próximo chat"]');
  await waitFor(cdp, 'document.querySelector(".saurio-model-select__popover") !== null', 'el selector local');
  await chooseModel(cdp, LOCAL_MODEL);
  await clickText(cdp, '+ Nuevo chat', '.saurio-sidebar');
  await waitFor(cdp, 'document.querySelector("textarea[aria-label=\\"Mensaje para el agente\\"]") instanceof HTMLTextAreaElement', 'el compositor local');
  await waitForPersistedSelection(cdp, project.id, LOCAL_MODEL, 'la selección local explícita aplicada desde la UI');
  const localSelectionPersisted = true;
  await fill(cdp, 'textarea[aria-label="Mensaje para el agente"]', 'Respondé MATRIX_LOCAL_OK.');
  await clickText(cdp, 'Enviar', '.chat-input');
  stage('local: selección explícita persistida; esperando respuesta loopback');
  await waitUntil(() => requests.local.length === 1, 'la generación del proveedor local');
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(LOCAL_RESPONSE)})`, 'la respuesta local visible');
  assert(requests.local[0]?.model === LOCAL_MODEL, `la generación local recibió ${requests.local[0]?.model}`);
  stage('local: respuesta y modelo seleccionado verificados');
  await capture(cdp, outputDir, '02-chat-local');
  const localChat = (await cdp.invoke('chat:list', { projectId: project.id }))
    .find((chat) => chat.modelSelection === 'explicit' && chat.modelRef?.name === LOCAL_MODEL);
  assert(localChat, 'no se encontró el chat principal local para la selección cloud UI');

  // Electron 44 abre window.confirm como MessageBox nativo, inaccesible a CDP en este entorno.
  // Se siembra sólo el consentimiento del proyecto mediante IPC real y un chat auxiliar sin run;
  // la selección que importa para la matriz sigue siendo el botón UI del chat principal.
  const consentChat = await cdp.invoke('chat:create', {
    projectId: project.id, agentId: 'agent_builtin_lead', mode: 'agent', modelSelection: 'explicit',
    modelRef: { providerId: cloudProvider.id, name: CLOUD_MODEL, locality: 'cloud' }, confirmed: true,
  });
  assert(consentChat.modelRef?.name === CLOUD_MODEL, 'el chat auxiliar no persistió el consentimiento cloud');
  stage('cloud: consentimiento del proyecto sembrado por IPC en chat auxiliar; sin inferencia');

  // El selector de la barra lateral deja de ser estable al crear el primer chat. El Centro de
  // modelos ofrece la acción UI equivalente sobre el chat abierto y su fila fue observada en DOM.
  await clickText(cdp, 'Modelos');
  stage('cloud: navegó al Centro de modelos para usar el modelo cloud en el chat abierto');
  await waitFor(cdp, 'document.querySelector(".saurio-panel__title")?.textContent?.includes("Centro de modelos") === true', 'el Centro de modelos para seleccionar cloud');
  await waitFor(cdp, `[...document.querySelectorAll('.saurio-row__title')].some((title) => title.textContent?.trim() === ${JSON.stringify(CLOUD_MODEL)})`, 'la fila cloud disponible en el Centro de modelos');
  const useCloud = await withTimeout(cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.saurio-row')].find((item) =>
      item.querySelector('.saurio-row__title')?.textContent?.trim() === ${JSON.stringify(CLOUD_MODEL)});
    const button = [...(row?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === 'Usar en este chat');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`), 5_000, 'usar en este chat cloud');
  assert(useCloud, 'la fila cloud no ofreció un botón habilitado Usar en este chat');
  stage('cloud: botón UI Usar en este chat accionado con consentimiento ya registrado');
  await waitForPersistedSelection(cdp, project.id, CLOUD_MODEL, 'la selección cloud explícita aplicada desde la UI', localChat.id);
  await clickText(cdp, 'Chats');
  await waitFor(cdp, 'document.querySelector("textarea[aria-label=\\"Mensaje para el agente\\"]") instanceof HTMLTextAreaElement', 'el compositor con modelo cloud');
  await fill(cdp, 'textarea[aria-label="Mensaje para el agente"]', 'Respondé MATRIX_CLOUD_OK.');
  await clickText(cdp, 'Enviar', '.chat-input');
  stage('cloud: selección explícita persistida; esperando respuesta loopback');
  await waitUntil(() => requests.cloud.length === 1, 'la generación del proveedor cloud sintético');
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(CLOUD_RESPONSE)})`, 'la respuesta cloud visible');
  assert(requests.cloud[0]?.model === CLOUD_MODEL, `la generación cloud recibió ${requests.cloud[0]?.model}`);
  stage('cloud: respuesta y modelo seleccionado verificados');
  const chats = await cdp.invoke('chat:list', { projectId: project.id });
  assert(localSelectionPersisted, 'no persistió la selección local explícita antes de cambiar al cloud');
  const cloudChat = chats.find((chat) => chat.id === localChat.id && chat.modelRef?.name === CLOUD_MODEL && chat.modelSelection === 'explicit');
  assert(cloudChat, 'no persistió la selección cloud explícita');
  await capture(cdp, outputDir, '03-chat-cloud');

  await cdp.call('Page.reload', { ignoreCache: true });
  await waitForRenderedRoot(cdp);
  await waitForPersistedSelection(cdp, project.id, CLOUD_MODEL, 'la selección cloud restaurada tras recargar', localChat.id);

  cloudListed = false;
  stage('retiro: fixture deja de listar el modelo cloud; esperando Actualizar habilitado');
  const cloudCatalogBeforeRefresh = requests.catalog.cloud;
  await clickText(cdp, 'Modelos');
  await waitFor(cdp, 'document.querySelector(".saurio-panel__title")?.textContent?.includes("Centro de modelos") === true', 'el Centro de modelos');
  const refreshEnableStartedAt = Date.now();
  await waitFor(cdp, `(() => {
    const button = [...document.querySelectorAll('.saurio-panel__header button')]
      .find((item) => item.textContent?.trim() === 'Actualizar');
    return button instanceof HTMLButtonElement && !button.disabled;
  })()`, 'el botón Actualizar habilitado tras la carga inicial', 60_000);
  const refreshEnableMs = Date.now() - refreshEnableStartedAt;
  await clickText(cdp, 'Actualizar', '.saurio-panel__header');
  stage(`retiro: Actualizar habilitado en ${refreshEnableMs} ms; recarga UI iniciada`);
  await waitUntil(() => requests.catalog.cloud > cloudCatalogBeforeRefresh, 'la recarga UI del catálogo cloud retirado');
  await waitFor(cdp, `![...document.querySelectorAll('.saurio-row__title')].some((title) => title.textContent?.trim() === ${JSON.stringify(CLOUD_MODEL)})`, 'la ausencia del modelo retirado en la lista UI');
  const refreshedModels = await cdp.invoke('models:list', { refresh: false });
  assert(refreshedModels.some((model) => model.ref.name === LOCAL_MODEL), 'la actualización UI perdió el modelo local');
  assert(!refreshedModels.some((model) => model.ref.name === CLOUD_MODEL), 'la actualización UI conservó el modelo cloud retirado');
  stage('retiro: catálogo UI ya no muestra el modelo cloud');
  await capture(cdp, outputDir, '04-catalogo-retirado');

  await clickText(cdp, 'Chats');
  await waitForPersistedSelection(cdp, project.id, CLOUD_MODEL, 'el chat conserva la identidad del modelo retirado', localChat.id);
  const localCallsBeforeFailure = requests.local.length;
  const cloudCallsBeforeFailure = requests.cloud.length;
  await fill(cdp, 'textarea[aria-label="Mensaje para el agente"]', 'Este pedido debe informar el modelo retirado.');
  await clickText(cdp, 'Enviar', '.chat-input');
  stage('404: envío explícito al modelo retirado; esperando error visible sin fallback');
  await waitUntil(() => requests.cloud.length === cloudCallsBeforeFailure + 1, 'el intento explícito al modelo cloud retirado');
  await waitFor(cdp, `document.querySelector('[role="alert"]')?.textContent?.includes(${JSON.stringify(REMOVED_ERROR)}) === true`, 'el error visible del modelo retirado');
  assert(requests.cloud.at(-1)?.model === CLOUD_MODEL, 'el intento tras retirar modelo no conservó la selección explícita');
  assert(requests.local.length === localCallsBeforeFailure, 'hubo fallback silencioso al modelo local tras el 404 cloud');
  stage('404: error visible y ausencia de fallback local verificados');
  await capture(cdp, outputDir, '05-error-sin-fallback');

  const result = {
    ok: true, mode: 'packaged', installerSha256: installerHash, expectedInstallerSha256: expectedInstallerHash, server: 'loopback deterministic fixture',
    providers: { local: { id: localProvider.id, locality: localProvider.locality, model: LOCAL_MODEL }, cloud: { id: cloudProvider.id, locality: cloudProvider.locality, model: CLOUD_MODEL } },
    generated: { localRequests: requests.local.length, cloudRequestsBeforeRemoval: cloudCallsBeforeFailure, cloud404Requests: requests.cloud.length - cloudCallsBeforeFailure },
    catalog: { localReads: requests.catalog.local, cloudReads: requests.catalog.cloud, cloudRemovedVisible: false, refreshEnableMs },
    persistedExplicitSelections: [LOCAL_MODEL, CLOUD_MODEL], cloudConsentSeededViaIpc: true,
    cloudNativeConfirmUiExercised: false, fallbackLocalAfterCloud404: false, externalCalls: 0,
  };
  const finalInstallerHash = createHash('sha256').update(readFileSync(installerPath)).digest('hex');
  assert(finalInstallerHash === installerHash, `el instalador cambió durante el smoke: ${installerHash} -> ${finalInstallerHash}`);
  writeFileSync(join(outputDir, 'resultado.json'), JSON.stringify(result, null, 2));
  const shutdown = await stop(app);
  app = undefined;
  assertCleanShutdown(shutdown, 'cierre del smoke de matriz de modelos');
  completed = true;
  stage('finalizado: matriz completa aprobada');
  console.log(JSON.stringify({ ...result, artifacts: outputDir }, null, 2));
} catch (error) {
  if (app?.cdp) await capture(app.cdp, outputDir, 'fallo').catch(() => undefined);
  throw error;
} finally {
  if (app) await forceStop(app);
  try {
    await closeFixtureServer(server);
  } catch (error) {
    console.error(`Smoke model matrix: el fixture HTTP no cerró limpio: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (completed) {
    const resolved = resolve(tempRoot);
    if (resolve(resolved, '..') === resolve(tmpdir()) && basename(resolved).startsWith('saurio-model-matrix-023-')) rmSync(resolved, { recursive: true, force: true });
  } else {
    console.error(`Smoke model matrix falló; se preservó el perfil aislado: ${resolve(tempRoot)}`);
  }
}
