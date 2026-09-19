// Perfil aislado; zoom real de webContents mediante inspector de main, nunca CSS que simule zoom.
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CdpClient, launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown } from './smoke-release-functional.mjs';

const output = resolve('smoke/accessibility-023');
mkdirSync(output, { recursive: true });
const dev = process.argv.includes('--dev');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const listener = createServer();
await new Promise((done) => listener.listen(0, '127.0.0.1', done));
const inspectorPort = listener.address().port;
await new Promise((done) => listener.close(done));
const instance = await launchAtPort(
  resolve(dev ? 'node_modules/electron/dist/electron.exe' : 'apps/desktop/release/win-unpacked/SaurioLLM.exe'),
  join(output, `profile-${Date.now()}`),
  [...(dev ? [resolve('apps/desktop')] : []), `--inspect=127.0.0.1:${inspectorPort}`],
);
const { cdp } = instance;
let main;
const report = [];
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers });
  await delay(80);
}
async function click(selector) {
  const point = await cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing ${selector}');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  await delay(150);
}
async function waitForVisibleSidebarChat() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = await cdp.evaluate(`(() => {
      const chat = [...document.querySelectorAll('.saurio-sidebar [role="button"].saurio-sidebar-item')]
        .find((element) => element.getClientRects().length > 0);
      if (!chat) return false;
      chat.setAttribute('data-accessibility-chat', 'true');
      return true;
    })()`);
    if (found) return;
    await delay(50);
  }
  throw new Error('La barra lateral no mostró una fila de chat seleccionable en vista compacta.');
}
try {
  const targets = await (await fetch(`http://127.0.0.1:${inspectorPort}/json/list`)).json();
  main = new CdpClient(targets[0].webSocketDebuggerUrl);
  await main.ready();
  const windowExpression = `process.getBuiltinModule('module').createRequire(process.cwd() + '/inspector.cjs')('electron').BrowserWindow.getAllWindows()[0]`;
  await main.evaluate(`${windowExpression}.setContentSize(1280, 720)`);
  await waitForRenderedRoot(cdp);
  await cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });
  const project = await cdp.invoke('project:createManaged', { name: 'Accesibilidad' });
  const chat = await cdp.invoke('chat:create', { projectId: project.id, agentId: 'agent_builtin_lead', mode: 'agent', modelRef: { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' } });
  await cdp.invoke('settings:set', { key: 'ui.projects.lastChatId', value: chat.id });
  await cdp.invoke('settings:set', { key: 'ui.projects.lastProjectId', value: project.id });
  await cdp.call('Page.reload');
  await delay(1000);
  await waitForRenderedRoot(cdp);
  await cdp.evaluate(`document.querySelector('button[aria-label="Cerrar asistente"]')?.click()`);
  await click('nav button[title^="Agentes ("]');
  await cdp.evaluate(`[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Nuevo agente')).setAttribute('data-keyboard-opener','true')`);
  await click('[data-keyboard-opener]');
  const dialog = '[role="dialog"][aria-label="Nuevo agente"]';
  if (!await cdp.evaluate(`document.activeElement === document.querySelector('${dialog} input')`)) throw new Error('Agent dialog initial focus missing');
  await key('Tab', 'Tab', 9, 8);
  if (!await cdp.evaluate(`(() => {const controls=[...document.querySelectorAll('${dialog} button:not([disabled]), ${dialog} input:not([disabled]), ${dialog} select:not([disabled]), ${dialog} textarea:not([disabled])')].filter(e=>e.getClientRects().length);return document.activeElement===controls.at(-1);})()`)) throw new Error('Shift Tab escaped agent dialog');
  await key('Tab', 'Tab', 9);
  if (!await cdp.evaluate(`document.activeElement === document.querySelector('${dialog} input')`)) throw new Error('Tab did not wrap agent dialog');
  await cdp.evaluate(`document.querySelector('${dialog} button').focus()`);
  await key('2', 'Digit2', 50, 2);
  if (!await cdp.evaluate(`Boolean(document.querySelector('${dialog}')) && document.querySelector('nav button[aria-current="page"]').textContent.trim()==='Agentes'`)) throw new Error('Navigation shortcut escaped modal');
  await key('Escape', 'Escape', 27);
  if (!await cdp.evaluate(`!document.querySelector('${dialog}') && document.activeElement===document.querySelector('[data-keyboard-opener]')`)) throw new Error('Agent dialog Escape/restore failed');
  await click('nav button[title^="Chats ("]');
  await cdp.evaluate(`document.querySelector('button[aria-label^="Acciones para"]').setAttribute('data-chat-opener','true')`);
  await click('[data-chat-opener]');
  await cdp.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes('Renombrar')).setAttribute('data-rename','true')`);
  await click('[data-rename]');
  await key('Escape', 'Escape', 27);
  if (!await cdp.evaluate(`!document.querySelector('[role="dialog"]') && document.activeElement===document.querySelector('[data-chat-opener]')`)) throw new Error('Rename dialog lost menu trigger focus');
  if (await cdp.evaluate(`Boolean(document.querySelector('.saurio-context-rail'))`)) await click('.saurio-context-rail');
  await click('.saurio-context-panel__close');
  if (!await cdp.evaluate(`Boolean(document.querySelector('.saurio-context-rail')) && !document.querySelector('.saurio-right-panel')`)) throw new Error('Desktop context close failed');
  console.log('Keyboard: modal focus, Tab/Shift+Tab, Escape, blocked background shortcut, rename trigger restoration passed');
  for (const zoom of [1.25, 1.5, 2]) {
    await main.evaluate(`${windowExpression}.webContents.setZoomFactor(${zoom})`);
    await delay(250);
    for (const section of ['Chats', 'Modelos', 'Agentes', 'Ajustes']) {
      await cdp.evaluate(`document.querySelector('nav button[title^="${section} ("]').click()`);
      await delay(350);
      if (section === 'Chats' && !await cdp.evaluate(`Boolean(document.querySelector('textarea[aria-label="Mensaje para el agente"]'))`)) throw new Error('Active chat missing from zoom test');
      if (section === 'Chats') {
        const input = await cdp.evaluate(`(() => {const r=document.querySelector('textarea[aria-label="Mensaje para el agente"]').getBoundingClientRect();const s=document.querySelector('.chat-input__send').getBoundingClientRect();return {width:r.width,height:r.height,bottom:r.bottom,sendVisible:s.width>0&&s.bottom<=innerHeight&&s.right<=innerWidth};})()`);
        if (input.width < 250 || input.height < 35) throw new Error(`Chat input unusable at ${zoom}: ${JSON.stringify(input)}`);
        if (!input.sendVisible) throw new Error(`Send control inaccessible at ${zoom}`);
        await click('.saurio-compact-tabs button:first-child');
        if (!await cdp.evaluate(`document.querySelector('.saurio-sidebar').getBoundingClientRect().width>250`)) throw new Error('Compact project list inaccessible');
        await waitForVisibleSidebarChat();
        await click('[data-accessibility-chat]');
        await cdp.evaluate(`document.querySelector('[data-accessibility-chat]')?.removeAttribute('data-accessibility-chat')`);
        if (!await cdp.evaluate(`document.querySelector('textarea[aria-label="Mensaje para el agente"]').getBoundingClientRect().width>250`)) throw new Error('Selecting a chat does not reveal conversation');
        await click('.saurio-compact-tabs button:last-child');
        if (!await cdp.evaluate(`document.querySelector('.saurio-right-panel').getBoundingClientRect().width>250`)) throw new Error('Compact files inaccessible');
        await click('.saurio-right-panel button[role="tab"]');
        await key('ArrowRight', 'ArrowRight', 39);
        if (!await cdp.evaluate(`document.activeElement.textContent.trim()==='Cambios' && document.activeElement.getAttribute('aria-selected')==='true'`)) throw new Error('Context tabs not keyboard accessible');
        await click('.saurio-context-panel__close');
        if (!await cdp.evaluate(`document.querySelector('textarea[aria-label="Mensaje para el agente"]').getBoundingClientRect().width>250`)) throw new Error('Closing files does not reveal conversation');
      }
      const state = await cdp.evaluate(`({ width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth, controls:[...document.querySelectorAll('button,input,select,textarea')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {label:e.getAttribute('aria-label')||e.textContent?.trim()||e.placeholder,x:r.x,right:r.right,y:r.y,bottom:r.bottom}}) })`);
      const actualZoom = await main.evaluate(`${windowExpression}.webContents.getZoomFactor()`);
      const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
      const name = `${section.toLowerCase()}-${zoom * 100}`;
      writeFileSync(join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
      const outside = state.controls.filter((control) => control.right > state.width + 1 || control.x < -1);
      report.push({ section, zoom: actualZoom, width: state.width, height: state.height, scrollWidth: state.scrollWidth, outside });
    }
  }
  await main.evaluate(`${windowExpression}.webContents.setZoomFactor(1)`);
  await delay(350);
  await click('nav button[title^="Chats ("]');
  if (!await cdp.evaluate(`Boolean(document.querySelector('.saurio-context-rail')) && !document.querySelector('.saurio-right-panel')`)) throw new Error(`Compact navigation altered desktop panel preference: ${JSON.stringify(await cdp.evaluate(`({nav:document.querySelector('nav button[aria-current="page"]')?.textContent, prefs:localStorage.getItem('saurio-ui-nav'), width:innerWidth, pane:document.querySelector('.saurio-chats-view')?.className})`))}`);
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, report }));
  if (report.some((item) => item.outside.length || item.scrollWidth > item.width)) process.exitCode = 1;
} finally {
  await main?.close();
  assertCleanShutdown(await stop(instance), 'Accesibilidad');
}
