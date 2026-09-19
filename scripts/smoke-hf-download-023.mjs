#!/usr/bin/env node
// Aceptación real de importación GGUF desde Hugging Face por los controles visibles del Centro de modelos.
// Reutiliza el perfil local aislado ya preparado; no ejecuta inferencia ni toca el Ollama del usuario.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { assertCleanShutdown, launchAtPort, stop, waitForRenderedRoot } from './smoke-release-functional.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const PROFILE = 'N:\\smoke\\local-onboarding-023';
const EXE_PATH = resolve('apps/desktop/release/win-unpacked/SaurioLLM.exe');
const OUTPUT_DIR = resolve('smoke/hf-download-023', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const DB_PATH = join(PROFILE, 'saurio.db');
const QUERY = 'Qwen2.5-Coder-1.5B-Instruct-GGUF';
const REPO = 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF';
const QUANT = 'Q8_0';

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke HF download: ${message}`);
}

async function waitFor(cdp, expression, description, timeoutMs = 30_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await delay(intervalMs);
  }
  throw new Error(`Smoke HF download: timeout esperando ${description}`);
}

async function clickText(cdp, text, rootSelector) {
  const clicked = await cdp.evaluate(`(() => {
    const root = ${rootSelector ? `document.querySelector(${JSON.stringify(rootSelector)})` : 'document'};
    const button = [...(root?.querySelectorAll('button') ?? [])]
      .find((item) => item.textContent?.trim() === ${JSON.stringify(text)} && !item.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`);
  assert(clicked, `no se encontró el botón habilitado «${text}»`);
  await delay(150);
}

async function clickNav(cdp, text) {
  const clicked = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.saurio-nav-rail .saurio-nav-item')]
      .find((item) => item.textContent?.trim() === ${JSON.stringify(text)});
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, `no se encontró la navegación principal «${text}»`);
  await waitFor(cdp, `document.querySelector('.saurio-nav-rail .saurio-nav-item[aria-current="page"]')?.textContent?.trim() === ${JSON.stringify(text)}`,
    `la navegación a ${text}`);
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
  await delay(100);
}

async function selectQuantization(cdp, selector, quantization) {
  const selected = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLSelectElement)) return null;
    const option = [...element.options].find((candidate) => candidate.value.toLowerCase() === ${JSON.stringify(quantization.toLowerCase())});
    if (!option) return null;
    element.focus();
    element.value = option.value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return option.value;
  })()`);
  assert(selected, `el filtro ${selector} no ofrece ${quantization}`);
  await delay(150);
  return selected;
}

async function capture(cdp, name) {
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUTPUT_DIR, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  const state = await cdp.evaluate('({ text: document.body.innerText })');
  writeFileSync(join(OUTPUT_DIR, `${name}.json`), JSON.stringify(state, null, 2));
}

/** Lee sólo el historial persistido para correlacionar una fila UI con SU intento nuevo. La acción
 * sigue siendo íntegramente por UI/CDP: este helper evita confundir reintentos HF históricos que
 * comparten la misma referencia visible. */
function persistedHfJobs(reference) {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`
      SELECT id, model_name AS modelName, status, total, completed, started_at AS startedAt,
             finished_at AS finishedAt, error
      FROM downloads
      WHERE model_name = ?
      ORDER BY started_at DESC
    `).all(reference);
  } finally {
    db.close();
  }
}

async function waitForFreshPersistedJob(reference, knownIds, description, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = persistedHfJobs(reference).find((job) => !knownIds.has(job.id));
    if (fresh) return fresh;
    await delay(150);
  }
  throw new Error(`Smoke HF download: timeout esperando ${description}`);
}

async function waitForRetriedPersistedJob(reference, priorJob, knownIds, description, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = persistedHfJobs(reference);
    // DownloadManager reutiliza el id lógico al reintentar. La fila SQLite conserva started_at de su
    // creación, por lo que el cambio terminal cancelled -> running identifica el nuevo intento.
    // También se aceptan ids nuevos para mantener el smoke compatible con historiales anteriores.
    const retried = jobs.find((job) => !knownIds.has(job.id)
      || (job.id === priorJob.id && priorJob.status === 'cancelled' && job.status === 'running'));
    if (retried) return retried;
    await delay(150);
  }
  throw new Error(`Smoke HF download: timeout esperando ${description}`);
}

