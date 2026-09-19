#!/usr/bin/env node
// Aceptación del primer arranque local: usa solamente el asistente visible con un perfil nuevo.
// Descarga el motor portable oficial y el primer modelo recomendado; pausa antes de inferir hasta
// que el coordinador autorice el archivo-señal, para no competir con otro harness local.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertCleanShutdown, launchAtPort, stop, waitForRenderedRoot } from './smoke-release-functional.mjs';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const PROFILE = 'N:\\smoke\\local-onboarding-023';
const CONTINUE_SIGNAL = 'N:\\smoke\\local-onboarding-023.continue-inference';
const OUTPUT_DIR = resolve('smoke/onboarding-local-023');
const EXE_PATH = resolve('apps/desktop/release/win-unpacked/SaurioLLM.exe');
const PROMPT = 'Respondé solamente: primer chat local listo.';
const RESPONSE = 'primer chat local listo.';
const phases = [];

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke onboarding local: ${message}`);
}

async function waitFor(cdp, expression, description, timeoutMs = 30_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await delay(intervalMs);
  }
  throw new Error(`Smoke onboarding local: timeout esperando ${description}`);
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

async function fill(cdp, selector, value) {
  const focused = await cdp.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) return false;
    field.focus();
    return true;
  })()`);
  assert(focused, `no se encontró ${selector}`);
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.call('Input.insertText', { text: value });
  await delay(100);
}

async function capture(cdp, name) {
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUTPUT_DIR, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  const state = await cdp.evaluate(`({ text: document.body.innerText, engine: document.querySelector('.engine-setup')?.innerText ?? null })`);
  writeFileSync(join(OUTPUT_DIR, `${name}.json`), JSON.stringify(state, null, 2));
}

async function recordPhase(cdp, label) {
  const snapshot = await cdp.evaluate(`(() => {
    const setup = document.querySelector('.engine-setup');
    const progress = setup?.querySelector('progress');
    return { text: setup?.textContent?.trim() ?? null, value: progress?.value ?? null, max: progress?.max ?? null };
  })()`);
  phases.push({ label, at: new Date().toISOString(), ...snapshot });
}

async function firstRecommendation(cdp) {
  return cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Asistente de primer arranque"]');
    const row = dialog?.querySelector('.saurio-row');
    if (!row) return null;
    const title = row.querySelector('.saurio-row__title')?.textContent?.trim() ?? null;
    return { title, text: row.textContent?.trim() ?? '' };
  })()`);
}

async function clickFirstRecommendation(cdp, text) {
  const clicked = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Asistente de primer arranque"]');
    const row = dialog?.querySelector('.saurio-row');
    const button = [...(row?.querySelectorAll('button') ?? [])]
      .find((item) => item.textContent?.trim() === ${JSON.stringify(text)} && !item.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`);
  assert(clicked, `la primera recomendación no ofreció «${text}»`);
  await delay(150);
}

async function waitForSignal() {
  console.log(JSON.stringify({
    phase: 'ready_for_inference',
    signal: CONTINUE_SIGNAL,
    note: 'Motor y modelo preparados por UI; esperando coordinación antes de iniciar inferencia.',
  }));
  const deadline = Date.now() + 2 * 60 * 60_000;
  while (Date.now() < deadline) {
    if (existsSync(CONTINUE_SIGNAL)) return;
    await delay(1_000);
  }
  throw new Error(`Smoke onboarding local: no llegó la señal de inferencia ${CONTINUE_SIGNAL}`);
}

async function forceStop(instance) {
  try { instance.cdp?.socket?.close(); } catch { /* rescate tras fallo del smoke */ }
  if (instance.child?.exitCode === null) instance.child.kill();
  const deadline = Date.now() + 3_000;
  while (instance.child?.exitCode === null && Date.now() < deadline) await delay(25);
}

assert(existsSync(EXE_PATH), `no existe el ejecutable empaquetado: ${EXE_PATH}`);
assert(!existsSync(PROFILE), `el perfil debe ser virgen y ya existe: ${PROFILE}`);
assert(!existsSync(CONTINUE_SIGNAL), `hay una señal residual: ${CONTINUE_SIGNAL}`);
mkdirSync(OUTPUT_DIR, { recursive: true });

