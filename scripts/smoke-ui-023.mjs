// Navigation and viewport smoke through the packaged app's actual renderer and preload.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown } from './smoke-release-functional.mjs';

const output = resolve('smoke/ui-023');
mkdirSync(output, { recursive: true });
const dev = process.argv.includes('--dev');
const instance = await launchAtPort(resolve(dev ? 'node_modules/electron/dist/electron.exe' : 'apps/desktop/release/win-unpacked/SaurioLLM.exe'), join(output, `profile-${Date.now()}`), dev ? [resolve('apps/desktop')] : []);
const { cdp } = instance;
const errors = [];
cdp.socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
});
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function click(selector) {
  const rect = await cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw new Error('Missing control');e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
  await delay(500);
}
async function clickText(label, selector = 'button') {
  const index = await cdp.evaluate(`(() => { const all=[...document.querySelectorAll(${JSON.stringify(selector)})]; const i=all.findIndex(e=>e.textContent.trim().startsWith(${JSON.stringify(label)}));if(i<0)throw new Error('Missing text control');all[i].setAttribute('data-smoke-click','target');return i;})()`);
  if (index < 0) throw new Error(`Missing ${label}`);
  await click('[data-smoke-click="target"]');
  await cdp.evaluate(`document.querySelector('[data-smoke-click="target"]')?.removeAttribute('data-smoke-click')`);
}
async function capture(name) {
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  const state = await cdp.evaluate(`({text:document.body.innerText, width:innerWidth,height:innerHeight, scrollWidth:document.documentElement.scrollWidth, controls:[...document.querySelectorAll('button,input,select')].map(e=>({tag:e.tagName,text:e.textContent?.trim(),label:e.getAttribute('aria-label'),placeholder:e.getAttribute('placeholder')}))})`);
  writeFileSync(join(output, `${name}.json`), JSON.stringify(state, null, 2));
  if (state.scrollWidth > state.width) throw new Error(`${name}: document overflows horizontally`);
  if (/Minified React error|Maximum update depth|Algo salió mal/.test(state.text)) throw new Error(`${name}: renderer error boundary visible`);
  return state;
}
try {
  await cdp.call('Runtime.enable');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitForRenderedRoot(cdp);
  await cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });
  const project = await cdp.invoke('project:createManaged', { name: 'Proyecto de prueba visual' });
  const chat = await cdp.invoke('chat:create', { projectId: project.id, agentId: 'agent_builtin_lead', mode: 'ask', modelRef: { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' } });
  await cdp.invoke('chat:rename', { chatId: chat.id, title: 'Chat de prueba visual' });
  await cdp.invoke('settings:set', { key: 'ui.projects.lastProjectId', value: project.id });
  await cdp.call('Page.reload');
  await delay(1800);
  await waitForRenderedRoot(cdp);
  if (await cdp.evaluate(`Boolean(document.querySelector('button[aria-label="Cerrar asistente"]'))`)) await click('button[aria-label="Cerrar asistente"]');
  const states = {};
  for (const [name, title] of [['chats', 'Chats'], ['models', 'Modelos'], ['agents', 'Agentes'], ['settings', 'Ajustes']]) {
    await click(`nav button[title^="${title} ("]`);
    const active = await cdp.evaluate('document.querySelector("nav button[aria-current=page]")?.textContent?.trim()');
    if (active !== title) throw new Error(`Navigation failed: expected ${title}, got ${active}`);
    states[name] = await capture(name);
    if (name === 'chats') {
      await click('button[aria-label="Acciones para Chat de prueba visual"]');
      await capture('chat-menu');
      await clickText('Pinear', '[role="menuitem"]');
      const pins = await cdp.invoke('settings:get', { key: 'ui.chats.pinnedIds', projectId: project.id });
      if (!pins?.includes(chat.id)) throw new Error('Chat pin menu did not persist');
      if (!await cdp.evaluate(`document.activeElement?.getAttribute('aria-label')==='Acciones para Chat de prueba visual'`)) throw new Error('Pin action lost keyboard focus');
      await click('button[aria-label="Acciones para Chat de prueba visual"]');
      await clickText('Archivar', '[role="menuitem"]');
      if (!(await cdp.invoke('chat:list', { projectId: project.id })).find(item => item.id === chat.id)?.archived) throw new Error('Chat archive menu did not persist');
      if (!await cdp.evaluate(`document.activeElement?.getAttribute('placeholder')==='Buscar chats…'`)) throw new Error('Archive action did not focus stable search control');
      await click('.saurio-sidebar-archived summary');
      await clickText('Restaurar', '.saurio-sidebar-archived button');
      await click('button[aria-label="Acciones para Chat de prueba visual"]');
      await clickText('Renombrar', '[role="menuitem"]');
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await cdp.call('Input.insertText', { text: 'Chat renombrado por interfaz' });
      await clickText('Guardar', '[role="dialog"] button');
      if (!(await cdp.invoke('chat:list', { projectId: project.id })).some(item => item.id === chat.id && item.title === 'Chat renombrado por interfaz' && !item.archived)) throw new Error('Chat rename/restore did not persist');
      await click('input[placeholder="Buscar chats…"]');
      await cdp.call('Input.insertText', { text: 'sin-coincidencias-smoke' });
      await delay(100);
      if (await cdp.evaluate(`Boolean(document.querySelector('button[aria-label="Acciones para Chat renombrado por interfaz"]'))`)) throw new Error('Chat search did not filter');
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await delay(100);
      await click('button[aria-label="Acciones para Chat renombrado por interfaz"]');
      await clickText('Eliminar de la lista', '[role="menuitem"]');
      await clickText('Eliminar', '[role="dialog"] button');
      if ((await cdp.invoke('chat:list', { projectId: project.id })).some(item => item.id === chat.id)) throw new Error('Chat deletion did not persist');
      if (!await cdp.evaluate(`document.activeElement?.getAttribute('placeholder')==='Buscar chats…'`)) throw new Error('Delete dialog did not focus stable search control');
    }
  }
  await clickText('APIs y costos', '.saurio-settings-nav button');
  states.providers = await capture('providers');
  await clickText('Contexto', '.saurio-settings-nav button');
  states.context = await capture('context');
  await click('nav button[title^="Inicio ("]');
  await clickText('Crear proyecto', '.saurio-home__action');
  await cdp.call('Input.insertText', { text: 'Proyecto desde interfaz' });
  await clickText('Crear proyecto', '[role="dialog"] button');
  const projects = await cdp.invoke('project:list', undefined);
  if (!projects.some((item) => item.name === 'Proyecto desde interfaz')) throw new Error('Create project dialog did not persist project');
  if (await cdp.evaluate('Boolean(document.querySelector(".saurio-text-dialog"))')) throw new Error('Create project dialog remained open');
  states.createdProject = await capture('created-project');
  await click('nav button[title^="Agentes ("]');
  await clickText('Crear equipo base');
  const agents = await cdp.invoke('agents:list', {});
  for (const name of ['Director', 'Programador', 'Tester', 'Revisor']) if (!agents.some((agent) => agent.name === name)) throw new Error(`Missing team agent ${name}`);
  // La captura pública debe mostrar los cuatro perfiles creados por el recorrido real, no el
  // estado vacío previo al botón "Crear equipo base".
  states.agents = await capture('agents');
  await click('input[aria-label="Buscar agente"]');
  await cdp.call('Input.insertText', { text: 'Director' });
  await delay(150);
  const directorSearch = await cdp.evaluate(`({ rows:[...document.querySelectorAll('.agents-panel__row')].map(e=>e.textContent.trim()), count:document.querySelector('.agents-panel__count')?.textContent })`);
  if (directorSearch.rows.length !== 1 || !directorSearch.rows[0].includes('Director')) throw new Error('Agent name search did not narrow the list');
  await cdp.evaluate(`(() => { const select=document.querySelector('select[aria-label="Filtrar por rol"]'); if(!select)throw new Error('Missing agent role filter'); select.value='coder'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await delay(150);
  if (await cdp.evaluate(`document.querySelectorAll('.agents-panel__row').length`) !== 0) throw new Error('Agent role filter did not combine with search');
  if (!await cdp.evaluate(`document.body.innerText.includes('No hay agentes que coincidan')`)) throw new Error('Agent empty filter state missing');
  await clickText('Limpiar', '.agents-panel__filters button');
  await delay(150);
  const clearedAgents = await cdp.evaluate(`({ rows:document.querySelectorAll('.agents-panel__row').length, role:document.querySelector('select[aria-label="Filtrar por rol"]')?.value, query:document.querySelector('input[aria-label="Buscar agente"]')?.value })`);
  if (clearedAgents.rows !== agents.length || clearedAgents.role !== 'all' || clearedAgents.query !== '') throw new Error('Agent filter clear did not restore the list');
  await clickText('+ Nuevo agente', '.agents-panel__actions button');
  const editor = await cdp.evaluate(`(() => { const dialog=document.querySelector('[role="dialog"][aria-label="Nuevo agente"]');return {auto:[...dialog.querySelectorAll('label')].some(e=>e.textContent.includes('Automático')&&e.querySelector('input')?.checked),instructions:Boolean(dialog.querySelector('textarea[placeholder="Cómo querés que trabaje este agente"]'))};})()`);
  if (!editor.auto || !editor.instructions) throw new Error('New agent must expose automatic recommendations and editable instructions');
  await cdp.evaluate(`(() => { const select=document.querySelector('[role="dialog"] select');select.value='programmer';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const recommendationDeadline = Date.now() + 10_000;
  while (!await cdp.evaluate(`Boolean(document.querySelector('.agent-editor__recommendation'))`)) {
    if (Date.now() >= recommendationDeadline) throw new Error('Offline engine must still allow catalog recommendations for a programmer');
    await delay(150);
  }
  states.agentEditor = await capture('agent-editor');
  await clickText('Cancelar', '[role="dialog"] button');
  const directorOpen = await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.agents-panel__row')].find((candidate) => candidate.textContent.includes('Director'));
    const button = [...(row?.querySelectorAll('button') ?? [])].find((candidate) => candidate.textContent.trim() === 'Abrir chat');
    if (!button) throw new Error('Missing Director open-chat control');
    button.setAttribute('data-smoke-director-open', 'true');
    return true;
  })()`);
  if (!directorOpen) throw new Error('Director open-chat control unavailable');
  await click('[data-smoke-director-open]');
  await cdp.evaluate(`document.querySelector('[data-smoke-director-open]')?.removeAttribute('data-smoke-director-open')`);
  states.team = await capture('team');
  const director = agents.find(agent => agent.name === 'Director');
  const tester = agents.find(agent => agent.name === 'Tester');
  const managed = projects.find(item => item.name === 'Proyecto desde interfaz');
  // "Abrir chat" usa chatStore y ya dejó el chat en la vista. Crear otro por IPC después de
  // eso persiste una fila fuera de la store del renderer y convierte este smoke en una prueba
  // de sincronización accidental, no del recorrido de interfaz.
  const teamChat = (await cdp.invoke('chat:list', { projectId: managed.id })).find((item) => item.agentId === director?.id && !item.archived);
  if (!teamChat) throw new Error('Abrir chat no creó el chat del Director');
  if (!await cdp.evaluate(`Boolean(document.querySelector('.chat-collaborators'))`)) throw new Error('Abrir chat no dejó visible el panel del chat');
  await click('.chat-collaborators summary');
  const testerIndex = await cdp.evaluate(`(() => { const labels=[...document.querySelectorAll('.chat-collaborators label')]; const label=labels.find(e=>e.textContent.includes('Tester'));if(!label)throw new Error('Missing Tester checkbox');label.querySelector('input').setAttribute('data-smoke-tester','true');return true;})()`);
  if (!testerIndex) throw new Error('Tester unavailable');
  await click('[data-smoke-tester]');
  const collaborators = await cdp.invoke('agents:collaborators:get', { chatId: teamChat.id, projectId: managed.id });
  if (!collaborators.agentIds.includes(tester.id)) throw new Error('Collaborator checkbox did not persist');
  states.collaborators = await capture('collaborators');
  await click('textarea[aria-label="Mensaje para el agente"]');
  await cdp.call('Input.insertText', { text: 'Este borrador debe conservarse si no hay modelo.' });
  await click('.chat-input__send');
  const retainedDraft = await cdp.evaluate(`document.querySelector('textarea[aria-label="Mensaje para el agente"]')?.value`);
  if (retainedDraft !== 'Este borrador debe conservarse si no hay modelo.') throw new Error('Failed send discarded the draft');
  if (!await cdp.evaluate(`document.querySelector('.chat-input [role="alert"]')?.textContent?.includes('modo automático no encontró un modelo local')`)) throw new Error('Failed send did not display the automatic-model availability error');
  states.failedSend = await capture('failed-send');
  await click('nav button[title^="Ajustes ("]');
  await clickText('Motor y recursos', '.saurio-settings-nav button');
  await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 640, deviceScaleFactor: 1, mobile: false });
  states.compact = await capture('settings-compact');
  if (errors.length) throw new Error(`Renderer exceptions: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ ok: true, output, screens: Object.keys(states), exceptions: errors.length }));
} catch (error) {
  await capture('failure').catch(() => undefined);
  console.error(JSON.stringify({ rendererErrors: errors }));
  throw error;
} finally {
  const result = await stop(instance);
  assertCleanShutdown(result, 'UI smoke');
}
