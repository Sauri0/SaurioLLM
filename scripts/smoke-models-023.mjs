#!/usr/bin/env node
// Smoke de UI para catálogos API grandes. Corre el paquete (o --dev) contra un servidor HTTP local
// OpenAI-compatible: sólo expone GET /v1/models y nunca acepta completions ni usa credenciales reales.
// Uso: node scripts/smoke-models-023.mjs --dev
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertCleanShutdown, launchAtPort, stop, waitForRenderedRoot,
} from './smoke-release-functional.mjs';

const dev = process.argv.includes('--dev');

const output = resolve('smoke/models-023');
mkdirSync(output, { recursive: true });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const SEARCH_TARGET_MS = 150;
const alphaModels = Array.from({ length: 1_000 }, (_, index) => ({
  id: `alpha-model-${String(index + 1).padStart(3, '0')}`,
  object: 'model', owned_by: 'catalogo-alpha', context_length: index % 2 === 0 ? 32_768 : 8_192,
}));
const betaModels = Array.from({ length: 6 }, (_, index) => ({
  id: `beta-model-${String(index + 1).padStart(3, '0')}`,
  object: 'model', owned_by: 'catalogo-beta', context_length: 16_384,
}));

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke modelos: ${message}`);
}

async function startCatalogServer() {
  const requests = [];
  const unavailable = new Set();
  const server = createServer((request, response) => {
    const catalog = request.headers['x-saurio-smoke-catalog'];
    requests.push({ method: request.method, url: request.url, catalog });
    if (request.method !== 'GET' || request.url !== '/v1/models') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Sólo /v1/models está habilitado en este smoke.' } }));
      return;
    }
    const models = catalog === 'beta' ? betaModels : alphaModels;
    if (unavailable.has(catalog)) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Catálogo temporalmente no disponible' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: models }));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Smoke modelos: no se pudo asignar el puerto local.');
  return { server, requests, unavailable, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  await new Promise((done) => server.close(done));
}

async function waitFor(cdp, expression, description) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Smoke modelos: no apareció ${description}.`);
}

async function click(cdp, selector) {
  const rect = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('No existe: ${selector}');
    element.scrollIntoView({ block: 'center' });
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
  await delay(150);
}

/** Mide el recorrido real del input Chromium -> React -> lista filtrada. Incluye CDP, por lo que
 * es una medición conservadora de desarrollo y no un benchmark aislado del algoritmo. */
async function measureSearch(cdp, selector, value, filteredExpression, description) {
  await click(cdp, selector);
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  const startedAt = performance.now();
  await cdp.call('Input.insertText', { text: value });
  const deadline = startedAt + 20_000;
  while (performance.now() < deadline) {
    if (await cdp.evaluate(filteredExpression)) return performance.now() - startedAt;
    await delay(15);
  }
  throw new Error(`Smoke modelos: no terminó el filtrado de ${description}.`);
}

async function setSelectInLabel(cdp, rootSelector, label, value) {
  const changed = await cdp.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    const target = [...(root?.querySelectorAll('label') ?? [])]
      .find((item) => item.textContent?.trim().startsWith(${JSON.stringify(label)}))?.querySelector('select');
    if (!(target instanceof HTMLSelectElement)) return false;
    target.value = ${JSON.stringify(value)};
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert(changed, `no existe el filtro ${label}`);
  await delay(250);
}

async function setSelect(cdp, selector, value) {
  const changed = await cdp.evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLSelectElement)) return false;
    target.value = ${JSON.stringify(value)};
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert(changed, `no existe el selector ${selector}`);
  await delay(250);
}

async function fillInput(cdp, selector, value) {
  await click(cdp, selector);
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.call('Input.insertText', { text: value });
  await delay(100);
}

async function capture(cdp, name) {
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  const state = await cdp.evaluate(`({
    text: document.body.innerText,
    controls: [...document.querySelectorAll('button,input,select')].map((element) => ({
      text: element.textContent?.trim(), label: element.getAttribute('aria-label'), title: element.getAttribute('title'), value: element.value,
    })),
  })`);
  writeFileSync(join(output, `${name}.json`), JSON.stringify(state, null, 2));
  return state;
}

