#!/usr/bin/env node
// Smoke de aceptación del watcher de Archivos. Modifica el workspace exclusivamente desde Node y
// exige que la UI refleje cada cambio sin recarga ni botón manual.
import {
  mkdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown,
} from './smoke-release-functional.mjs';

const output = resolve('smoke/files-023');
mkdirSync(output, { recursive: true });
const profile = join(output, `profile-${Date.now()}`);
const dev = process.argv.includes('--dev');
const executable = resolve(dev
  ? 'node_modules/electron/dist/electron.exe'
  : 'apps/desktop/release/win-unpacked/SaurioLLM.exe');
const instance = await launchAtPort(executable, profile, dev ? [resolve('apps/desktop')] : []);
const { cdp } = instance;
const rendererErrors = [];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

cdp.socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === 'Runtime.exceptionThrown') rendererErrors.push(message.params.exceptionDetails);
});

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke Archivos: ${message}`);
}

async function waitFor(label, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Smoke Archivos: timeout esperando ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

async function click(selector) {
  const rect = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('No existe el control: ' + ${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
}

async function clickElementBy(selector, property, expected) {
  await cdp.evaluate(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((candidate) => candidate[${JSON.stringify(property)}] === ${JSON.stringify(expected)});
    if (!element) throw new Error('No existe el control esperado: ' + ${JSON.stringify(expected)});
    document.querySelector('[data-files-smoke-target]')?.removeAttribute('data-files-smoke-target');
    element.setAttribute('data-files-smoke-target', 'true');
  })()`);
  await click('[data-files-smoke-target="true"]');
  await cdp.evaluate(`document.querySelector('[data-files-smoke-target]')?.removeAttribute('data-files-smoke-target')`);
}

async function capture(name) {
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  const state = await cdp.evaluate(`({
    text: document.body.innerText,
    treePaths: [...document.querySelectorAll('.saurio-right-panel .saurio-sidebar-item[title]')]
      .map((element) => element.getAttribute('title')),
    activeProject: document.querySelector('.saurio-project-row.active .saurio-project-row__open')?.getAttribute('title'),
  })`);
  writeFileSync(join(output, `${name}.json`), JSON.stringify(state, null, 2));
  return state;
}

async function treePaths() {
  return cdp.evaluate(`[
    ...document.querySelectorAll('.saurio-right-panel .saurio-sidebar-item[title]')
  ].map((element) => element.getAttribute('title'))`);
}

async function waitTreePath(relPath, present = true) {
  await waitFor(`${present ? 'aparición' : 'desaparición'} de ${relPath}`, async () => {
    const paths = await treePaths();
    return paths.includes(relPath) === present;
  });
}

async function waitActiveProject(projectPath) {
  await waitFor(`proyecto activo ${projectPath}`, () => cdp.evaluate(`
    document.querySelector('.saurio-project-row.active .saurio-project-row__open')?.getAttribute('title')
      === ${JSON.stringify(projectPath)}`));
}

async function switchProject(projectPath) {
  await clickElementBy('.saurio-project-row__open', 'title', projectPath);
  await waitActiveProject(projectPath);
  await waitFor('panel Archivos del proyecto cambiado', () => cdp.evaluate(`
    document.querySelector('.saurio-right-panel')?.innerText.includes('Actualización automática') === true`));
}