let app;
let completed = false;
let selectedModel;
try {
  app = await launchAtPort(EXE_PATH, PROFILE);
  const { cdp } = app;
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForRenderedRoot(cdp);
  await waitFor(cdp, `document.querySelector('[role="dialog"][aria-label="Asistente de primer arranque"]') !== null`, 'el asistente en el perfil virgen');
  await waitFor(cdp, `document.body.innerText.includes('Modelos en mi PC')`, 'la ruta local del asistente');
  await clickText(cdp, 'Modelos en mi PC', '[role="dialog"]');
  await waitFor(cdp, `document.querySelector('.engine-setup') !== null`, 'la configuración del motor local');
  await waitFor(cdp, `document.body.innerText.includes('Preparar motor local')`, 'el botón de descarga oficial');
  await capture(cdp, '01-motor-inicial');

  await clickText(cdp, 'Preparar motor local', '.engine-setup');
  await waitFor(cdp, `document.querySelector('.engine-setup progress') !== null`, 'el progreso de la descarga oficial');
  await waitFor(cdp, `document.querySelector('.engine-setup progress')?.value > 0`, 'bytes recibidos del motor oficial', 120_000, 250);
  await recordPhase(cdp, 'motor-descarga-progreso');
  await capture(cdp, '02-motor-progreso');

  await clickText(cdp, 'Cancelar', '.engine-setup');
  await waitFor(cdp, `document.body.innerText.includes('Descarga cancelada') && document.body.innerText.includes('Reintentar instalación')`, 'cancelación visible del motor', 30_000, 150);
  await recordPhase(cdp, 'motor-cancelado');
  await capture(cdp, '03-motor-cancelado');

  await clickText(cdp, 'Reintentar instalación', '.engine-setup');
  await waitFor(cdp, `document.body.innerText.includes('Motor preparado') && document.body.innerText.includes('Usar motor de SaurioLLM')`, 'instalación oficial verificada y extraída', 2 * 60 * 60_000, 1_000);
  await recordPhase(cdp, 'motor-instalado');
  await capture(cdp, '04-motor-listo');

  await clickText(cdp, 'Usar motor de SaurioLLM', '.engine-setup');
  await waitFor(cdp, `document.body.innerText.includes('Ollama está corriendo')`, 'motor administrado conectado por la UI', 45_000, 200);
  await waitFor(cdp, `document.querySelector('[role="dialog"] .saurio-row') !== null`, 'recomendaciones del equipo');
  const recommendation = await firstRecommendation(cdp);
  assert(recommendation?.title, 'no apareció una recomendación descargable para este equipo');
  selectedModel = recommendation.title;
  await capture(cdp, '05-recomendacion');

  await clickFirstRecommendation(cdp, 'Descargar');
  await waitFor(cdp, `document.querySelector('[role="dialog"] .saurio-row button')?.textContent?.trim() === 'Descargando…'`, 'inicio de descarga del modelo recomendado', 30_000, 150);
  await waitFor(cdp, `document.querySelector('[role="dialog"] .saurio-progress') !== null`, 'progreso visible del modelo recomendado', 30_000, 150);
  await capture(cdp, '06-modelo-progreso');
  await waitFor(cdp, `(() => {
    const row = document.querySelector('[role="dialog"] .saurio-row');
    return [...(row?.querySelectorAll('button') ?? [])].some((button) => button.textContent?.trim() === 'Usar este modelo' && !button.disabled);
  })()`, 'modelo recomendado descargado y disponible', 2 * 60 * 60_000, 1_000);
  await capture(cdp, '07-modelo-listo');

  await clickFirstRecommendation(cdp, 'Usar este modelo');
  await waitFor(cdp, `document.querySelector('[role="dialog"][aria-label="Asistente de primer arranque"]') === null`, 'cierre del asistente tras usar el modelo');
  await waitFor(cdp, `document.querySelector('textarea[aria-label="Mensaje para el agente"]') instanceof HTMLTextAreaElement`, 'el primer chat local');
  await waitFor(cdp, `document.querySelector('.chat-input__model')?.textContent?.includes(${JSON.stringify(selectedModel)}) === true`, 'el modelo recomendado aplicado al primer chat');
  await capture(cdp, '08-primer-chat-listo');

  await waitForSignal();
  await fill(cdp, 'textarea[aria-label="Mensaje para el agente"]', PROMPT);
  await clickText(cdp, 'Enviar', '.chat-input');
  await waitFor(cdp, `(() => [...document.querySelectorAll('.message-bubble.role-assistant .message-bubble__content')]
    .some((bubble) => bubble.textContent?.includes(${JSON.stringify(RESPONSE)})))()`, 'respuesta local final del primer chat', 10 * 60_000, 500);
  await capture(cdp, '09-primer-chat-respuesta');

  const shutdown = await stop(app);
  app = undefined;
  assertCleanShutdown(shutdown, 'cierre del onboarding local');
  completed = true;
  writeFileSync(join(OUTPUT_DIR, 'resultado.json'), JSON.stringify({
    ok: true, mode: 'packaged', profile: PROFILE, selectedModel, phases, externalCalls: 'solo descargas oficiales de Ollama',
  }, null, 2));
  console.log(JSON.stringify({ ok: true, mode: 'packaged', profile: PROFILE, selectedModel, phases, screenshot: join(OUTPUT_DIR, '09-primer-chat-respuesta.png') }, null, 2));
} catch (error) {
  if (app?.cdp) {
    try { await capture(app.cdp, 'fallo'); } catch { /* el renderer puede haber cerrado */ }
  }
  writeFileSync(join(OUTPUT_DIR, 'resultado-fallo.json'), JSON.stringify({
    ok: false, error: error instanceof Error ? error.message : String(error), profile: PROFILE, selectedModel, phases,
  }, null, 2));
  throw error;
} finally {
  if (app) await forceStop(app);
  if (!completed) console.error(`Smoke onboarding local falló; se preservó el perfil aislado: ${PROFILE}`);
}
