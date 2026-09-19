#!/usr/bin/env node
// Aceptación de primer arranque por API: desde un perfil vacío recorre el asistente, agrega un
// proveedor OpenAI-compatible loopback por UI, crea el primer proyecto/chat con modelo explícito
// y envía un mensaje. No usa Ollama, Internet ni APIs pagas.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { assertCleanShutdown, launchAtPort, stop, waitForRenderedRoot } from './smoke-release-functional.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const MODEL_NAME = 'api-onboarding-local';
const PROVIDER_LABEL = 'API local del primer arranque';
const PROMPT = 'Respondé solamente: primer chat por API listo.';
const RESPONSE = 'primer chat por API listo.';

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke onboarding API: ${message}`);
}

async function waitFor(cdp, expression, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await delay(50);
  }
  throw new Error(`Smoke onboarding API: timeout esperando ${description}`);
}

async function waitUntil(predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Smoke onboarding API: timeout esperando ${description}`);
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
  assert(clicked, `no se encontró el botón habilitado "${text}"`);
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

async function fillFormField(cdp, label, value) {
  const assigned = await cdp.evaluate(`(() => {
    const form = document.querySelector('.saurio-providers-form');
    const field = [...(form?.querySelectorAll('label') ?? [])]
      .find((item) => item.textContent?.trim().startsWith(${JSON.stringify(label)}))?.querySelector('input');
    if (!(field instanceof HTMLInputElement)) return false;
    field.setAttribute('data-onboarding-field', ${JSON.stringify(label)});
    return true;
  })()`);
  assert(assigned, `no se encontró el campo ${label} del proveedor`);
  await fill(cdp, `[data-onboarding-field=${JSON.stringify(label)}]`, value);
  await cdp.evaluate(`document.querySelector('[data-onboarding-field=${JSON.stringify(label)}]')?.removeAttribute('data-onboarding-field')`);
}

async function setSelect(cdp, selector, value) {
  const changed = await cdp.evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    if (!(select instanceof HTMLSelectElement)) return false;
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert(changed, `no se pudo elegir ${value}`);
  await delay(100);
}

