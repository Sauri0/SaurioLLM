// Uso: node --import tsx scripts/smoke-chat-search-023.mjs [--dev]
// Siembra únicamente un perfil temporal, sin llamadas a modelos.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDriver } from '../packages/runtime/src/persistence/driver.ts';
import { runMigrations } from '../packages/runtime/src/persistence/migrations/index.ts';
import { createRepositories } from '../packages/runtime/src/persistence/repositories/index.ts';
import { launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown } from './smoke-release-functional.mjs';

const output = resolve('smoke/chat-search-023');
const profile = join(output, `profile-${Date.now()}`);
mkdirSync(profile, { recursive: true });
const driver = openDriver(join(profile, 'saurio.db'));
runMigrations(driver);
const repos = createRepositories(driver);
const agent = await repos.agents.createProfile({ name: 'Buscador', role: 'custom', modelMode: 'auto', permissionPreset: 'balanced' });
for (const id of ['search-A', 'search-B']) {
  const path = join(profile, id);
  mkdirSync(path);
  await repos.projects.create({ id, path, name: id, createdAt: 1, lastOpenedAt: 1 });
}
for (let index = 0; index < 24; index++) {
  const id = `search-${index}`;
  const projectId = index === 23 ? 'search-B' : 'search-A';
  await repos.chats.create({ id, projectId, title: `Informe ${index}`, agentId: agent.id, mode: 'agent', modelSelection: 'auto', createdAt: 1, updatedAt: Date.now(), archived: index === 22 });
  await repos.messages.append(id, { id: `msg-${index}`, role: 'user', content: `La palabra girasol aparece únicamente en el mensaje ${index}.` });
}
await repos.settings.set('onboarding.completed', true);
await repos.settings.set('ui.projects.lastProjectId', 'search-A');
await repos.settings.set('ui.projects.lastChatId', 'search-0');
driver.close();
const dev = process.argv.includes('--dev');
const instance = await launchAtPort(resolve(dev ? 'node_modules/electron/dist/electron.exe' : 'apps/desktop/release/win-unpacked/SaurioLLM.exe'), profile, dev ? [resolve('apps/desktop')] : []);
const { cdp } = instance;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function wait(expression, label) {
  const deadline = Date.now() + 10000;
  while (!await cdp.evaluate(expression)) {
    if (Date.now() > deadline) throw new Error(label);
    await delay(100);
  }
}
async function click(selector) {
  const point = await cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Control ausente');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  await delay(150);
}
try {
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitForRenderedRoot(cdp);
  await wait(`Boolean(document.querySelector('input[placeholder="Buscar chats…"]'))`, 'Sidebar no cargó');
  if (await cdp.evaluate(`document.querySelector('.saurio-compact-tabs')?.getBoundingClientRect().width>0`)) await click('.saurio-compact-tabs button:first-child');
  await click('input[placeholder="Buscar chats…"]');
  await cdp.call('Input.insertText', { text: 'girasol' });
  await wait(`document.querySelectorAll('.saurio-chat-search__result').length===20`, 'Contenido no aparece en primera página');
  const bounds = await cdp.evaluate(`(() => {const panel=document.querySelector('.saurio-sidebar').getBoundingClientRect();return [...document.querySelectorAll('.saurio-chat-search button,.saurio-chat-search input')].every(e=>{const r=e.getBoundingClientRect();return r.right<=panel.right+1 && r.left>=panel.left-1});})()`);
  if (!bounds) throw new Error('Controles de búsqueda desbordan la barra lateral');
  if (!await cdp.evaluate(`(() => {const header=document.querySelector('.chat-header').getBoundingClientRect();return [...document.querySelectorAll('.chat-header button,.chat-header select')].every(e=>e.getBoundingClientRect().right<=header.right+1);})()`)) throw new Error('Controles de cabecera recortados con panel lateral abierto');
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, 'search.png'), Buffer.from(shot.data, 'base64'));
  if (await cdp.evaluate(`document.querySelector('.saurio-chat-search').innerText.includes('Informe 23')`)) throw new Error('Fuga entre proyectos');
  await click('.saurio-chat-search__pagination button:last-child');
  await wait(`document.querySelectorAll('.saurio-chat-search__result').length===2`, 'Segunda página incorrecta');
  await click('.saurio-chat-search input[type="checkbox"]');
  await wait(`document.querySelectorAll('.saurio-chat-search__result').length===20 && document.querySelector('.saurio-chat-search__pagination').innerText.includes('Página 1')`, 'Filtro no reinicia página');
  await click('.saurio-chat-search__pagination button:last-child');
  await wait(`document.querySelectorAll('.saurio-chat-search__result').length===3`, 'Archivado no se incluye');
  const title = await cdp.evaluate(`document.querySelector('.saurio-chat-search__result-title').textContent.trim()`);
  await click('.saurio-chat-search__result button');
  await wait(`document.querySelector('.chat-header')?.textContent.includes(${JSON.stringify(title)})`, 'Resultado no abre conversación');
  const isolated = await cdp.invoke('chat:search', { projectId: 'search-B', query: 'girasol' });
  if (isolated.items.length !== 1 || isolated.items[0].chatId !== 'search-23') throw new Error('IPC perdió aislamiento B');
  const relocatedPath = join(profile, 'search-A-moved');
  renameSync(join(profile, 'search-A'), relocatedPath);
  const relocated = await cdp.invoke('project:relocate', { id: 'search-A', path: relocatedPath });
  if (relocated.id !== 'search-A') throw new Error('Reubicar cambió identidad');
  const reopened = await cdp.invoke('project:open', { path: relocatedPath });
  const preserved = await cdp.invoke('chat:search', { projectId: 'search-A', query: 'girasol', includeArchived: true, limit: 50 });
  if (reopened.id !== 'search-A' || preserved.items.length !== 23) throw new Error('Reubicar perdió historial');
  console.log(JSON.stringify({ ok: true, profile, resultPages: [20, 2], withArchived: 23, projectIsolation: true, relocatedProjectPreservesChats: true }));
} finally {
  assertCleanShutdown(await stop(instance), 'Búsqueda de chats');
}
