// Smoke de búsqueda de archivos en el renderer/preload reales.
// Uso: node scripts/smoke-file-search-023.mjs [--dev]
// Siembra solo archivos sintéticos; no ejecuta modelos ni llamadas externas.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDriver } from '../packages/runtime/src/persistence/driver.ts';
import { runMigrations } from '../packages/runtime/src/persistence/migrations/index.ts';
import { createRepositories } from '../packages/runtime/src/persistence/repositories/index.ts';
import { launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown } from './smoke-release-functional.mjs';

const output = resolve('smoke/file-search-023');
const profile = join(output, `profile-${Date.now()}`);
mkdirSync(profile, { recursive: true });
mkdirSync(output, { recursive: true });
const driver = openDriver(join(profile, 'saurio.db'));
runMigrations(driver);
const repos = createRepositories(driver);
for (const id of ['files-A', 'files-B']) {
  const projectPath = join(profile, id);
  mkdirSync(projectPath, { recursive: true });
  await repos.projects.create({ id, path: projectPath, name: id, createdAt: 1, lastOpenedAt: 1 });
  writeFileSync(join(projectPath, '.gitignore'), 'ignored-search-item.txt\n', 'utf8');
}
const projectA = join(profile, 'files-A');
const projectB = join(profile, 'files-B');
for (let index = 0; index < 45; index += 1) {
  writeFileSync(join(projectA, `search-item-${String(index).padStart(2, '0')}.txt`), `contenido base ${index}\n${index < 3 ? 'CONTENIDO-ESPECIAL para abrir desde resultados' : ''}\n`, 'utf8');
}
writeFileSync(join(projectA, '.env-search-item'), 'CONTENIDO-ESPECIAL protegido\n', 'utf8');
writeFileSync(join(projectA, 'ignored-search-item.txt'), 'CONTENIDO-ESPECIAL ignorado\n', 'utf8');
writeFileSync(join(projectB, 'search-item-b.txt'), 'contenido especial del proyecto B\n', 'utf8');
await repos.settings.set('onboarding.completed', true);
await repos.settings.set('ui.projects.lastProjectId', 'files-A');
driver.close();

const dev = process.argv.includes('--dev');
const instance = await launchAtPort(
  resolve(dev ? 'node_modules/electron/dist/electron.exe' : 'apps/desktop/release/win-unpacked/SaurioLLM.exe'),
  profile,
  dev ? [resolve('apps/desktop')] : [],
);
const { cdp } = instance;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function wait(expression, label) {
  const deadline = Date.now() + 15_000;
  while (!await cdp.evaluate(expression)) {
    if (Date.now() >= deadline) throw new Error(label);
    await delay(100);
  }
}

async function click(selector) {
  const point = await cdp.evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) throw new Error('Control ausente: ' + ${JSON.stringify(selector)});
    e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  await delay(160);
}

async function clearInput(selector) {
  await click(selector);
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
}

async function openFilesPanel() {
  await click('nav button[title^="Chats ("]');
  if (await cdp.evaluate('Boolean(document.querySelector(".saurio-compact-tabs"))')) await click('.saurio-compact-tabs button:last-child');
  if (!await cdp.evaluate('Boolean(document.querySelector(".saurio-right-panel"))')) await click('button[title="Mostrar panel de archivos, cambios y terminal"]');
  await cdp.evaluate(`(() => {
    const tab = [...document.querySelectorAll('.saurio-right-panel button[role="tab"]')].find((button) => button.textContent.trim() === 'Archivos');
    tab?.click();
  })()`);
  await wait('Boolean(document.querySelector(`input[aria-label="Buscar archivos"]`))', 'El panel Archivos no mostró el buscador');
}

async function search(query) {
  const selector = 'input[aria-label="Buscar archivos"]';
  await clearInput(selector);
  await cdp.call('Input.insertText', { text: query });
}

async function captureSearchPanel(name = 'search-results') {
  const state = await cdp.evaluate(`(() => {
    const panel = document.querySelector('.saurio-right-panel');
    const controls = [...document.querySelectorAll('.file-search-panel button, .file-search-panel input, .file-search-panel select')]
      .filter((element) => element.getClientRects().length)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.getAttribute('aria-label') || element.textContent?.trim(), right: rect.right };
      });
    if (!panel) throw new Error('Panel de archivos ausente al capturar resultados');
    const panelRect = panel.getBoundingClientRect();
    return { panelRight: panelRect.right, controls };
  })()`);
  const outside = state.controls.filter((control) => control.right > state.panelRight + 1);
  if (outside.length) throw new Error(`Controles fuera del ancho del panel: ${JSON.stringify({ panelRight: state.panelRight, outside })}`);
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  return state;
}

