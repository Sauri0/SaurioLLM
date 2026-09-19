#!/usr/bin/env node
// Aceptación UI de Explorar: caché local real de biblioteca y fixture IPC local de Hugging Face.
// No abre la red ni dispara descargas/inferencia. Uso: node scripts/smoke-explore-023.mjs --dev
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CdpClient, assertCleanShutdown, launchAtPort, stop, waitForRenderedRoot } from './smoke-release-functional.mjs';

const dev = process.argv.includes('--dev');
const exe = resolve(dev ? 'node_modules/electron/dist/electron.exe' : 'apps/desktop/release/win-unpacked/SaurioLLM.exe');
const output = resolve('smoke/explore-023');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke explorar: ${message}`);
}

async function waitFor(cdp, expression, description) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Smoke explorar: no apareció ${description}.`);
}

async function click(cdp, selector) {
  const rect = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return undefined;
    element.scrollIntoView({ block: 'center' });
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  assert(rect, `no existe ${selector}`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
  await delay(120);
}

async function fill(cdp, selector, value) {
  await click(cdp, selector);
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.call('Input.insertText', { text: value });
}

async function setSelect(cdp, selector, value) {
  const changed = await cdp.evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    if (!(select instanceof HTMLSelectElement)) return false;
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert(changed, `no existe el selector ${selector}`);
  await delay(120);
}

async function capture(cdp, name) {
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  const state = await cdp.evaluate(`({ text: document.body.innerText, controls: [...document.querySelectorAll('button,input,select')].map((element) => ({ text: element.textContent?.trim(), label: element.getAttribute('aria-label'), value: element.value })) })`);
  writeFileSync(join(output, `${name}.json`), JSON.stringify(state, null, 2));
}

function seedLibraryCache(profile) {
  const snapshot = {
    generatedAt: new Date().toISOString(), source: 'smoke://explore-local-cache', familyCount: 3, variantCount: 4,
    families: [
      { name: 'familia-contexto', capabilityHints: ['tools'], sizeHints: [], variants: [
        { tag: 'mini', sizeBytes: 2 * 1024 ** 3, contextMax: 8192, vision: false },
        { tag: 'max', sizeBytes: 8 * 1024 ** 3, contextMax: 32768, vision: false },
      ] },
      { name: 'familia-media', capabilityHints: ['vision'], sizeHints: [], variants: [
        { tag: 'media', sizeBytes: 5 * 1024 ** 3, contextMax: 16384, vision: true },
      ] },
      { name: 'familia-corta', capabilityHints: [], sizeHints: [], variants: [
        { tag: 'corta', sizeBytes: 1 * 1024 ** 3, contextMax: 4096, vision: false },
      ] },
    ],
  };
  writeFileSync(join(profile, 'model-library-cache.json'), JSON.stringify({ snapshot, cachedAt: Date.now() }), 'utf8');
}

async function inspectorPort() {
  const listener = createServer();
  await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
  const address = listener.address();
  await new Promise((done) => listener.close(done));
  if (!address || typeof address === 'string') throw new Error('Smoke explorar: no se pudo reservar inspector main.');
  return address.port;
}

async function connectMain(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((item) => item.webSocketDebuggerUrl);
  if (!target) throw new Error('Smoke explorar: el main no expuso inspector.');
  const main = new CdpClient(target.webSocketDebuggerUrl);
  await main.ready();
  return main;
}

async function installHuggingFaceFixture(main) {
  const electron = `process.getBuiltinModule('module').createRequire(process.cwd()+'/explore-smoke-inspector.cjs')('electron')`;
  const results = [{ id: 'local-fixture/Family-GGUF', likes: 12, downloads: 345, tags: ['gguf', 'text-generation'] }];
  const files = [
    { filename: 'family-Q4_K_M.gguf', sizeBytes: 3 * 1024 ** 3, quant: 'Q4_K_M' },
    { filename: 'family-Q5_K_M.gguf', sizeBytes: 8 * 1024 ** 3, quant: 'Q5_K_M' },
    { filename: 'family-Q5_K_S.gguf', sizeBytes: 8 * 1024 ** 3, quant: 'Q5_K_S' },
    { filename: 'family-unknown.gguf' },
  ];
  await main.evaluate(`(() => {
    const ipc = ${electron}.ipcMain;
    ipc.removeHandler('models:hfSearch');
    ipc.removeHandler('models:hfFiles');
    globalThis.__saurioExploreFixtureCalls = [];
    ipc.handle('models:hfSearch', (_event, input) => {
      globalThis.__saurioExploreFixtureCalls.push({ channel: 'search', query: input.query });
      return ${JSON.stringify(results)};
    });
    ipc.handle('models:hfFiles', (_event, input) => {
      globalThis.__saurioExploreFixtureCalls.push({ channel: 'files', modelId: input.modelId });
      return ${JSON.stringify(files)};
    });
  })()`);
}

mkdirSync(output, { recursive: true });
const profile = join(output, `profile-${Date.now()}`);
mkdirSync(profile, { recursive: true });
seedLibraryCache(profile);
const mainPort = await inspectorPort();
let instance;
let main;
try {
  instance = await launchAtPort(exe, profile, [...(dev ? [resolve('apps/desktop')] : []), `--inspect=127.0.0.1:${mainPort}`]);
  main = await connectMain(mainPort);
  await installHuggingFaceFixture(main);
  const { cdp } = instance;
  await waitForRenderedRoot(cdp);
  await cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });
  // El estado de onboarding se leyó al montar; cerrar el asistente ya visible evita que capture el
  // clic de navegación mientras el ajuste persistido entra en vigor para próximos arranques.
  if (await cdp.evaluate('Boolean(document.querySelector("button[aria-label=\\"Cerrar asistente\\"]"))')) {
    await click(cdp, 'button[aria-label="Cerrar asistente"]');
    await waitFor(cdp, '!document.querySelector("button[aria-label=\\"Cerrar asistente\\"]")', 'el cierre del asistente inicial');
  }

  await click(cdp, 'nav button[title^="Modelos ("]');
  await waitFor(cdp, '[...document.querySelectorAll(".saurio-subtab")].some((button) => button.textContent?.trim() === "Explorar")', 'las pestañas del Centro de modelos');
  const exploreTabFound = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.saurio-subtab')].find((item) => item.textContent?.trim() === 'Explorar');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.setAttribute('data-smoke-explore-tab', 'true');
    return true;
  })()`);
  assert(exploreTabFound, 'no aparece la pestaña Explorar');
  await click(cdp, '[data-smoke-explore-tab="true"]');
  await waitFor(cdp, 'document.body.innerText.includes("familia-contexto")', 'el catálogo de la caché local');
  assert(await cdp.evaluate('document.body.innerText.includes("en caché")'), 'Explorar no declaró que el catálogo venía de caché');

  await setSelect(cdp, 'select[aria-label="Ordenar por"]', 'context');
  await waitFor(cdp, `(() => {
    const names = [...document.querySelectorAll('.saurio-explore__family')].map((row) => row.querySelector('strong')?.textContent ?? '');
    const high = names.findIndex((name) => name.includes('familia-contexto'));
    const medium = names.findIndex((name) => name.includes('familia-media'));
    const low = names.findIndex((name) => name.includes('familia-corta'));
    return high >= 0 && medium >= 0 && low >= 0 && high < medium && medium < low;
  })()`, 'el orden relativo por contexto informado');
  const familyButtonFound = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.saurio-explore__family button.saurio-row__title-btn')]
      .find((item) => item.textContent?.includes('familia-contexto'));
    if (!(button instanceof HTMLButtonElement)) return false;
    button.setAttribute('data-smoke-expand-family', 'true');
    return true;
  })()`);
  assert(familyButtonFound, 'no aparece la familia con variantes');
  await click(cdp, '[data-smoke-expand-family="true"]');
  await waitFor(cdp, `(() => {
    const variants = [...document.querySelectorAll('#family-familia-contexto .saurio-explore__variant')];
    return variants.length === 2 && variants.every((row) => row.textContent?.includes('Instalación sin confirmar'))
      && variants.every((row) => !row.textContent?.includes('Descargar'))
      && variants.some((row) => row.textContent?.includes('familia-contexto:mini'))
      && variants.some((row) => row.textContent?.includes('familia-contexto:max'));
  })()`, 'las acciones de las dos variantes de una familia');
  await capture(cdp, 'families-context-order');

  await click(cdp, '.saurio-explore__source-tabs .saurio-subtab:nth-child(2)');
  await waitFor(cdp, 'Boolean(document.querySelector(".saurio-explore__hf input"))', 'la búsqueda de Hugging Face');
  await fill(cdp, '.saurio-explore__hf input[placeholder^="Buscar en Hugging Face"]', 'fixture gguf');
  await click(cdp, '.saurio-explore__hf .saurio-explore__by-name-row button');
  await waitFor(cdp, 'document.body.innerText.includes("local-fixture/Family-GGUF")', 'el resultado local de Hugging Face');
  const repoFound = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.saurio-explore__hf .saurio-row__title-btn')]
      .find((item) => item.textContent?.includes('local-fixture/Family-GGUF'));
    if (!(button instanceof HTMLButtonElement)) return false;
    button.setAttribute('data-smoke-hf-repo', 'true');
    return true;
  })()`);
  assert(repoFound, 'no aparece el repo de la fixture Hugging Face');
  await click(cdp, '[data-smoke-hf-repo="true"]');
  await waitFor(cdp, 'Boolean(document.querySelector("select[aria-label=\\"Filtrar archivos Hugging Face por tamaño\\"]"))', 'los filtros de archivos Hugging Face');
  await setSelect(cdp, 'select[aria-label="Filtrar archivos Hugging Face por tamaño"]', 'medium');
  await setSelect(cdp, 'select[aria-label="Filtrar archivos Hugging Face por cuantización"]', 'Q5_K_M');
  await waitFor(cdp, `(() => {
    const files = [...document.querySelectorAll('.saurio-explore__hf-files .saurio-side-panel__variants button')];
    return files.length === 1 && files[0]?.textContent?.includes('Q5_K_M');
  })()`, 'el filtro compuesto de tamaño y cuantización');
  const fixtureCalls = await main.evaluate('globalThis.__saurioExploreFixtureCalls');
  assert(JSON.stringify(fixtureCalls) === JSON.stringify([
    { channel: 'search', query: 'fixture gguf' },
    { channel: 'files', modelId: 'local-fixture/Family-GGUF' },
  ]), `Hugging Face recibió llamadas inesperadas: ${JSON.stringify(fixtureCalls)}`);
  await capture(cdp, 'huggingface-composed-filter');

  console.log(JSON.stringify({ ok: true, mode: dev ? 'dev' : 'packaged', output, fixture: 'caché local real de biblioteca + IPC HF (sin red ni descargas)' }));
} catch (error) {
  if (instance?.cdp) await capture(instance.cdp, 'failure').catch(() => undefined);
  throw error;
} finally {
  await main?.close();
  if (instance) assertCleanShutdown(await stop(instance), 'smoke explorar');
}
