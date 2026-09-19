// Smoke funcional de agentes personales sobre el renderer/preload reales.
// Uso: node scripts/smoke-agents-023.mjs [--dev]
// No instala modelos ni ejecuta llamadas de inferencia: los chats se crean en modo automático.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown } from './smoke-release-functional.mjs';

const output = resolve('smoke/agents-023');
mkdirSync(output, { recursive: true });
const dev = process.argv.includes('--dev');
const profile = join(output, `profile-${Date.now()}`);
const instance = await launchAtPort(
  resolve(dev ? 'node_modules/electron/dist/electron.exe' : 'apps/desktop/release/win-unpacked/SaurioLLM.exe'),
  profile,
  dev ? [resolve('apps/desktop')] : [],
);
const { cdp } = instance;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function wait(expression, label) {
  const deadline = Date.now() + 10_000;
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
  await delay(180);
}

async function clickText(label, selector = 'button') {
  await cdp.evaluate(`(() => {
    const controls = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const target = controls.find((element) => element.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!target) throw new Error('Control ausente: ' + ${JSON.stringify(label)});
    target.setAttribute('data-smoke-target', 'true');
  })()`);
  await click('[data-smoke-target="true"]');
  await cdp.evaluate(`document.querySelector('[data-smoke-target="true"]')?.removeAttribute('data-smoke-target')`);
}

async function selectValue(selector, value) {
  await cdp.evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    if (!select) throw new Error('Select ausente: ' + ${JSON.stringify(selector)});
    if (![...select.options].some((option) => option.value === ${JSON.stringify(value)})) throw new Error('Opción ausente: ' + ${JSON.stringify(value)});
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await delay(180);
}

async function rowAction(name, text) {
  await cdp.evaluate(`(() => {
    const row = [...document.querySelectorAll('.agents-panel__row')].find((element) => element.textContent.includes(${JSON.stringify(name)}));
    if (!row) throw new Error('Fila ausente: ' + ${JSON.stringify(name)});
    const button = [...row.querySelectorAll('button')].find((element) => element.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!button) throw new Error('Acción ausente: ' + ${JSON.stringify(text)});
    button.setAttribute('data-smoke-target', 'true');
  })()`);
  await click('[data-smoke-target="true"]');
  await cdp.evaluate(`document.querySelector('[data-smoke-target="true"]')?.removeAttribute('data-smoke-target')`);
}