const catalog = await startCatalogServer();
let instance;
const rendererErrors = [];
try {
  instance = await launchAtPort(
    resolve(dev ? 'node_modules/electron/dist/electron.exe' : 'apps/desktop/release/win-unpacked/SaurioLLM.exe'),
    join(output, `profile-${Date.now()}`),
    dev ? [resolve('apps/desktop')] : [],
  );
  const { cdp } = instance;
  cdp.socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') rendererErrors.push(message.params.exceptionDetails);
  });
  await cdp.call('Runtime.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForRenderedRoot(cdp);
  await cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });

  const alphaProvider = await cdp.invoke('providers:add', {
    preset: 'custom', label: 'Catálogo Alpha local', baseUrl: catalog.baseUrl,
    headers: { 'x-saurio-smoke-catalog': 'alpha' },
  });
  const betaProvider = await cdp.invoke('providers:add', {
    preset: 'custom', label: 'Catálogo Beta local', baseUrl: catalog.baseUrl,
    headers: { 'x-saurio-smoke-catalog': 'beta' },
  });
  assert(alphaProvider.locality === 'local' && betaProvider.locality === 'local', 'el provider HTTP local no conservó localidad local');

  const allModels = await cdp.invoke('models:list', { refresh: true });
  assert(allModels.length === 1_006, `models:list devolvió ${allModels.length}, se esperaban 1006`);
  assert(allModels.filter((model) => model.ref.providerId === alphaProvider.id).length === 1_000, 'faltan modelos Alpha');
  assert(allModels.filter((model) => model.ref.providerId === betaProvider.id).length === 6, 'faltan modelos Beta');
  catalog.unavailable.add('beta');
  const cachedModels = await cdp.invoke('models:list', { refresh: true, providerId: betaProvider.id });
  const failedStatuses = await cdp.invoke('models:catalogStatus', undefined);
  assert(cachedModels.length === 1_006, 'el fallo de Beta perdió modelos conservados en caché');
  assert(failedStatuses.some((status) => status.providerId === betaProvider.id && status.state === 'stale' && status.updatedAt && status.error), 'Beta no informó caché fechada y error');
  assert(failedStatuses.some((status) => status.providerId === alphaProvider.id && status.state === 'ready'), 'el fallo de Beta invalidó Alpha');
  catalog.unavailable.delete('beta');
  await cdp.invoke('models:list', { refresh: true, providerId: betaProvider.id });
  await cdp.invoke('models:updateManual', { providerId: betaProvider.id, name: 'beta-private-unlisted' });
  const withManual = await cdp.invoke('models:list', {});
  const manual = withManual.find((model) => model.ref.providerId === betaProvider.id && model.ref.name === 'beta-private-unlisted');
  assert(withManual.length === 1_007 && manual?.metadataSource === 'manual', 'el ID manual no apareció en el catálogo');
  assert(manual.contextMax === undefined && manual.pricing === undefined, 'el ID manual inventó contexto o precio');
  await cdp.invoke('models:updateManual', { providerId: betaProvider.id, name: 'beta-private-unlisted', remove: true });
  assert((await cdp.invoke('models:list', {})).length === 1_006, 'quitar el ID manual no conservó el catálogo original');

  const project = await cdp.invoke('project:createManaged', { name: 'Selector catálogo grande' });
  const chat = await cdp.invoke('chat:create', {
    projectId: project.id, agentId: 'agent_builtin_lead', mode: 'ask', modelRef: allModels[0].ref,
  });
  await cdp.invoke('settings:set', { key: 'ui.projects.lastProjectId', value: project.id });
  await cdp.invoke('settings:set', { key: 'ui.projects.lastChatId', value: chat.id });
  await cdp.call('Page.reload', { ignoreCache: true });
  await delay(700);
  await waitForRenderedRoot(cdp);
  await waitFor(cdp, 'Boolean(document.querySelector("button[title=\\"Cambiar el modelo de este chat\\"]"))', 'el selector del chat');

  await click(cdp, 'button[title="Cambiar el modelo de este chat"]');
  await waitFor(cdp, 'document.querySelector(".saurio-model-select__count")?.textContent === "1006 modelos"', 'los 1006 modelos en el selector');
  await setSelectInLabel(cdp, '.saurio-model-select__popover', 'Proveedor', betaProvider.id);
  await waitFor(cdp, 'document.querySelector(".saurio-model-select__count")?.textContent === "6 modelos"', 'el filtro del proveedor Beta');
  await setSelectInLabel(cdp, '.saurio-model-select__popover', 'Proveedor', alphaProvider.id);
  await waitFor(cdp, 'document.querySelector(".saurio-model-select__count")?.textContent === "1000 modelos"', 'el filtro del proveedor Alpha');
  await click(cdp, '.saurio-model-select__pagination button:last-child');
  await waitFor(cdp, 'document.querySelector(".saurio-model-select__pagination span")?.textContent === "Página 2 de 10"', 'la segunda página del selector');
  await waitFor(cdp, 'document.querySelector(".saurio-model-select__list")?.innerText.includes("alpha-model-150")', 'un modelo de la segunda página');
  const selectorSearchLatencyMs = await measureSearch(cdp, '.saurio-model-select__search-row input', 'alpha-model-157',
    'document.querySelector(".saurio-model-select__count")?.textContent === "1 modelos"', 'selector',
  );
  const optionFound = await cdp.evaluate(`(() => {
    const option = [...document.querySelectorAll('.saurio-model-select__option')]
      .find((item) => item.textContent?.includes('alpha-model-157'))?.querySelector('.saurio-model-select__option-select');
    if (!(option instanceof HTMLButtonElement)) return false;
    option.setAttribute('data-smoke-model', 'alpha-157');
    return true;
  })()`);
  assert(optionFound, 'no aparece la opción alpha-model-157 para seleccionar');
  await click(cdp, '[data-smoke-model="alpha-157"]');
  await waitFor(cdp, '!document.querySelector(".saurio-model-select__popover")', 'el cierre del selector tras elegir');
  await waitFor(cdp,
    `window.saurio.invoke('chat:list', { projectId: ${JSON.stringify(project.id)} }).then((chats) => chats.some((item) => item.id === ${JSON.stringify(chat.id)} && item.modelRef?.name === 'alpha-model-157'))`,
    'la persistencia de la selección del selector',
  );
  const updatedChat = (await cdp.invoke('chat:list', { projectId: project.id })).find((item) => item.id === chat.id);
  assert(updatedChat?.modelRef?.name === 'alpha-model-157', 'la selección de modelo no se persistió en el chat');
  await capture(cdp, 'selector');

  await click(cdp, 'nav button[title^="Modelos ("]');
  await waitFor(cdp, 'Boolean(document.querySelector(".saurio-models__filters"))', 'los filtros del Centro de modelos');
  await waitFor(cdp, 'document.querySelector(".saurio-models__filter-count")?.textContent === "1006 de 1006"', 'la lista grande en Centro de modelos');
  await setSelect(cdp, '.saurio-models__filters select[aria-label="Filtrar por proveedor"]', alphaProvider.id);
  await waitFor(cdp, 'document.querySelector(".saurio-models__filter-count")?.textContent === "1000 de 1006"', 'el filtro Alpha del Centro de modelos');
  const nextPageFound = await cdp.evaluate(`(() => {
    const pagination = [...document.querySelectorAll('.saurio-row__line')]
      .find((item) => item.textContent?.includes('Página'));
    const next = pagination?.querySelectorAll('button')[1];
    if (!(next instanceof HTMLButtonElement)) return false;
    next.setAttribute('data-smoke-models-next', 'true');
    return true;
  })()`);
  assert(nextPageFound, 'no aparece la paginación del Centro de modelos');
  await click(cdp, '[data-smoke-models-next="true"]');
  await waitFor(cdp, '[...document.querySelectorAll(".saurio-row__line")].some((item) => item.textContent?.includes("Página 2 de 50"))', 'la segunda página del Centro de modelos');
  const panelSearchLatencyMs = await measureSearch(cdp, '.saurio-models__filters input[aria-label="Buscar modelo"]', 'alpha-model-157',
    'document.querySelector(".saurio-models__filter-count")?.textContent === "1 de 1006"', 'Centro de modelos',
  );
  await capture(cdp, 'models-panel');

  // El ID manual se agrega y se quita mediante el formulario del renderer. La única API HTTP de
  // este smoke sigue siendo el GET del catálogo local: no hay completions ni inferencia.
  await waitFor(cdp, 'Boolean(document.querySelector(".saurio-manual-models__form"))', 'el formulario de ID manual');
  await setSelectInLabel(cdp, '.saurio-manual-models', 'Proveedor API', betaProvider.id);
  await fillInput(cdp, '.saurio-manual-models__form input', 'beta-ui-unlisted');
  const addManualFound = await cdp.evaluate(`(() => {
    const button = document.querySelector('.saurio-manual-models__form button[type="submit"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.setAttribute('data-smoke-manual-add', 'true');
    return true;
  })()`);
  assert(addManualFound, 'no aparece el botón para agregar el ID manual');
  await click(cdp, '[data-smoke-manual-add="true"]');
  await waitFor(cdp,
    'document.querySelector(".saurio-manual-models__list")?.textContent?.includes("beta-ui-unlisted") === true',
    'el ID manual agregado por el formulario',
  );
  const uiManualModels = await cdp.invoke('models:list', { refresh: false });
  const uiManual = uiManualModels.find((model) => model.ref.providerId === betaProvider.id && model.ref.name === 'beta-ui-unlisted');
  assert(uiManual?.metadataSource === 'manual' && uiManual.contextMax === undefined && uiManual.pricing === undefined,
    'el formulario no persistió el ID manual con metadatos desconocidos');
  assert(await cdp.evaluate('document.body.innerText.includes("ID manual · capacidades y contexto sin confirmar.")'),
    'el formulario no explica que las capacidades y el contexto siguen sin confirmar');
  await capture(cdp, 'manual-model-added');
  const removeManualFound = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.saurio-manual-models__list .saurio-row')]
      .find((item) => item.textContent?.includes('beta-ui-unlisted'));
    const button = [...(row?.querySelectorAll('button') ?? [])]
      .find((item) => item.textContent?.trim() === 'Quitar definición manual');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.setAttribute('data-smoke-manual-remove', 'true');
    return true;
  })()`);
  assert(removeManualFound, 'no aparece la acción para quitar el ID manual');
  await click(cdp, '[data-smoke-manual-remove="true"]');
  await waitFor(cdp,
    '!document.querySelector(".saurio-manual-models__list")?.textContent?.includes("beta-ui-unlisted")',
    'la eliminación del ID manual desde el formulario',
  );
  assert(!(await cdp.invoke('models:list', { refresh: false })).some((model) => model.ref.providerId === betaProvider.id && model.ref.name === 'beta-ui-unlisted'),
    'quitar la definición manual desde la UI dejó un modelo manual en el catálogo');
  await capture(cdp, 'manual-model-removed');

  // Ocultar no puede cambiar el chat ni hacer desaparecer de la lista el modelo que este chat ya
  // usa. El estado se verifica también en settings para distinguir persistencia de un mero filtro UI.
  const hideCurrentFound = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.saurio-row-list > .saurio-row')]
      .find((item) => item.querySelector('strong')?.textContent?.trim() === 'alpha-model-157');
    const button = [...(row?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === 'Ocultar');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.setAttribute('data-smoke-hide-current', 'true');
    return true;
  })()`);
  assert(hideCurrentFound, 'no aparece Ocultar para el modelo actual del chat');
  await click(cdp, '[data-smoke-hide-current="true"]');
  await waitFor(cdp, `(() => {
    const row = [...document.querySelectorAll('.saurio-row-list > .saurio-row')]
      .find((item) => item.querySelector('strong')?.textContent?.trim() === 'alpha-model-157');
    return Boolean(row?.textContent?.includes('en uso en este chat') && row.textContent.includes('oculto')
      && [...row.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Volver a mostrar'));
  })()`, 'el modelo actual oculto conservado en el Centro de modelos');
  const hiddenSettings = await cdp.invoke('settings:get', { key: 'ui.models.hidden' });
  assert(Array.isArray(hiddenSettings) && hiddenSettings.some((ref) => ref.providerId === alphaProvider.id && ref.name === 'alpha-model-157'),
    'Ocultar no persistió la identidad compuesta del modelo');
  const stillCurrent = (await cdp.invoke('chat:list', { projectId: project.id })).find((item) => item.id === chat.id);
  assert(stillCurrent?.modelRef?.providerId === alphaProvider.id && stillCurrent.modelRef.name === 'alpha-model-157',
    'Ocultar cambió el modelo persistido del chat');
  await capture(cdp, 'hidden-current-model');
  const showHiddenFound = await cdp.evaluate(`(() => {
    const input = [...document.querySelectorAll('.saurio-models__filters label')]
      .find((label) => label.textContent?.includes('Ver ocultos (1)'))?.querySelector('input');
    if (!(input instanceof HTMLInputElement)) return false;
    input.setAttribute('data-smoke-show-hidden', 'true');
    return true;
  })()`);
  assert(showHiddenFound, 'el filtro Ver ocultos no muestra el conteo esperado');
  await click(cdp, '[data-smoke-show-hidden="true"]');
  assert(await cdp.evaluate('document.querySelector("[data-smoke-show-hidden=\\"true\\"]") instanceof HTMLInputElement && document.querySelector("[data-smoke-show-hidden=\\"true\\"]").checked'),
    'el filtro Ver ocultos no respondió al clic');
  const restoreCurrentFound = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.saurio-row-list > .saurio-row')]
      .find((item) => item.querySelector('strong')?.textContent?.trim() === 'alpha-model-157');
    const button = [...(row?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === 'Volver a mostrar');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.setAttribute('data-smoke-restore-current', 'true');
    return true;
  })()`);
  assert(restoreCurrentFound, 'no aparece Volver a mostrar para el modelo actual oculto');
  await click(cdp, '[data-smoke-restore-current="true"]');
  await waitFor(cdp, `(() => {
    const row = [...document.querySelectorAll('.saurio-row-list > .saurio-row')]
      .find((item) => item.querySelector('strong')?.textContent?.trim() === 'alpha-model-157');
    return Boolean(row && !row.textContent?.includes('oculto')
      && [...row.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Ocultar'));
  })()`, 'la restauración del modelo oculto');
  const restoredSettings = await cdp.invoke('settings:get', { key: 'ui.models.hidden' });
  assert(Array.isArray(restoredSettings) && !restoredSettings.some((ref) => ref.providerId === alphaProvider.id && ref.name === 'alpha-model-157'),
    'Volver a mostrar no quitó el modelo de la preferencia persistida');
  await capture(cdp, 'restored-current-model');

  // Escape debe cerrar el selector anidado sin descartar el borrador del agente.
  await click(cdp, 'nav button[title^="Agentes ("]');
  await cdp.evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Nuevo agente')).setAttribute('data-agent-create','true')`);
  await click(cdp, '[data-agent-create]');
  await cdp.call('Input.insertText', { text: 'Borrador conservado' });
  await click(cdp, 'input[name="modelMode"]');
  await click(cdp, '.agent-editor__card .saurio-model-select__trigger');
  await waitFor(cdp, 'Boolean(document.querySelector(".saurio-model-select__popover"))', 'selector anidado del agente');
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await delay(150);
  assert(await cdp.evaluate(`!document.querySelector('.saurio-model-select__popover') && document.querySelector('[role="dialog"][aria-label="Nuevo agente"] input')?.value==='Borrador conservado'`), 'Escape perdió el borrador del agente al cerrar su selector');
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await delay(150);
  assert(await cdp.evaluate(`!document.querySelector('[role="dialog"][aria-label="Nuevo agente"]') && document.activeElement===document.querySelector('[data-agent-create]')`), 'Escape del editor no restauró el foco');
  await click(cdp, '[data-agent-create]');
  await click(cdp, 'input[name="modelMode"]');
  await click(cdp, '.agent-editor__card .saurio-model-select__trigger');
  await cdp.evaluate(`document.querySelectorAll('input[name="modelMode"]')[1].setAttribute('data-auto-mode','true')`);
  await click(cdp, '[data-auto-mode]');
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await delay(150);
  assert(await cdp.evaluate(`!document.querySelector('[role="dialog"][aria-label="Nuevo agente"]')`), 'Cambiar a Automático dejó Escape bloqueado por un selector desmontado');

  assert(rendererErrors.length === 0, `hubo excepciones en el renderer: ${JSON.stringify(rendererErrors)}`);
  assert(catalog.requests.length > 0, 'el servidor sintético no recibió consultas de modelos');
  assert(catalog.requests.every((request) => request.method === 'GET' && request.url === '/v1/models'),
    `hubo una solicitud fuera de /v1/models: ${JSON.stringify(catalog.requests)}`);
  console.log(JSON.stringify({
    ok: true, mode: dev ? 'dev' : 'packaged', models: allModels.length, requests: catalog.requests.length, output,
    search: {
      targetMs: SEARCH_TARGET_MS,
      selectorLatencyMs: Number(selectorSearchLatencyMs.toFixed(1)),
      panelLatencyMs: Number(panelSearchLatencyMs.toFixed(1)),
      selectorWithinTarget: selectorSearchLatencyMs <= SEARCH_TARGET_MS,
      panelWithinTarget: panelSearchLatencyMs <= SEARCH_TARGET_MS,
      note: 'Incluye transporte CDP y render de Electron; no es un benchmark aislado.',
    },
  }));
} catch (error) {
  if (instance?.cdp) await capture(instance.cdp, 'failure').catch(() => undefined);
  throw error;
} finally {
  try {
    if (instance) {
      const result = await stop(instance);
      assertCleanShutdown(result, 'smoke de modelos');
    }
  } finally {
    await closeServer(catalog.server);
  }
}
