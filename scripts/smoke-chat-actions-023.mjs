// Smoke visual del chat con fixture local: copia, regeneración, tarjetas de continuación y el
// seguimiento de scroll se ejercitan sin arrancar un modelo ni hacer llamadas pagas.
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { CdpClient, launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown } from './smoke-release-functional.mjs';

const output = resolve('smoke/chat-actions-023');
const dev = process.argv.includes('--dev');
const exe = dev ? resolve('node_modules/electron/dist/electron.exe') : resolve('apps/desktop/release/win-unpacked/SaurioLLM.exe');
if (!existsSync(exe)) throw new Error(`No existe el ejecutable para el smoke: ${exe}`);

mkdirSync(output, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'saurio-chat-actions-'));
const resolvedTempRoot = resolve(tmpdir());
const resolvedUserData = resolve(userData);
const userDataRelative = relative(resolvedTempRoot, resolvedUserData);
if (!userDataRelative || userDataRelative.startsWith('..') || /^([A-Za-z]:)?[\\/]/.test(userDataRelative)) {
  throw new Error(`El perfil temporal quedó fuera de ${resolvedTempRoot}: ${resolvedUserData}`);
}
const previousSmokeState = process.env.SAURIO_SMOKE_STATE;

const inspectorListener = createServer();
await new Promise((done, reject) => {
  inspectorListener.once('error', reject);
  inspectorListener.listen(0, '127.0.0.1', done);
});
const inspectorAddress = inspectorListener.address();
if (!inspectorAddress || typeof inspectorAddress === 'string') throw new Error('No se pudo reservar el inspector de la fixture.');
const inspectorPort = inspectorAddress.port;
await new Promise((done) => inspectorListener.close(done));

async function wait(ms) {
  await new Promise((done) => setTimeout(done, ms));
}

async function launchFixture(state) {
  process.env.SAURIO_SMOKE_STATE = JSON.stringify(state);
  const instance = await launchAtPort(exe, userData, [
    ...(dev ? [resolve('apps/desktop')] : []),
    `--inspect=127.0.0.1:${inspectorPort}`,
  ]);
  await waitForRenderedRoot(instance.cdp);
  await instance.cdp.evaluate(`document.querySelector('nav button[title^="Chats"]')?.click()`);
  await wait(800);
  return instance;
}

async function stopFixture(instance) {
  assertCleanShutdown(await stop(instance), 'chat actions');
}