async function openProject(name) {
  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.saurio-project-row__open')].find((element) => element.textContent.includes(${JSON.stringify(name)}));
    if (!button) throw new Error('Proyecto ausente: ' + ${JSON.stringify(name)});
    button.setAttribute('data-smoke-project', 'true');
  })()`);
  await cdp.evaluate('document.querySelector("[data-smoke-project=\\"true\\"]")?.click()');
  await cdp.evaluate('document.querySelector("[data-smoke-project=\\"true\\"]")?.removeAttribute("data-smoke-project")');
  await delay(500);
  const projectState = await cdp.evaluate(`({ rows: [...document.querySelectorAll('.saurio-project-row')].map((row) => ({ text: row.textContent, active: row.classList.contains('active') })), current: document.querySelector('.saurio-sidebar-chats')?.textContent.slice(0, 80) })`);
  if (!projectState.rows.some((row) => row.active && row.text.includes(name))) throw new Error(`No se abrió el proyecto ${name}: ${JSON.stringify(projectState)}`);
}

try {
  await waitForRenderedRoot(cdp);
  await openFilesPanel();
  await search('search-item');
  await wait('document.querySelectorAll(".file-search-panel__results li").length === 20', 'La primera página no mostró 20 resultados');
  await captureSearchPanel();
  const firstPagePaths = await cdp.evaluate('[...document.querySelectorAll(".file-search-panel__path")].map((element) => element.textContent).join("\\n")');
  if (firstPagePaths.includes('.env-search-item') || firstPagePaths.includes('ignored-search-item.txt')) throw new Error(`La búsqueda mostró un archivo protegido o ignorado: ${firstPagePaths}`);
  await click('.file-search-panel__pagination button:last-child');
  await wait('document.querySelectorAll(".file-search-panel__results li").length === 20', 'La segunda página no mostró 20 resultados');
  await click('.file-search-panel__pagination button:last-child');
  await wait('document.querySelectorAll(".file-search-panel__results li").length === 6', 'La tercera página no mostró los 6 resultados restantes');

  await search('CONTENIDO-ESPECIAL');
  await cdp.evaluate(`(() => { const select = document.querySelector('select[aria-label="Buscar en"]'); select.value = 'content'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait('document.querySelectorAll(".file-search-panel__results li").length === 3', 'La búsqueda por contenido no devolvió los archivos esperados');
  const contentPaths = await cdp.evaluate('[...document.querySelectorAll(".file-search-panel__path")].map((element) => element.textContent).join("\\n")');
  if (contentPaths.includes('.env-search-item') || contentPaths.includes('ignored-search-item.txt')) throw new Error(`Contenido protegido o ignorado apareció en resultados: ${contentPaths}`);
  await click('.file-search-panel__results li:first-child button');
  await wait('document.body.innerText.includes("CONTENIDO-ESPECIAL")', 'Seleccionar resultado no abrió el contenido en el visor');

  await openProject('files-B');
  await openFilesPanel();
  await search('search-item');
  await wait('document.querySelectorAll(".file-search-panel__results li").length === 2', 'El cambio al proyecto B no aisló los resultados');
  const projectBText = await cdp.evaluate('document.querySelector(".file-search-panel__results")?.textContent ?? ""');
  if (!projectBText.includes('search-item-b.txt') || projectBText.includes('search-item-00.txt')) throw new Error('La búsqueda de archivos mezcló proyectos A y B');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await delay(300);
  await openFilesPanel();
  await search('search-item');
  await wait('document.querySelectorAll(".file-search-panel__results li").length === 2', 'El panel desktop no mostró los resultados esperados');
  await captureSearchPanel('search-results-desktop');
  console.log(JSON.stringify({ ok: true, mode: dev ? 'dev' : 'packaged', profile, pages: [20, 20, 6], contentMatches: 3, protectedIgnored: true, projectIsolation: true }));
} finally {
  assertCleanShutdown(await stop(instance), 'Búsqueda de archivos');
}