async function showFilesPanel() {
  await click('nav button[title^="Chats ("]');
  if (!await cdp.evaluate(`Boolean(document.querySelector('.saurio-right-panel'))`)) {
    await click('button[title="Mostrar panel de archivos, cambios y terminal"]');
  }
  const filesSelected = await cdp.evaluate(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() === 'Archivos'`);
  if (!filesSelected) await clickElementBy('[role="tab"]', 'textContent', 'Archivos');
  await waitFor('panel Archivos', () => cdp.evaluate(`
    document.querySelector('.saurio-right-panel')?.innerText.includes('Actualización automática') === true`));
  const manualRefresh = await cdp.evaluate(`[
    ...document.querySelectorAll('.saurio-right-panel button')
  ].some((button) => /actualizar|refrescar/i.test(button.textContent + ' ' + (button.title || '')))`);
  assert(!manualRefresh, 'el panel expone un botón de actualización manual; el smoke exige actualización automática');
}

let completed = false;
try {
  await cdp.call('Runtime.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 850, deviceScaleFactor: 1, mobile: false,
  });
  await waitForRenderedRoot(cdp);

  await cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });
  const projectA = await cdp.invoke('project:createManaged', { name: 'Watcher A' });
  const projectB = await cdp.invoke('project:createManaged', { name: 'Watcher B' });
  await cdp.invoke('settings:set', { key: 'ui.projects.lastProjectId', value: projectA.id });
  await cdp.call('Page.reload');
  await delay(1_500);
  await waitForRenderedRoot(cdp);
  await waitFor('restauración de Watcher A', () => cdp.evaluate(`
    document.querySelector('.saurio-project-row.active .saurio-project-row__open')?.getAttribute('title')
      === ${JSON.stringify(projectA.path)}`));
  assert(!await cdp.evaluate(`Boolean(document.querySelector('button[aria-label="Cerrar asistente"]'))`),
    'el onboarding reapareció aunque onboarding.completed estaba guardado');
  await showFilesPanel();
  await capture('initial');

  const originalFile = join(projectA.path, 'archivo-a.txt');
  const renamedFile = join(projectA.path, 'archivo-a-renombrado.txt');
  writeFileSync(originalFile, 'creado fuera de SaurioLLM\n');
  await waitTreePath('archivo-a.txt');
  renameSync(originalFile, renamedFile);
  await waitTreePath('archivo-a-renombrado.txt');
  await waitTreePath('archivo-a.txt', false);
  rmSync(renamedFile);
  await waitTreePath('archivo-a-renombrado.txt', false);

  const originalDir = join(projectA.path, 'carpeta-a');
  const renamedDir = join(projectA.path, 'carpeta-a-renombrada');
  mkdirSync(originalDir);
  writeFileSync(join(originalDir, 'interno.txt'), 'archivo anidado\n');
  await waitTreePath('carpeta-a');
  await clickElementBy('.saurio-right-panel .saurio-sidebar-item[title]', 'title', 'carpeta-a');
  await waitTreePath('carpeta-a/interno.txt');
  renameSync(originalDir, renamedDir);
  await waitTreePath('carpeta-a', false);
  await waitTreePath('carpeta-a-renombrada');
  await clickElementBy('.saurio-right-panel .saurio-sidebar-item[title]', 'title', 'carpeta-a-renombrada');
  await waitTreePath('carpeta-a-renombrada/interno.txt');
  rmSync(renamedDir, { recursive: true });
  await waitTreePath('carpeta-a-renombrada', false);

  writeFileSync(join(projectA.path, 'solo-a.txt'), 'A\n');
  await waitTreePath('solo-a.txt');
  await switchProject(projectB.path);
  await waitTreePath('solo-a.txt', false);
  writeFileSync(join(projectA.path, 'evento-tardio-a.txt'), 'A tardío\n');
  await delay(500);
  assert(!(await treePaths()).some((entry) => entry === 'evento-tardio-a.txt' || entry === 'solo-a.txt'),
    'un cambio del proyecto A apareció mientras B estaba activo');
  writeFileSync(join(projectB.path, 'solo-b.txt'), 'B\n');
  await waitTreePath('solo-b.txt');

  await switchProject(projectA.path);
  await waitTreePath('solo-a.txt');
  await waitTreePath('evento-tardio-a.txt');
  assert(!(await treePaths()).includes('solo-b.txt'), 'un archivo del proyecto B apareció al volver a A');

  assert(rendererErrors.length === 0, `hubo excepciones del renderer: ${JSON.stringify(rendererErrors)}`);
  await capture('final');
  completed = true;
  console.log(JSON.stringify({
    ok: true,
    mode: dev ? 'dev' : 'packaged',
    output,
    profile,
    projects: { a: projectA.path, b: projectB.path },
    checks: {
      automaticRefreshWithoutButton: true,
      externalFileCreateRenameDelete: true,
      externalDirectoryCreateExpandRenameDelete: true,
      projectEventsIsolated: true,
      reloadRestoredManagedProject: true,
      onboardingStayedCompleted: true,
    },
  }, null, 2));
} catch (error) {
  await capture('failure').catch(() => undefined);
  console.error(JSON.stringify({ rendererErrors, output, profile }, null, 2));
  throw error;
} finally {
  const result = await stop(instance);
  assertCleanShutdown(result, 'smoke Archivos');
  if (!completed) console.error(`Smoke Archivos falló; se preservaron perfil y capturas en ${output}`);
}
