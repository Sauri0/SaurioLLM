// Fallos de escritura simulados en IPC, sobre un perfil temporal y sin solicitudes a proveedores.
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { CdpClient, launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown } from './smoke-release-functional.mjs';
const listener = createServer();
await new Promise((done) => listener.listen(0, '127.0.0.1', done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const dev = process.argv.includes('--dev');
const profile = resolve(join('smoke/settings-errors-023', `profile-${Date.now()}`));
const instance = await launchAtPort(resolve(dev ? 'node_modules/electron/dist/electron.exe' : 'apps/desktop/release/win-unpacked/SaurioLLM.exe'), profile, [...(dev ? [resolve('apps/desktop')] : []), `--inspect=127.0.0.1:${port}`]);
const { cdp } = instance;
let main;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function click(selector) {
  const point = await cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Control ausente');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  await delay(200);
}
async function settingsTab(name) {
  await cdp.evaluate(`[...document.querySelectorAll('.saurio-settings-nav button')].find(e=>e.textContent.trim()===${JSON.stringify(name)}).setAttribute('data-settings-target','true')`);
  await click('[data-settings-target]');
  await cdp.evaluate(`document.querySelector('[data-settings-target]').removeAttribute('data-settings-target')`);
}
try {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  main = new CdpClient(targets[0].webSocketDebuggerUrl);
  await main.ready();
  await waitForRenderedRoot(cdp);
  await cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });
  await cdp.invoke('settings:set', { key: 'terminal.defaultShell', value: 'powershell' });
  await cdp.invoke('settings:set', { key: 'resources.localInference', value: { preset: 'balanced', computeMode: 'auto', numThreads: 4 } });
  const electron = `process.getBuiltinModule('module').createRequire(process.cwd()+'/inspector.cjs')('electron')`;
  await main.evaluate(`(() => {const ipc=${electron}.ipcMain;ipc.removeHandler('settings:set');ipc.handle('settings:set',()=>{throw new Error('EACCES: escritura denegada (fixture)')});ipc.removeHandler('hardware:profile');ipc.handle('hardware:profile',()=>({cpu:{name:'Fixture CPU',threads:8},ram:{totalBytes:17179869184,freeBytes:8589934592},sampledAt:Date.now()}));})()`);
  const entries = Array.from({ length: 45 }, (_, index) => ({ id: index + 1, ts: Date.now(), providerId: index % 2 ? 'provider-A' : 'provider-B', modelName: `modelo-${index}`, locality: 'cloud', runId: `run-${index}` }));
  await main.evaluate(`(() => {const ipc=${electron}.ipcMain;ipc.removeHandler('providers:auditLog');ipc.handle('providers:auditLog',()=>${JSON.stringify(entries)});})()`);
  await cdp.call('Page.reload');
  await delay(800);
  await waitForRenderedRoot(cdp);
  await cdp.evaluate(`document.querySelector('button[aria-label="Cerrar asistente"]')?.click()`);
  await click('nav button[title^="Ajustes ("]');
  await settingsTab('Motor y recursos');
  await delay(300);
  await cdp.evaluate(`document.querySelectorAll('input[name="resource-preset"]')[2].setAttribute('data-performance','true')`);
  await click('[data-performance]');
  if (!await cdp.evaluate(`document.querySelector('input[name="resource-preset"]').checked && document.querySelector('.resource-settings [role="alert"]')?.textContent.includes('EACCES')`)) throw new Error('Recursos mostró un valor que no se guardó');
  const pref = await cdp.invoke('settings:get', { key: 'resources.localInference' });
  if (pref.preset !== 'balanced') throw new Error('Fixture modificó preferencia persistida');
  await settingsTab('Aplicación y permisos');
  await cdp.evaluate(`(() => {const select=document.querySelector('select[aria-label="Terminal por defecto"]');select.value='pwsh';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await delay(250);
  if (!await cdp.evaluate(`document.querySelector('select[aria-label="Terminal por defecto"]').value==='powershell' && [...document.querySelectorAll('[role="alert"]')].some(e=>e.textContent.includes('EACCES'))`)) throw new Error('Terminal mostró un valor que no se guardó');
  await settingsTab('APIs y costos');
  await delay(250);
  if (await cdp.evaluate(`document.querySelectorAll('.saurio-providers-audit__row').length`) !== 20) throw new Error('Auditoría sin paginar');
  await click('.saurio-providers-audit__pagination button:last-child');
  await click('.saurio-providers-audit input[type="search"]');
  await cdp.call('Input.insertText', { text: 'run-44' });
  await delay(200);
  if (!await cdp.evaluate(`document.querySelectorAll('.saurio-providers-audit__row').length===1 && document.querySelector('.saurio-providers-audit__row').textContent.includes('run-44')`)) throw new Error('Filtro de auditoría no reinicia paginación');
  console.log(JSON.stringify({ ok: true, profile, simulatedWriteError: 'EACCES', preserved: ['resources.localInference', 'terminal.defaultShell'], auditRows: 45 }));
} finally {
  await main?.close();
  assertCleanShutdown(await stop(instance), 'Ajustes sin escritura');
}