async function waitForPersistedStatus(reference, id, statuses, description, timeoutMs = 45_000) {
  const accepted = new Set(statuses);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = persistedHfJobs(reference).find((candidate) => candidate.id === id);
    if (job && accepted.has(job.status)) return job;
    await delay(150);
  }
  throw new Error(`Smoke HF download: timeout esperando ${description}`);
}

async function waitForPersistedProgress(reference, id, description, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = persistedHfJobs(reference).find((candidate) => candidate.id === id);
    if (job && (job.completed > 0 || ['done', 'failed', 'cancelled', 'insufficient_space'].includes(job.status))) return job;
    await delay(150);
  }
  throw new Error(`Smoke HF download: timeout esperando ${description}`);
}

async function visibleHfRows(cdp, reference) {
  return cdp.evaluate(`(() => [...document.querySelectorAll('.saurio-row-list > .saurio-row')]
    .map((row, index) => ({
      index,
      title: row.querySelector('.saurio-row__title')?.textContent?.trim() ?? '',
      text: row.textContent?.trim() ?? '',
      buttons: [...row.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? ''),
    }))
    .filter((row) => row.title === ${JSON.stringify(reference)}))()`);
}

async function forceStop(instance) {
  try { instance.cdp?.socket?.close(); } catch { /* rescate tras un fallo de smoke */ }
  if (instance.child?.exitCode === null) instance.child.kill();
  const deadline = Date.now() + 3_000;
  while (instance.child?.exitCode === null && Date.now() < deadline) await delay(25);
}