async function connectMainInspector() {
  const response = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`);
  const targets = await response.json();
  const target = targets.find((item) => item.webSocketDebuggerUrl);
  if (!target) throw new Error('El inspector del proceso main no expuso un target.');
  const main = new CdpClient(target.webSocketDebuggerUrl);
  await main.ready();
  return main;
}

async function installDelayedContinueFixture(main) {
  const electron = `process.getBuiltinModule('module').createRequire(process.cwd()+'/inspector.cjs')('electron')`;
  await main.evaluate(`(() => {
    const ipc = ${electron}.ipcMain;
    ipc.removeHandler('run:continue');
    globalThis.__saurioSmokeContinueCalls = 0;
    ipc.handle('run:continue', () => new Promise((_resolve, reject) => {
      globalThis.__saurioSmokeContinueCalls += 1;
      globalThis.__saurioSmokeRejectContinue = () => reject(new Error('Continuación rechazada por la fixture.'));
    }));
  })()`);
}

async function rejectDelayedContinueFixture(main) {
  await main.evaluate(`globalThis.__saurioSmokeRejectContinue?.()`);
}

let instance;
let main;
try {
  instance = await launchFixture({ longRun: true });
  await instance.cdp.evaluate(`Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text) => { window.__saurioSmokeClipboard = text; },
      readText: async () => window.__saurioSmokeClipboard,
    },
  })`);
  await instance.cdp.evaluate(`document.querySelector('.message-bubble__copy')?.click()`);
  await wait(50);
  const copiedText = await instance.cdp.evaluate('navigator.clipboard.readText()');
  if (!copiedText?.includes('El cliente de Ollama no distingue')) throw new Error('Copiar no escribió el texto del mensaje en el portapapeles simulado.');
  await instance.cdp.evaluate(`Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => { throw new Error('Permiso denegado por la fixture.'); } },
  })`);
  await instance.cdp.evaluate(`document.querySelector('.message-bubble__copy')?.click()`);
  await wait(50);
  const copyError = await instance.cdp.evaluate(`document.querySelector('.message-bubble__copy-error')?.textContent`);
  if (!copyError?.includes('Permiso denegado por la fixture.')) throw new Error('El error de copia no quedó visible.');

  const scrollBefore = await instance.cdp.evaluate(`(() => {
    const element = document.querySelector('.chat-panel__messages');
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
    return { top: element.scrollTop, max: element.scrollHeight - element.clientHeight };
  })()`);
  if (scrollBefore.max <= 0) throw new Error('La fixture no tiene contenido suficiente para verificar scroll.');
  await instance.cdp.evaluate(`window.dispatchEvent(new Event('saurio:demo:append-message'))`);
  await wait(80);
  const topAfterNewMessage = await instance.cdp.evaluate(`document.querySelector('.chat-panel__messages').scrollTop`);
  if (topAfterNewMessage !== 0) throw new Error('Un mensaje nuevo forzó el scroll mientras se leía arriba.');
  await instance.cdp.evaluate(`(() => {
    const element = document.querySelector('.chat-panel__messages');
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  })()`);
  // El listener de React actualiza `followScroll` en el próximo render; no dispares el mensaje
  // de prueba antes de que esa actualización haya llegado al componente.
  await wait(50);
  await instance.cdp.evaluate(`window.dispatchEvent(new Event('saurio:demo:append-message'))`);
  await wait(80);
  const followState = await instance.cdp.evaluate(`(() => {
    const element = document.querySelector('.chat-panel__messages');
    return { top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight };
  })()`);
  const followed = followState.height - followState.top - followState.client <= 48;
  if (!followed) throw new Error(`El chat no volvió a seguir el fondo después de regresar al final: ${JSON.stringify(followState)}`);

  const state = await instance.cdp.evaluate(`(() => ({
    regenerate: [...document.querySelectorAll('button')].map((button) => ({ text: button.textContent?.trim(), disabled: button.disabled }))
      .filter((button) => button.text === 'Regenerar respuesta'),
    copy: document.querySelectorAll('.message-bubble__copy').length,
    continueCards: document.querySelectorAll('.interrupted-run-card, .oom-load-card').length,
    overflow: document.documentElement.scrollWidth > innerWidth,
    text: document.body.innerText,
  }))()`);
  writeFileSync(join(output, 'state.json'), JSON.stringify({ state }, null, 2));
  if (state.regenerate.length < 1 || !state.regenerate.some((button) => !button.disabled)) {
    throw new Error('No apareció la regeneración habilitada para una respuesta terminada.');
  }
  if (state.copy < 1) throw new Error('No apareció la acción Copiar en la respuesta de la fixture.');
  if (state.continueCards !== 0) throw new Error('La fixture terminada no debe mostrar tarjetas de continuación.');
  if (state.overflow) throw new Error('La pantalla del chat tiene overflow horizontal.');
  await stopFixture(instance);
  instance = undefined;
  instance = await launchFixture({ oomError: true });
  main = await connectMainInspector();
  await installDelayedContinueFixture(main);
  const clickedTwice = await instance.cdp.evaluate(`(() => {
    const button = document.querySelector('.oom-load-card__actions .saurio-btn-primary');
    if (!button) return false;
    button.click();
    button.click();
    return true;
  })()`);
  if (!clickedTwice) throw new Error('No apareció el botón de reintento OOM.');
  await wait(100);
  const retryBusy = await instance.cdp.evaluate(`(() => {
    const button = document.querySelector('.oom-load-card__actions .saurio-btn-primary');
    return { text: button?.textContent?.trim(), disabled: button?.disabled };
  })()`);
  if (retryBusy.text !== 'Reintentando…' || retryBusy.disabled !== true) {
    throw new Error(`La tarjeta no bloqueó el reintento pendiente: ${JSON.stringify(retryBusy)}`);
  }
  const continuationCalls = await main.evaluate(`globalThis.__saurioSmokeContinueCalls`);
  if (continuationCalls !== 1) throw new Error(`El doble clic creó ${continuationCalls} continuaciones en vez de una.`);
  await rejectDelayedContinueFixture(main);
  await wait(100);
  const retryError = await instance.cdp.evaluate(`document.querySelector('.oom-load-card__error')?.textContent`);
  if (!retryError?.includes('Continuación rechazada por la fixture.')) throw new Error('El rechazo de run:continue no quedó visible en la tarjeta OOM.');
  const retryRecovered = await instance.cdp.evaluate(`(() => {
    const button = document.querySelector('.oom-load-card__actions .saurio-btn-primary');
    return { text: button?.textContent?.trim(), disabled: button?.disabled };
  })()`);
  if (retryRecovered.text !== 'Reintentar con menos capas en GPU' || retryRecovered.disabled !== false) {
    throw new Error(`La tarjeta no se recuperó después del error: ${JSON.stringify(retryRecovered)}`);
  }

  writeFileSync(join(output, 'state.json'), JSON.stringify({ ok: true, state, copiedText, copyError, topAfterNewMessage, followed, retryBusy, retryRecovered, retryError }, null, 2));
  console.log(JSON.stringify({ ok: true, output, checks: { copiedText, copyError, noForcedScroll: topAfterNewMessage === 0, followed, retryBusy, retryRecovered, retryError, controls: state } }));
} finally {
  await main?.close();
  if (instance) await stopFixture(instance);
  if (previousSmokeState === undefined) delete process.env.SAURIO_SMOKE_STATE;
  else process.env.SAURIO_SMOKE_STATE = previousSmokeState;
  rmSync(userData, { recursive: true, force: true });
}