async function chooseModel(cdp, name) {
  const clicked = await cdp.evaluate(`(() => {
    const option = [...document.querySelectorAll('.saurio-model-select__option')]
      .find((item) => item.querySelector('strong')?.textContent?.trim() === ${JSON.stringify(name)});
    const button = option?.querySelector('.saurio-model-select__option-select');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, `no apareció ${name} en el selector de modelo`);
  await delay(100);
}

async function forceStop(instance) {
  try { instance.cdp?.socket?.close(); } catch { /* cierre de rescate de un smoke fallido */ }
  if (instance.child?.exitCode === null) instance.child.kill();
  const deadline = Date.now() + 3_000;
  while (instance.child?.exitCode === null && Date.now() < deadline) await delay(25);
}

const requests = [];
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [{ id: MODEL_NAME, object: 'model', owned_by: 'smoke', context_length: 8_192 }] }));
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-onboarding', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1_000), model: MODEL_NAME,
        choices: [{ index: 0, delta: { role: 'assistant', content: RESPONSE }, finish_reason: null }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-onboarding', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1_000), model: MODEL_NAME,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 7 },
      })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'Endpoint de smoke no habilitado.' } }));
});
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Smoke onboarding API: el servidor local no obtuvo puerto.');
const baseUrl = `http://127.0.0.1:${address.port}`;

const exePath = resolve('apps/desktop/release/win-unpacked/SaurioLLM.exe');
assert(existsSync(exePath), `no existe el ejecutable: ${exePath}`);
const tempRoot = mkdtempSync(join(tmpdir(), 'saurio-onboarding-api-023-'));
const profile = join(tempRoot, 'perfil nuevo');
const outputDir = resolve('smoke/onboarding-api-023');
const screenshotPath = join(outputDir, 'primer-chat-api.png');
let app;
let completed = false;
try {
  mkdirSync(outputDir, { recursive: true });
  app = await launchAtPort(exePath, profile);
  const { cdp } = app;
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForRenderedRoot(cdp);
  await waitFor(cdp,
    `document.querySelector('[role="dialog"][aria-label="Asistente de primer arranque"]') !== null`,
    'el asistente de primer arranque en un perfil vacío');
  await waitFor(cdp,
    `document.querySelector('[role="dialog"]')?.textContent?.includes('Tengo una clave de API') === true`,
    'la alternativa API cuando Ollama no responde');
  await clickText(cdp, 'Tengo una clave de API', '[role="dialog"]');
  await waitFor(cdp, `document.querySelector('.saurio-settings-nav') !== null`, 'Ajustes tras elegir API en el asistente');
  await waitFor(cdp, `document.querySelector('.saurio-providers-form') !== null`, 'el formulario de proveedores');

  await setSelect(cdp, '.saurio-providers-form select', 'custom');
  await fillFormField(cdp, 'Nombre', PROVIDER_LABEL);
  await fillFormField(cdp, 'Base URL', baseUrl);
  await fillFormField(cdp, 'Clave de API', 'smoke-local-key');
  await clickText(cdp, 'Agregar proveedor', '.saurio-providers-form');
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(PROVIDER_LABEL)}) && document.body.innerText.includes(${JSON.stringify(baseUrl)})`,
    'el proveedor local guardado desde la UI');

  await clickText(cdp, 'Chats');
  await waitFor(cdp, `document.querySelector('.saurio-sidebar') !== null`, 'la vista Chats');
  await clickText(cdp, 'Nuevo proyecto', '.saurio-sidebar');
  await waitFor(cdp, `document.querySelector('.saurio-text-dialog')?.textContent?.includes('Nuevo proyecto') === true`, 'el diálogo de proyecto nuevo');
  await fill(cdp, '.saurio-text-dialog input', 'Primer proyecto API');
  await clickText(cdp, 'Crear proyecto', '.saurio-text-dialog');
  await waitFor(cdp, `document.querySelector('.saurio-sidebar')?.textContent?.includes('Primer proyecto API') === true`, 'el proyecto creado desde la UI');

  await waitFor(cdp,
    `document.querySelector('button[title="Modelo del próximo chat"]') instanceof HTMLButtonElement`,
    'el selector de modelo del primer chat');
  await cdp.evaluate(`document.querySelector('button[title="Modelo del próximo chat"]')?.click()`);
  await waitFor(cdp, `document.querySelector('.saurio-model-select__popover') !== null`, 'el popover del selector explícito');
  await chooseModel(cdp, MODEL_NAME);
  await waitFor(cdp,
    `document.querySelector('button[title="Modelo del próximo chat"]')?.textContent?.includes(${JSON.stringify(MODEL_NAME)}) === true`,
    'el modelo API elegido explícitamente');
  await clickText(cdp, '+ Nuevo chat', '.saurio-sidebar');
  await waitFor(cdp, `document.querySelector('textarea[aria-label="Mensaje para el agente"]') instanceof HTMLTextAreaElement`, 'el compositor del primer chat');
  await waitFor(cdp,
    `document.querySelector('.chat-input__model')?.textContent?.includes(${JSON.stringify(MODEL_NAME)}) === true`,
    'el modelo explícito del chat creado');

  await fill(cdp, 'textarea[aria-label="Mensaje para el agente"]', PROMPT);
  await clickText(cdp, 'Enviar', '.chat-input');
  await waitUntil(() => requests.length === 1, 'la completación enviada al proveedor local');
  await waitFor(cdp, `(() => [...document.querySelectorAll('.message-bubble.role-assistant .message-bubble__content')]
    .some((bubble) => bubble.textContent?.includes(${JSON.stringify(RESPONSE)})))()`, 'la burbuja final de respuesta local visible en el chat');
  await delay(250);
  assert(requests[0]?.model === MODEL_NAME, `modelo inesperado en la completación: ${requests[0]?.model}`);
  assert(requests[0]?.messages?.some((message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes(PROMPT)),
    'el proveedor no recibió el mensaje enviado desde el compositor');
  assert(await cdp.invoke('settings:get', { key: 'onboarding.completed' }) === true,
    'elegir la ruta API en el asistente no marcó onboarding.completed');

  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const state = await cdp.evaluate(`({ text: document.body.innerText, model: document.querySelector('.chat-input__model')?.textContent?.trim() })`);
  writeFileSync(join(outputDir, 'primer-chat-api.json'), JSON.stringify(state, null, 2));

  const shutdown = await stop(app);
  app = undefined;
  assertCleanShutdown(shutdown, 'cierre del recorrido de onboarding API');
  completed = true;
  console.log(JSON.stringify({
    ok: true, mode: 'packaged', model: MODEL_NAME, provider: PROVIDER_LABEL,
    chatRequests: requests.length, onboardingCompletedFromUi: true, screenshot: screenshotPath, externalCalls: 0,
  }, null, 2));
} finally {
  if (app) await forceStop(app);
  await new Promise((done) => server.close(done));
  const resolvedTemp = resolve(tempRoot);
  if (completed && resolve(resolvedTemp, '..') === resolve(tmpdir()) && basename(resolvedTemp).startsWith('saurio-onboarding-api-023-')) {
    rmSync(resolvedTemp, { recursive: true, force: true });
  } else if (!completed) {
    console.error(`Smoke onboarding API falló; se preservó el perfil: ${resolvedTemp}`);
  }
}