assert(existsSync(PROFILE), `no existe el perfil aislado preparado: ${PROFILE}`);
assert(existsSync(EXE_PATH), `no existe el ejecutable empaquetado: ${EXE_PATH}`);
mkdirSync(OUTPUT_DIR, { recursive: true });
let app;
let completed = false;
let fileInfo;
let selectedQuantization;
try {
  app = await launchAtPort(EXE_PATH, PROFILE);
  const { cdp } = app;
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForRenderedRoot(cdp);
  // AppLayout restaura el último proyecto de forma asíncrona y, al terminar, vuelve a Chats. La
  // navegación del smoke empieza después de que el chat restaurado ya está montado para que esa
  // restauración no pise un clic humano posterior en la barra principal.
  await waitFor(cdp, `document.querySelector('.chat-input') !== null`, 'la restauración del chat del perfil');
  await delay(750);

  await clickNav(cdp, 'Ajustes');
  await waitFor(cdp, `document.querySelector('.saurio-settings-panel') !== null`, 'Ajustes');
  await clickText(cdp, 'Motor y recursos', '.saurio-settings-nav');
  await waitFor(cdp, `document.querySelector('.engine-setup') !== null`, 'la tarjeta de motor local');
  await waitFor(cdp, `document.body.innerText.includes('Usar motor de SaurioLLM')`, 'la opción administrada existente');
  await clickText(cdp, 'Usar motor de SaurioLLM', '.engine-setup');
  await waitFor(cdp, `(() => {
    const engine = document.querySelector('.engine-setup')?.textContent ?? '';
    return engine.includes('Motor actual: administrado por SaurioLLM') && !engine.includes('Conectando motor…');
  })()`, 'la conexión del motor administrado terminada por UI', 45_000, 200);
  await capture(cdp, '01-motor-administrado');

  await clickNav(cdp, 'Modelos');
  await waitFor(cdp, `document.querySelector('.saurio-subtabs') !== null`, 'el Centro de modelos');
  await clickText(cdp, 'Explorar', '.saurio-subtabs');
  await waitFor(cdp, `document.querySelector('.saurio-explore__source-tabs') !== null`, 'la pestaña Explorar');
  await clickText(cdp, 'Hugging Face', '.saurio-explore__source-tabs');
  const searchSelector = 'input[placeholder^="Buscar en Hugging Face"]';
  await waitFor(cdp, `document.querySelector(${JSON.stringify(searchSelector)}) instanceof HTMLInputElement`, 'la búsqueda Hugging Face');
  await fill(cdp, searchSelector, QUERY);
  await clickText(cdp, 'Buscar', '.saurio-explore__hf');
  await waitFor(cdp, `document.querySelector('.saurio-explore__hf .saurio-row__title')?.textContent?.includes(${JSON.stringify(REPO)}) === true`, 'el repositorio real esperado en los resultados', 45_000, 200);
  await capture(cdp, '02-resultados-hf');

  const repoClicked = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.saurio-explore__hf .saurio-row')]
      .find((item) => item.querySelector('.saurio-row__title')?.textContent?.trim() === ${JSON.stringify(REPO)});
    const button = row?.querySelector('.saurio-row__title-btn');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`);
  assert(repoClicked, `no se pudo abrir el repositorio ${REPO} desde la UI`);
  await waitFor(cdp, `document.querySelector('[aria-label="Filtrar archivos Hugging Face por cuantización"]') instanceof HTMLSelectElement`, 'los filtros de variantes GGUF', 45_000, 200);
  selectedQuantization = await selectQuantization(cdp, '[aria-label="Filtrar archivos Hugging Face por cuantización"]', QUANT);
  await waitFor(cdp, `(() => [...document.querySelectorAll('.saurio-explore__hf .saurio-filter-chip')]
    .some((button) => button.textContent?.trim().toLowerCase().startsWith(${JSON.stringify(QUANT.toLowerCase())})))()`, 'la variante Q8_0 filtrada');
  const variantClicked = await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('.saurio-explore__hf .saurio-filter-chip')]
      .find((item) => item.textContent?.trim().toLowerCase().startsWith(${JSON.stringify(QUANT.toLowerCase())}));
    if (!(button instanceof HTMLButtonElement)) return null;
    button.click();
    return button.textContent?.trim() ?? null;
  })()`);
  assert(variantClicked, 'no se pudo seleccionar Q8_0 desde la UI');
  fileInfo = await cdp.evaluate(`(() => {
    const selected = [...document.querySelectorAll('.saurio-explore__hf .saurio-row__line')]
      .find((item) => item.textContent?.includes(${JSON.stringify(`hf.co/${REPO}:${selectedQuantization}`)}));
    return selected?.textContent?.trim() ?? null;
  })()`);
  assert(fileInfo, 'la UI no mostró la referencia HF seleccionada');
  await capture(cdp, '03-q8-seleccionado');

  const hfReference = `hf.co/${REPO}:${selectedQuantization}`;
  const knownJobIds = new Set(persistedHfJobs(hfReference).map((job) => job.id));
  await clickText(cdp, 'Descargar', '.saurio-explore__hf');
  await clickText(cdp, 'Descargas', '.saurio-subtabs');
  const freshJob = await waitForFreshPersistedJob(hfReference, knownJobIds, 'el nuevo job HF persistido');
  await waitFor(cdp, `(() => [...document.querySelectorAll('.saurio-row__title')]
    .some((item) => item.textContent?.trim() === ${JSON.stringify(`hf.co/${REPO}:${selectedQuantization}`)}))()`, 'el trabajo HF en Descargas');
  // DownloadsTab antepone cada evento nuevo; la fila visible no expone el id, por eso el id/fecha se
  // certifican en SQLite y se captura la lista completa para correlación humana sin confundir fallos viejos.
  const firstRows = await visibleHfRows(cdp, hfReference);
  assert(firstRows.length > 0, 'no apareció la fila HF nueva en Descargas');
  const activeJob = await waitForPersistedStatus(hfReference, freshJob.id, ['running', 'done', 'failed'], 'el estado inicial del nuevo job HF');
  const progressJob = activeJob.status === 'running'
    ? await waitForPersistedProgress(hfReference, freshJob.id, 'el progreso del job HF')
    : activeJob;
  const cancellationControlExposed = (await visibleHfRows(cdp, hfReference))
    .some((row) => row.buttons.includes('Cancelar'));
  await capture(cdp, '04-progreso-hf');
  let completionJob = freshJob;
  let cancellationRetried = false;
  if (cancellationControlExposed && progressJob.status === 'running' && progressJob.completed > 0) {
    const cancelled = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.saurio-row-list > .saurio-row')].find((item) =>
        item.querySelector('.saurio-row__title')?.textContent?.trim() === ${JSON.stringify(hfReference)}
        && [...item.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Cancelar'));
      const button = [...(row?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === 'Cancelar');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    assert(cancelled, 'la UI mostró Cancelar pero no se pudo accionarlo en el job nuevo');
    const cancelledJob = await waitForPersistedStatus(hfReference, freshJob.id, ['cancelled'], 'la cancelación persistida del job nuevo');
    await capture(cdp, '05-cancelado');
    await waitFor(cdp, `(() => [...document.querySelectorAll('.saurio-row-list > .saurio-row')]
      .some((row) => row.querySelector('.saurio-row__title')?.textContent?.trim() === ${JSON.stringify(hfReference)}
        && [...row.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Reintentar')))()`, 'Reintentar para el job cancelado', 45_000, 200);
    const retried = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.saurio-row-list > .saurio-row')].find((item) =>
        item.querySelector('.saurio-row__title')?.textContent?.trim() === ${JSON.stringify(hfReference)}
        && [...item.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Reintentar'));
      const button = [...(row?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.trim() === 'Reintentar');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    assert(retried, 'la UI mostró Reintentar pero no se pudo accionarlo para el job cancelado');
    completionJob = await waitForRetriedPersistedJob(hfReference, cancelledJob, knownJobIds, 'el nuevo intento del reintento HF');
    await waitForPersistedProgress(hfReference, completionJob.id, 'el progreso luego de reintentar');
    cancellationRetried = true;
    await capture(cdp, '06-reintento-hf');
  }
  const finalJob = await waitForPersistedStatus(hfReference, completionJob.id, ['done', 'failed', 'cancelled', 'insufficient_space'], 'la finalización del job HF', 2 * 60 * 60_000);
  assert(finalJob.status === 'done', `el job HF ${completionJob.id} terminó como ${finalJob.status}${finalJob.error ? `: ${finalJob.error}` : ''}`);
  await waitFor(cdp, `document.body.innerText.includes('completa') && document.body.innerText.includes(${JSON.stringify(`hf.co/${REPO}:${selectedQuantization}`)})`, 'descarga HF completada', 45_000, 200);
  await capture(cdp, '05-hf-completo');

  await clickText(cdp, 'Instalados', '.saurio-subtabs');
  await waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(`hf.co/${REPO}:${selectedQuantization}`)})`, 'inventario que incluye el GGUF importado', 45_000, 200);
  await capture(cdp, '07-inventario-hf');

  const shutdown = await stop(app);
  app = undefined;
  assertCleanShutdown(shutdown, 'cierre del smoke Hugging Face');
  completed = true;
  writeFileSync(join(OUTPUT_DIR, 'resultado.json'), JSON.stringify({
    ok: true, mode: 'packaged', repo: REPO, requestedQuantization: QUANT, selectedQuantization, selectedFileUi: variantClicked, fileInfo,
    job: { id: completionJob.id, startedAt: completionJob.startedAt, initialJobId: freshJob.id, initialStatus: activeJob.status, progressStatus: progressJob.status, finalStatus: finalJob.status },
    cancellationControlExposed, cancellationRetried, inferenceRequests: 0,
  }, null, 2));
  console.log(JSON.stringify({ ok: true, mode: 'packaged', repo: REPO, requestedQuantization: QUANT, selectedQuantization, selectedFileUi: variantClicked,
    cancellationControlExposed, cancellationRetried, screenshot: join(OUTPUT_DIR, '07-inventario-hf.png') }, null, 2));
} catch (error) {
  if (app?.cdp) {
    try { await capture(app.cdp, 'fallo'); } catch { /* renderer cerrado */ }
  }
  writeFileSync(join(OUTPUT_DIR, 'resultado-fallo.json'), JSON.stringify({
    ok: false, error: error instanceof Error ? error.message : String(error), repo: REPO, requestedQuantization: QUANT, selectedQuantization, fileInfo,
  }, null, 2));
  throw error;
} finally {
  if (app) await forceStop(app);
  if (!completed) console.error(`Smoke HF download falló; se preservó el perfil aislado: ${PROFILE}`);
}