try {
  await waitForRenderedRoot(cdp);
  await cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });
  const project = await cdp.invoke('project:createManaged', { name: 'Smoke agentes 0.2.3' });
  await cdp.invoke('settings:set', { key: 'ui.projects.lastProjectId', value: project.id });
  await cdp.call('Page.reload');
  await waitForRenderedRoot(cdp);
  await wait('Boolean(document.querySelector(`nav button[title^="Agentes ("]`))', 'La navegación de Agentes no cargó');
  await click('nav button[title^="Agentes ("]');
  await wait('Boolean(document.querySelector(".agents-panel"))', 'El panel de agentes no cargó');

  const before = await cdp.invoke('agents:list', { projectId: project.id });
  await clickText('+ Nuevo agente', '.agents-panel__actions button');
  await wait('Boolean(document.querySelector(`[role="dialog"][aria-label="Nuevo agente"]`))', 'No abrió el editor');
  const editorState = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Nuevo agente"]');
    const modelInputs = [...(dialog?.querySelectorAll('input[type="radio"]') ?? [])];
    return { advancedOpen: Boolean(dialog?.querySelector('details.agent-editor__advanced[open]')), auto: Boolean(modelInputs[1]?.checked) };
  })()`);
  if (editorState.advancedOpen || !editorState.auto) throw new Error('El editor no inicia con avanzados plegados y Automático seleccionado');
  await click('[role="dialog"][aria-label="Nuevo agente"] input[type="text"]');
  await cdp.call('Input.insertText', { text: 'Smoke Auto' });
  await clickText('Crear y abrir chat', '[role="dialog"] .agent-editor__actions button');
  await wait(`(async () => Boolean((await window.saurio.invoke('agents:list', { projectId: ${JSON.stringify(project.id)} })).find((agent) => agent.name === 'Smoke Auto')))()`, 'El perfil automático no se creó');
  const afterUiCreate = await cdp.invoke('agents:list', { projectId: project.id });
  if (afterUiCreate.length !== before.length + 1) throw new Error(`Crear agente produjo ${afterUiCreate.length - before.length} perfiles en vez de uno`);
  const autoAgent = afterUiCreate.find((agent) => agent.name === 'Smoke Auto');
  if (!autoAgent || autoAgent.modelMode !== 'auto') throw new Error('El perfil creado no conserva modelMode auto');
  await wait('document.querySelector(`nav button[aria-current="page"]`)?.textContent.trim() === "Chats" || Boolean(document.querySelector(".agent-editor__card .saurio-banner.danger, .saurio-banner.danger"))', 'Crear y abrir chat no navegó a Chats');
  const openChatNavigation = await cdp.evaluate(`({ section: document.querySelector('nav button[aria-current="page"]')?.textContent.trim(), error: document.querySelector('.agent-editor__card .saurio-banner.danger, .saurio-banner.danger')?.textContent.trim() })`);
  if (openChatNavigation.section !== 'Chats') throw new Error(`Crear y abrir chat falló desde la UI: ${openChatNavigation.error ?? 'la aplicación no informó el motivo'}`);
  await wait(`(async () => (await window.saurio.invoke('chat:list', { projectId: ${JSON.stringify(project.id)} })).some((chat) => chat.agentId === ${JSON.stringify(autoAgent.id)} && chat.modelSelection === 'auto'))()`, 'Crear y abrir chat no creó el chat automático asociado');
  const openedChats = await cdp.invoke('chat:list', { projectId: project.id });
  const openedAutoChat = openedChats.find((chat) => chat.agentId === autoAgent.id && chat.modelSelection === 'auto');
  if (!openedAutoChat || !await cdp.evaluate('Boolean(document.querySelector("textarea[aria-label=\\"Mensaje para el agente\\"]"))')) throw new Error('Crear y abrir chat no dejó el chat usable');
  await click('nav button[title^="Agentes ("]');
  await wait('Boolean(document.querySelector(".agents-panel"))', 'No se pudo volver a Agentes después de abrir el chat');

  // Perfiles auxiliares para ejercitar filtros combinados sin modelo ni llamadas externas.
  const projectAgent = await cdp.invoke('agents:create', { name: 'Smoke Proyecto', role: 'custom', modelMode: 'auto', memoryScope: 'project', projectId: project.id, permissionPreset: 'balanced' });
  const archivedAgent = await cdp.invoke('agents:create', { name: 'Smoke Archivado', role: 'custom', modelMode: 'auto', memoryScope: 'global', permissionPreset: 'balanced' });
  const archivedChat = await cdp.invoke('chat:create', { projectId: project.id, agentId: archivedAgent.id, mode: 'agent', modelSelection: 'auto' });
  await cdp.invoke('chat:rename', { chatId: archivedChat.id, title: 'Chat archivado smoke' });
  await cdp.call('Page.reload');
  await waitForRenderedRoot(cdp);
  await click('nav button[title^="Agentes ("]');
  await wait('document.querySelectorAll(".agents-panel__row").length >= 3', 'No reaparecieron los perfiles del smoke');

  // Favorito + alcance + archivado se combinan sobre selects reales.
  await rowAction('Smoke Auto', 'Favorito');
  await rowAction('Smoke Archivado', 'Favorito');
  const favoriteIds = await cdp.invoke('settings:get', { key: 'ui.agents.favoriteIds' });
  if (!favoriteIds?.includes(autoAgent.id) || !favoriteIds.includes(archivedAgent.id)) throw new Error('Favorito no persistió en settings');
  await selectValue('select[aria-label="Filtrar por alcance"]', 'project');
  if (await cdp.evaluate('document.querySelectorAll(".agents-panel__row").length') !== 1) throw new Error('El filtro de alcance no dejó únicamente el perfil de proyecto');
  if (!await cdp.evaluate(`document.querySelector('.agents-panel__row')?.textContent.includes(${JSON.stringify(projectAgent.name)})`)) throw new Error('El filtro de alcance mostró un proyecto incorrecto');
  await cdp.evaluate(`document.querySelector('.agents-panel__filters input[type="checkbox"]')?.click()`);
  await delay(180);
  if (await cdp.evaluate('document.querySelectorAll(".agents-panel__row").length') !== 0) throw new Error('Alcance y favoritos no se combinaron');
  await clickText('Limpiar', '.agents-panel__filters button');
  await rowAction('Smoke Archivado', 'Archivar');
  await selectValue('select[aria-label="Filtrar por archivado"]', 'archived');
  await selectValue('select[aria-label="Filtrar por alcance"]', 'global');
  await cdp.evaluate(`document.querySelector('.agents-panel__filters input[type="checkbox"]')?.click()`);
  await wait('document.querySelectorAll(".agents-panel__row").length === 1', 'Archivado, alcance y favoritos no se combinaron');
  await rowAction('Smoke Archivado', 'Restaurar');
  await clickText('Limpiar', '.agents-panel__filters button');
  await wait('document.querySelectorAll(".agents-panel__row").length >= 3', 'Restaurar no devolvió el perfil a la lista activa');
  const restored = await cdp.invoke('agents:list', { includeArchived: true, projectId: project.id });
  if (!restored.some((agent) => agent.id === archivedAgent.id && !agent.archivedAt)) throw new Error('Restaurar no quitó archivedAt');
  const chats = await cdp.invoke('chat:list', { projectId: project.id });
  if (!chats.some((chat) => chat.id === archivedChat.id && chat.agentId === archivedAgent.id)) throw new Error('Archivar/restaurar eliminó o desasoció el chat');

  // El alcance del perfil existente se puede editar desde el control real del diálogo.
  await rowAction('Smoke Auto', 'Editar');
  await wait('Boolean(document.querySelector(`[role="dialog"][aria-label="Editar agente"]`))', 'No abrió la edición');
  await click('.agent-editor__advanced summary');
  await selectValue('select[aria-label="Alcance de memoria"]', 'project');
  await clickText('Guardar cambios', '.agent-editor__actions button');
  await wait('!document.querySelector(`[role="dialog"][aria-label="Editar agente"]`)', 'No guardó el alcance de proyecto');
  const scoped = (await cdp.invoke('agents:list', { projectId: project.id })).find((agent) => agent.id === autoAgent.id);
  if (scoped?.memoryScope !== 'project' || scoped.projectId !== project.id) throw new Error('Editar memoria no persistió el proyecto correcto');
  await rowAction('Smoke Auto', 'Editar');
  await click('.agent-editor__advanced summary');
  await selectValue('select[aria-label="Alcance de memoria"]', 'global');
  await clickText('Guardar cambios', '.agent-editor__actions button');
  await wait('!document.querySelector(`[role="dialog"][aria-label="Editar agente"]`)', 'No guardó el alcance global');
  const globalProfile = (await cdp.invoke('agents:list', {})).find((agent) => agent.id === autoAgent.id);
  if (globalProfile?.memoryScope !== 'global' || globalProfile.projectId !== undefined) throw new Error('Editar a global dejó una asociación de proyecto incorrecta');

  // Volver a Chats confirma que el chat creado por la acción de la UI sigue asociado.
  await cdp.invoke('settings:set', { key: 'ui.projects.lastProjectId', value: project.id });
  await click('nav button[title^="Chats ("]');
  await wait(`Boolean(document.querySelector('.saurio-sidebar-item'))`, 'La vista de chats no cargó el chat automático');
  await clickText('Chat nuevo', '.saurio-sidebar-item');
  await wait('Boolean(document.querySelector("textarea[aria-label=\\"Mensaje para el agente\\"]"))', 'El chat automático no se abrió');
  console.log(JSON.stringify({ ok: true, mode: dev ? 'dev' : 'packaged', profile, projectId: project.id, createdProfile: autoAgent.id, autoChatId: openedAutoChat.id, archivedChatPreserved: true }));
} finally {
  assertCleanShutdown(await stop(instance), 'Agentes');
}
