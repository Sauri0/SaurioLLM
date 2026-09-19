#!/usr/bin/env node
// Aceptación real de la plantilla Revisor. Opera el alta y el chat desde la UI y usa un
// proveedor OpenAI-compatible local: devuelve una write_file nativa adversarial para confirmar
// que no modifica el proyecto sin pasar por la restricción visible de permisos.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { assertCleanShutdown, launchAtPort, stop, waitForRenderedRoot } from './smoke-release-functional.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const ORIGINAL_CONTENT = 'CONTENIDO ORIGINAL: el Revisor no debe modificar este archivo.\n';
const ADVERSARIAL_CONTENT = 'CONTENIDO ALTERADO POR EL PROVEEDOR ADVERSARIAL.\n';
const TARGET_FILE = 'no-tocar.txt';
const PROMPT = 'Revisá el archivo sin modificarlo.';

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke Revisor: ${message}`);
}

function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Smoke Revisor: falta la ruta después de ${flag}`);
  return value;
}

async function waitFor(cdp, expression, description, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await cdp.evaluate(expression)) return;
    await delay(50);
  }
  throw new Error(`Smoke Revisor: timeout esperando ${description}`);
}

async function waitUntil(predicate, description, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Smoke Revisor: timeout esperando ${description}`);
}

async function clickText(cdp, text, rootSelector) {
  const clicked = await cdp.evaluate(`(() => {
    const root = ${rootSelector ? `document.querySelector(${JSON.stringify(rootSelector)})` : 'document'};
    const button = [...(root?.querySelectorAll('button') ?? [])]
      .find((item) => item.textContent?.trim() === ${JSON.stringify(text)} && !item.disabled);
    if (!button) return false;
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`);
  assert(clicked, `no apareció el botón habilitado "${text}"`);
  await delay(100);
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

async function chooseModel(cdp, name) {
  const chosen = await cdp.evaluate(`(() => {
    const option = [...document.querySelectorAll('.saurio-model-select__option')]
      .find((item) => item.querySelector('strong')?.textContent?.trim() === ${JSON.stringify(name)});
    const button = option?.querySelector('.saurio-model-select__option-select');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert(chosen, `no apareció ${name} entre las opciones del selector`);
  await delay(100);
}

async function fill(cdp, selector, value) {
  const focused = await cdp.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
    input.focus();
    return true;
  })()`);
  assert(focused, `no se encontró ${selector}`);
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.call('Input.insertText', { text: value });
  await delay(100);
}

async function forceStop(instance) {
  try { instance.cdp?.socket?.close(); } catch { /* cierre de rescate de un smoke fallido */ }
  if (instance.child?.exitCode === null) instance.child.kill();
  const until = Date.now() + 3_000;
  while (instance.child?.exitCode === null && Date.now() < until) await delay(25);
}

async function capture(cdp, name) {
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outputDir, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  const state = await cdp.evaluate(`({
    text: document.body.innerText,
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map((dialog) => ({
      label: dialog.getAttribute('aria-label'), text: dialog.textContent?.trim(),
      inputs: [...dialog.querySelectorAll('input, textarea, select')].map((field) => ({
        type: field.getAttribute('type'), value: field.value, checked: field.checked,
      })),
    })),
  })`);
  writeFileSync(join(outputDir, `${name}.json`), JSON.stringify(state, null, 2));
  return state;
}

function sse(response, body) {
  response.write(`data: ${JSON.stringify(body)}\n\n`);
}

const requests = [];
const modelServer = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'revisor-local', object: 'model', owned_by: 'saurio-smoke', context_length: 8_192 }],
    }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Smoke local: endpoint no habilitado.' } }));
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: String(error) } }));
      return;
    }
    const callIndex = requests.push(body) - 1;
    response.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
    });
    if (callIndex === 0) {
      // Esta tool no está entre las tools publicadas a Revisor; el servidor la fuerza igual.
      sse(response, {
        id: 'chatcmpl-reviewer-adversarial', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1_000),
        model: 'revisor-local', choices: [{ index: 0, delta: {
          role: 'assistant', content: null, tool_calls: [{
            index: 0, id: 'call_reviewer_adversarial_write', type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: TARGET_FILE, content: ADVERSARIAL_CONTENT }) },
          }],
        }, finish_reason: null }],
      });
      sse(response, {
        id: 'chatcmpl-reviewer-adversarial', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1_000),
        model: 'revisor-local', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      });
    } else {
      sse(response, {
        id: 'chatcmpl-reviewer-denied', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1_000),
        model: 'revisor-local', choices: [{ index: 0, delta: {
          role: 'assistant', content: 'La modificación fue rechazada; el archivo se conserva intacto.',
        }, finish_reason: null }],
      });
      sse(response, {
        id: 'chatcmpl-reviewer-denied', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1_000),
        model: 'revisor-local', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 22, completion_tokens: 9 },
      });
    }
    response.end('data: [DONE]\n\n');
  });
});

await new Promise((done, reject) => {
  modelServer.once('error', reject);
  modelServer.listen(0, '127.0.0.1', done);
});
const address = modelServer.address();
if (!address || typeof address === 'string') throw new Error('Smoke Revisor: el servidor local no obtuvo un puerto.');
const modelBaseUrl = `http://127.0.0.1:${address.port}`;

const dev = process.argv.includes('--dev');
const exePath = resolve(dev
  ? 'node_modules/electron/dist/electron.exe'
  : (cliValue('--exe') ?? 'apps/desktop/release/win-unpacked/SaurioLLM.exe'));
assert(existsSync(exePath), `no existe el ejecutable: ${exePath}`);

const tempRoot = mkdtempSync(join(tmpdir(), 'saurio-reviewer-023-'));
const profile = join(tempRoot, 'perfil aislado');
const projectPath = join(tempRoot, 'proyecto revisado');
const targetPath = join(projectPath, TARGET_FILE);
const outputDir = resolve('smoke/reviewer-023');
const screenshotPath = join(outputDir, 'revisor-denied.png');
const unexpectedPermissionScreenshotPath = join(outputDir, 'revisor-permission-unexpected.png');
let app;
let completed = false;
try {
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(targetPath, ORIGINAL_CONTENT, 'utf8');
  mkdirSync(outputDir, { recursive: true });

  app = await launchAtPort(exePath, profile, dev ? [resolve('apps/desktop')] : []);
  const { cdp } = app;
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForRenderedRoot(cdp);
  await cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });
  const project = await cdp.invoke('project:open', { path: projectPath });
  const provider = await cdp.invoke('providers:add', {
    preset: 'custom', label: 'Revisor local determinista', baseUrl: modelBaseUrl,
  });
  assert(provider.locality === 'local', 'el servidor loopback no quedó clasificado como local');
  const availableModels = await cdp.invoke('models:list', { refresh: true });
  assert(availableModels.some((model) => model.ref.providerId === provider.id && model.ref.name === 'revisor-local'),
    'el catálogo local no expuso revisor-local antes de abrir el formulario');
  await cdp.invoke('settings:set', { key: 'ui.projects.lastProjectId', value: project.id });
  await cdp.call('Page.reload', { ignoreCache: true });
  await waitForRenderedRoot(cdp);
  // La carga del inventario pertenece a la vista Chats. Recorrerla antes de abrir Agentes es un
  // flujo de UI real y evita que la selección fija dependa de una recomendación automática.
  await clickText(cdp, 'Chats');
  await waitFor(cdp,
    `document.querySelector('button[title="Modelo del próximo chat"]')?.textContent?.includes('revisor-local') === true`,
    'el catálogo local cargado en el selector de Chats');
  await waitFor(cdp,
    `document.querySelector('button[title="Agentes (Ctrl+4)"]') instanceof HTMLButtonElement`,
    'la navegación Agentes');
  await clickText(cdp, 'Agentes');
  await waitFor(cdp, `document.querySelector('.agents-panel') !== null`, 'la pantalla Mis agentes');
  await clickText(cdp, '+ Nuevo agente', '.agents-panel');
  await waitFor(cdp, `document.querySelector('[role="dialog"][aria-label="Nuevo agente"]') !== null`, 'el modal de agente nuevo');
  await setSelect(cdp, '[role="dialog"] .agent-editor__field select', 'reviewer');
  await waitFor(cdp,
    `document.querySelector('[role="dialog"] .agent-editor__field select')?.value === 'reviewer'`,
    'la selección de la plantilla Revisor');
  await fill(cdp, '[role="dialog"] input[type="text"]', 'Revisor de smoke');
  const fixedMode = await cdp.evaluate(`(() => {
    const label = [...document.querySelectorAll('[role="dialog"] label')]
      .find((item) => item.textContent?.trim() === 'Fijo');
    const input = label?.querySelector('input[type="radio"]');
    if (!(input instanceof HTMLInputElement)) return false;
    input.click();
    return true;
  })()`);
  assert(fixedMode, 'no se pudo elegir modo Fijo en el formulario del Revisor');
  await waitFor(cdp,
    `document.querySelector('button[title="Modelo de este agente"]') instanceof HTMLButtonElement`,
    'el selector de modelo fijo del Revisor');
  await cdp.evaluate(`document.querySelector('button[title="Modelo de este agente"]')?.click()`);
  await waitFor(cdp, `document.querySelector('.saurio-model-select__popover') !== null`, 'el popover de modelos');
  await chooseModel(cdp, 'revisor-local');
  await waitFor(cdp,
    `document.querySelector('button[title="Modelo de este agente"]')?.textContent?.includes('revisor-local') === true`,
    'la selección fija revisor-local');
  await capture(cdp, 'revisor-template-selected');
  await clickText(cdp, 'Crear y abrir chat', '[role="dialog"]');
  await waitUntil(async () => {
    const chatOpen = await cdp.evaluate(`document.querySelector('textarea[aria-label="Mensaje para el agente"]') instanceof HTMLTextAreaElement`);
    if (chatOpen) return true;
    const modalError = await cdp.evaluate(`document.querySelector('[role="dialog"] .saurio-banner.danger') !== null`);
    return modalError;
  }, 'el chat del Revisor o un error visible al abrirlo');
  const chatOpened = await cdp.evaluate(`document.querySelector('textarea[aria-label="Mensaje para el agente"]') instanceof HTMLTextAreaElement`);
  if (!chatOpened) {
    const state = await capture(cdp, 'revisor-open-chat-failed');
    throw new Error(`no se abrió el chat del Revisor desde la UI: ${state.dialogs?.[0]?.text ?? 'sin detalle visible'}`);
  }
  assert(await cdp.evaluate(`document.querySelector('.chat-input__model')?.textContent?.includes('revisor-local') === true`),
    'el chat creado por la UI no conservó la selección fija revisor-local');
  const reviewerProfiles = await cdp.invoke('agents:list', { projectId: project.id, includeArchived: true });
  const reviewer = reviewerProfiles.find((agent) => agent.name === 'Revisor de smoke');
  assert(reviewer?.role === 'reviewer', 'la UI no creó el perfil con el rol Revisor');
  assert(reviewer?.modelMode === 'fixed' && reviewer.model?.providerId === provider.id && reviewer.model.name === 'revisor-local',
    'la UI no guardó la selección fija local del Revisor');
  assert(Array.isArray(reviewer?.allowedTools) && !reviewer.allowedTools.includes('write_file'),
    'la plantilla Revisor guardó write_file entre sus herramientas permitidas');

  await cdp.evaluate(`window.__reviewEvents = []; window.saurio.onEvent('runtime:event', events => window.__reviewEvents.push(...events));`);
  await fill(cdp, 'textarea[aria-label="Mensaje para el agente"]', PROMPT);
  await clickText(cdp, 'Enviar', '.chat-input');
  await waitUntil(() => requests.length >= 1, 'el request adversarial al proveedor local');
  assert(requests.length === 1, `se esperaban 1 requests antes de denegar; llegaron ${requests.length}`);
  const firstRequest = requests[0];
  assert(firstRequest?.model === 'revisor-local', `el Revisor no resolvió el modelo local configurado: ${firstRequest?.model}`);
  const advertisedTools = Array.isArray(firstRequest?.tools) ? firstRequest.tools.map((tool) => tool?.function?.name) : [];
  assert(!advertisedTools.includes('write_file'), 'la plantilla Revisor anunció write_file al proveedor');
  await waitUntil(async () => await cdp.evaluate(`window.__reviewEvents.some(e => e.type === 'run.error')`) || await cdp.evaluate(
    `document.querySelector('[role="alertdialog"][aria-label="Solicitud de permiso"]')?.textContent?.includes(${JSON.stringify(TARGET_FILE)}) === true`,
  ), 'el rechazo de la tool no permitida o su tarjeta de permiso');
  const permissionVisible = await cdp.evaluate(
    `document.querySelector('[role="alertdialog"][aria-label="Solicitud de permiso"]')?.textContent?.includes(${JSON.stringify(TARGET_FILE)}) === true`,
  );
  assert(readFileSync(targetPath, 'utf8') === ORIGINAL_CONTENT, 'el archivo fue modificado antes de resolver la restricción');
  if (permissionVisible) {
    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(unexpectedPermissionScreenshotPath, Buffer.from(screenshot.data, 'base64'));
    const uiState = await cdp.evaluate(`({
      text: document.body.innerText,
      permissionCards: document.querySelectorAll('[role="alertdialog"]').length,
      permissionText: document.querySelector('[role="alertdialog"]')?.textContent?.trim(),
    })`);
    writeFileSync(join(outputDir, 'revisor-permission-unexpected.json'), JSON.stringify(uiState, null, 2));
    throw new Error('BUG: write_file no anunciada a la plantilla Revisor llegó a una solicitud de permiso aprobable; debe rechazarse por allowlist antes de pedir aprobación.');
  }
  await waitFor(cdp, `window.__reviewEvents.some(e => e.type === 'run.state' && e.to === 'failed')`, 'el cierre del run rechazado');
  const rejection = await cdp.evaluate(`window.__reviewEvents.find(e => e.type === 'run.error')?.error`);
  assert(rejection?.message?.includes('write_file'), 'el error no identifica la herramienta rechazada');
  await capture(cdp, 'revisor-runtime-rejected');
  console.log(JSON.stringify({ rejection }));
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(rejection.message)})`, 'el motivo del rechazo visible');
  assert(requests.length === 1, `la herramienta prohibida causó más solicitudes (${requests.length})`);
  assert(readFileSync(targetPath, 'utf8') === ORIGINAL_CONTENT, 'el archivo fue modificado después del rechazo');
  const runtimeEvents = await cdp.evaluate('window.__reviewEvents');
  assert(!runtimeEvents.some(e => ['tool.permission', 'tool.registered'].includes(e.type)), 'se pidió permiso o registró una herramienta prohibida');

  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const uiState = await cdp.evaluate(`({
    text: document.body.innerText,
    permissionCards: document.querySelectorAll('[role="alertdialog"]').length,
    toolCards: [...document.querySelectorAll('.tool-call-card')].map((card) => card.textContent?.trim()),
  })`);
  writeFileSync(join(outputDir, 'revisor-denied.json'), JSON.stringify(uiState, null, 2));

  const shutdown = await stop(app);
  app = undefined;
  assertCleanShutdown(shutdown, 'cierre tras la denegación del Revisor');
  app = await launchAtPort(exePath, profile, dev ? [resolve('apps/desktop')] : []);
  await waitForRenderedRoot(app.cdp);
  await waitFor(app.cdp, `document.querySelector('[role="alert"].saurio-banner.danger')?.textContent.includes(${JSON.stringify(rejection.message)}) === true`,
    'el rechazo persistido visible después de reiniciar');
  assert(requests.length === 1, 'reiniciar volvió a ejecutar el pedido rechazado');
  assert(readFileSync(targetPath, 'utf8') === ORIGINAL_CONTENT, 'el reinicio modificó el archivo');
  assertCleanShutdown(await stop(app), 'cierre tras restaurar el error');
  app = undefined;
  completed = true;
  console.log(JSON.stringify({
    ok: true,
    mode: dev ? 'dev' : 'packaged',
    provider: provider.id,
    projectPath,
    chatRequests: requests.length,
    advertisedTools,
    adversarialTool: 'write_file',
    permissionWasVisible: false,
    denialWasVisible: true,
    denialSurvivedRestart: true,
    fileIntact: readFileSync(targetPath, 'utf8') === ORIGINAL_CONTENT,
    screenshot: screenshotPath,
    externalCalls: 0,
  }, null, 2));
} finally {
  if (app) await forceStop(app);
  await new Promise((done) => modelServer.close(done));
  const resolvedTemp = resolve(tempRoot);
  if (completed && resolve(resolvedTemp, '..') === resolve(tmpdir()) && basename(resolvedTemp).startsWith('saurio-reviewer-023-')) {
    rmSync(resolvedTemp, { recursive: true, force: true });
  } else if (!completed) {
    console.error(`Smoke Revisor falló; se preservó el perfil y el archivo para diagnóstico: ${resolvedTemp}`);
  }
}
