#!/usr/bin/env node
// Smoke funcional del .exe empaquetado: verifica IPC real con datos aislados, sin modelo ni Ollama.
//
// Uso (después de build:installer):
//   node scripts/smoke-release-functional.mjs
//   node scripts/smoke-release-functional.mjs --exe C:\ruta\SaurioLLM.exe
//   node scripts/smoke-release-functional.mjs --upgrade-from C:\ruta\SaurioLLM-0.2.2.exe --candidate-exe C:\ruta\SaurioLLM-0.2.3.exe
//
// Usa el depurador remoto de Chromium, no APIs internas ni una base SQLite escrita a mano. Cada
// llamada pasa por el preload real (`window.saurio.invoke`) hacia los handlers del proceso main.
// Cubre persistencia de proyectos/chats al cerrar y reabrir el proceso, incluida la restauración
// automática en UI del último proyecto y chat seleccionados.
// Con `--upgrade-from`, siembra el perfil temporal mediante la versión anterior, lo respalda antes
// de abrir el candidato y verifica la migración con IPC real. Nunca prueba un provider ni ejecuta
// un modelo: la credencial es sintética y su endpoint apunta a un puerto local sin servicio.
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultExe = join(rootDir, 'apps', 'desktop', 'release', 'win-unpacked', 'SaurioLLM.exe');
const timeoutMs = 45_000;

function fail(message) {
  throw new Error(`Smoke funcional: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  server.close();
  if (!address || typeof address === 'string') fail('no se pudo reservar un puerto de depuración');
  return address.port;
}

async function waitForPageDebugger(port, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.launchError) fail(`no se pudo iniciar el .exe: ${child.launchError.message}`);
    if (child.exitCode !== null) fail(`el .exe terminó antes de habilitar CDP (exit ${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Electron todavía no abrió el endpoint de depuración.
    }
    await delay(150);
  }
  fail(`CDP no respondió en ${timeoutMs / 1000}s`);
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP ${message.error.message}`));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP se cerró antes de responder'));
      this.pending.clear();
    });
  }

  async ready() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', () => rejectOpen(new Error('no se pudo conectar a CDP')), { once: true });
    });
  }

  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const outcome = await this.call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (outcome.exceptionDetails) {
      fail(`evaluación CDP falló: ${outcome.exceptionDetails.exception?.description ?? outcome.exceptionDetails.text ?? 'excepción del renderer'}`);
    }
    return outcome.result.value;
  }

  async invoke(channel, input) {
    const expression = `window.saurio.invoke(${JSON.stringify(channel)}, ${JSON.stringify(input)})`;
    const outcome = await this.call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (outcome.exceptionDetails) {
      fail(`IPC ${channel} falló: ${outcome.exceptionDetails.text ?? 'excepción del renderer'}`);
    }
    return outcome.result.value;
  }

  /** Captura un rechazo IPC esperado sin esconderlo como éxito del smoke. */
  async invokeResult(channel, input) {
    const expression = `window.saurio.invoke(${JSON.stringify(channel)}, ${JSON.stringify(input)})`
      + '.then((value) => ({ ok: true, value }), (reason) => ({ ok: false, message: String(reason?.message ?? reason) }))';
    const outcome = await this.call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (outcome.exceptionDetails) {
      fail(`IPC ${channel} no pudo informar su resultado: ${outcome.exceptionDetails.text ?? 'excepción del renderer'}`);
    }
    return outcome.result.value;
  }

  async close() {
    this.socket.close();
  }
}

async function waitForIpc(cdp) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate('typeof window.saurio?.invoke === "function"')) return;
    await delay(100);
  }
  fail(`el preload no expuso window.saurio en ${timeoutMs / 1000}s`);
}

async function waitForRenderedRoot(cdp) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rootHtmlLength = await cdp.evaluate('document.getElementById("root")?.innerHTML.length ?? 0');
    if (rootHtmlLength > 0) return rootHtmlLength;
    await delay(100);
  }
  fail(`React no renderizó contenido en #root en ${timeoutMs / 1000}s`);
}

async function waitForCondition(cdp, expression, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await delay(100);
  }
  fail(`${description} no ocurrió en ${timeoutMs / 1000}s`);
}

async function launchAtPort(exePath, userDataDir, appArgs = []) {
  const port = await freePort();
  const child = spawn(exePath, [...appArgs, `--remote-debugging-port=${port}`], {
    cwd: rootDir,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      SAURIO_USER_DATA: userDataDir,
      SAURIO_NO_UPDATE: '1',
      SAURIO_OLLAMA_URL: 'http://127.0.0.1:9',
    },
  });
  child.once('error', (error) => { child.launchError = error; });
  let cdp;
  try {
    const pageUrl = await waitForPageDebugger(port, child);
    cdp = new CdpClient(pageUrl);
    await cdp.ready();
    await waitForIpc(cdp);
    return { cdp, child, port };
  } catch (error) {
    // Un fallo antes de devolver la instancia no debe dejar un .exe huérfano (p. ej. CDP abrió
    // pero el preload no llegó a montar). No se usa como evidencia de cierre limpio.
    await cdp?.close();
    await emergencyStop({ child });
    throw error;
  }
}

async function waitForExit(child, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (child.exitCode === null && Date.now() < deadline) await delay(100);
}

async function stop(instance) {
  const startedAt = Date.now();
  try {
    await instance.cdp?.call('Runtime.evaluate', { expression: 'window.close()', awaitPromise: false });
  } catch {
    // Si el renderer ya cerró, esperamos de todos modos al proceso principal.
  }
  await instance.cdp?.close();
  await waitForExit(instance.child, 8_000);
  let forced = false;
  if (instance.child.exitCode === null) {
    forced = true;
    instance.child.kill();
    await waitForExit(instance.child, 8_000);
  }
  return { forced, exitCode: instance.child.exitCode, elapsedMs: Date.now() - startedAt };
}

async function emergencyStop(instance) {
  try {
    return await stop(instance);
  } catch {
    if (instance.child?.exitCode === null) {
      instance.child.kill();
      await waitForExit(instance.child, 8_000);
    }
    return { forced: true, exitCode: instance.child?.exitCode ?? null, elapsedMs: undefined };
  }
}

function assertCleanShutdown(result, phase) {
  assert(!result.forced, `${phase}: la app no cerró sola y hubo que forzarla (${result.elapsedMs} ms)`);
  assert(result.exitCode === 0, `${phase}: la app cerró con exit ${result.exitCode} (${result.elapsedMs} ms)`);
}

function findProject(projects, projectPath) {
  return projects.find((project) => project.path === projectPath);
}

function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail(`falta la ruta después de ${flag}`);
  return value;
}

async function captureOptionalScreenshot(cdp) {
  const screenshotPath = cliValue('--screenshot');
  if (!screenshotPath) return;
  const capture = await cdp.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(screenshotPath), Buffer.from(capture.data, 'base64'));
}

async function runFunctionalSmoke() {
  const passedExe = cliValue('--exe');
  const exePath = resolve(passedExe ?? defaultExe);
  assert(existsSync(exePath), `no existe el .exe empaquetado: ${exePath}`);

  const tempRoot = mkdtempSync(join(tmpdir(), 'saurio-functional-smoke-'));
  const userDataDir = join(tempRoot, 'datos aislados');
  const projectAPath = join(tempRoot, 'Proyecto A con espacios');
  const projectBPath = join(tempRoot, 'Proyecto B con espacios');
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(projectAPath, { recursive: true });
  mkdirSync(projectBPath, { recursive: true });

  let first;
  let second;
  try {
    const modelRef = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' };
    const firstStartedAt = performance.now();
    first = await launchAtPort(exePath, userDataDir);
    const rootHtmlLength = await waitForRenderedRoot(first.cdp);
    const firstRenderMs = Math.round(performance.now() - firstStartedAt);
    await captureOptionalScreenshot(first.cdp);
    const projectA = await first.cdp.invoke('project:open', { path: projectAPath });
    assert(projectA.path === projectAPath, 'project:open A no devolvió la ruta exacta con espacios');
    const engineStatus = await first.cdp.invoke('engine:status', undefined);
    assert(typeof engineStatus?.phase === 'string' && typeof engineStatus?.mode === 'string'
      && typeof engineStatus?.hasManaged === 'boolean', 'engine:status no devolvió el estado del motor');
    const hardware = await first.cdp.invoke('hardware:profile', { refresh: true });
    assert(Number.isInteger(hardware?.cpu?.threads) && hardware.cpu.threads > 0,
      'hardware:profile no devolvió hilos de CPU válidos');
    assert(typeof hardware?.ram?.totalBytes === 'number' && typeof hardware.ram.freeBytes === 'number'
      && hardware.ram.totalBytes >= hardware.ram.freeBytes,
    'hardware:profile devolvió RAM inconsistente');
    const resourceSettings = { preset: 'low-power', computeMode: 'cpu', numThreads: 1 };
    await first.cdp.invoke('settings:set', { key: 'resources.localInference', value: resourceSettings });
    const savedResourceSettings = await first.cdp.invoke('settings:get', { key: 'resources.localInference' });
    assert(JSON.stringify(savedResourceSettings) === JSON.stringify(resourceSettings),
      'los ajustes de recursos no se pudieron guardar por IPC');
    const chatA = await first.cdp.invoke('chat:create', {
      projectId: projectA.id, agentId: 'agent_builtin_lead', mode: 'ask', modelRef,
    });
    assert(chatA.projectId === projectA.id, 'chat A quedó asociado a otro proyecto');
    const renamedChatA = await first.cdp.invoke('chat:rename', { chatId: chatA.id, title: 'Chat A renombrado' });
    assert(renamedChatA.title === 'Chat A renombrado', 'chat:rename no actualizó el título');
    const archivedChatA = await first.cdp.invoke('chat:archive', { chatId: chatA.id, archived: true });
    assert(archivedChatA.archived === true, 'chat:archive no marcó el chat');
    await first.cdp.invoke('chat:archive', { chatId: chatA.id, archived: false });
    const collaborator = await first.cdp.invoke('agents:create', {
      name: 'Colaborador sintético de smoke', role: 'reviewer', modelMode: 'fixed', model: modelRef,
      systemPrompt: 'Fixture de smoke: no ejecutar acciones.', allowedTools: ['read_file'], permissionPreset: 'balanced',
    });
    const savedCollaborators = await first.cdp.invoke('agents:collaborators:set', {
      chatId: chatA.id, projectId: projectA.id, agentIds: [collaborator.id],
    });
    assert(savedCollaborators.agentIds.length === 1 && savedCollaborators.agentIds[0] === collaborator.id,
      'agents:collaborators:set no guardó el agente activo');

    const projectB = await first.cdp.invoke('project:open', { path: projectBPath });
    assert(projectB.path === projectBPath, 'project:open B no devolvió la ruta exacta con espacios');
    const chatB = await first.cdp.invoke('chat:create', {
      projectId: projectB.id, agentId: 'agent_builtin_lead', mode: 'ask', modelRef,
    });
    assert(chatB.projectId === projectB.id, 'chat B quedó asociado a otro proyecto');
    const renamedChatB = await first.cdp.invoke('chat:rename', { chatId: chatB.id, title: 'Chat B seleccionado' });
    assert(renamedChatB.title === 'Chat B seleccionado', 'chat:rename no preparó la selección restaurable de B');
    const chatsA = await first.cdp.invoke('chat:list', { projectId: projectA.id });
    const chatsB = await first.cdp.invoke('chat:list', { projectId: projectB.id });
    assert(chatsA.length === 1 && chatsA[0].id === chatA.id, 'chat:list A no quedó filtrado por proyecto');
    assert(chatsB.length === 1 && chatsB[0].id === chatB.id, 'chat:list B no quedó filtrado por proyecto');
    const forbiddenCollaborators = await first.cdp.invokeResult('agents:collaborators:get', {
      chatId: chatA.id, projectId: projectB.id,
    });
    assert(forbiddenCollaborators?.ok === false && /no pertenece/i.test(forbiddenCollaborators.message ?? ''),
      'agents:collaborators:get permitió leer colaboradores desde otro proyecto');
    const personalProject = await first.cdp.invoke('project:personal', undefined);
    assert(personalProject.id === 'project_personal', 'project:personal no abrió el espacio personal esperado');
    const personalTree = await first.cdp.invoke('files:tree', { projectId: personalProject.id });
    assert(Array.isArray(personalTree), 'files:tree no respondió sobre el runtime del espacio personal');
    const personalChat = await first.cdp.invoke('chat:create', {
      projectId: personalProject.id, agentId: 'agent_builtin_lead', mode: 'ask', modelRef,
    });
    assert(personalChat.projectId === personalProject.id, 'chat personal no quedó asociado al runtime personal');
    const managedProject = await first.cdp.invoke('project:createManaged', { name: 'Proyecto administrado smoke' });
    assert(managedProject.name === 'Proyecto administrado smoke' && /managed-projects/i.test(managedProject.path)
      && managedProject.path !== projectAPath && managedProject.path !== projectBPath,
    'project:createManaged no creó un proyecto aislado dentro de los datos de la app');

    // Los fixtures anteriores se crean por IPC para no depender de diálogos nativos. La selección
    // que se restaurará sí debe pasar por los controles reales y los stores del renderer.
    await first.cdp.invoke('settings:set', { key: 'onboarding.completed', value: true });
    await first.cdp.call('Page.reload', { ignoreCache: true });
    await delay(500);
    await waitForIpc(first.cdp);
    await waitForRenderedRoot(first.cdp);
    await waitForCondition(first.cdp, 'Boolean(document.querySelector(\'nav button[title^="Chats ("]\'))',
      'la navegación a Chats');
    const openedChatsFromUi = await first.cdp.evaluate(`(() => {
      const button = document.querySelector('nav button[title^="Chats ("]');
      button?.click();
      return Boolean(button);
    })()`);
    assert(openedChatsFromUi, 'no se pudo abrir Chats desde la navegación de la UI');
    const projectBButtonExpression = `(() => [...document.querySelectorAll('.saurio-project-row__open')]
      .find((button) => button.getAttribute('title') === ${JSON.stringify(projectBPath)}))()`;
    await waitForCondition(first.cdp, `Boolean(${projectBButtonExpression})`, 'Proyecto B en la lista de la UI');
    const selectedProjectFromUi = await first.cdp.evaluate(`(() => {
      const button = ${projectBButtonExpression};
      button?.click();
      return Boolean(button);
    })()`);
    assert(selectedProjectFromUi, 'no se pudo seleccionar Proyecto B desde la UI');
    await waitForCondition(first.cdp, `(() => {
      const projectRow = [...document.querySelectorAll('.saurio-project-row')]
        .find((row) => row.querySelector('.saurio-project-row__open')?.getAttribute('title') === ${JSON.stringify(projectBPath)});
      return Boolean(projectRow?.classList.contains('active')
        && [...document.querySelectorAll('.saurio-sidebar-item__title')]
          .some((title) => title.textContent?.trim() === 'Chat B seleccionado'));
    })()`, 'Proyecto B activo con su chat visible');
    const selectedChatFromUi = await first.cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('.saurio-sidebar-item')]
        .find((item) => item.querySelector('.saurio-sidebar-item__title')?.textContent?.trim() === 'Chat B seleccionado');
      row?.click();
      return Boolean(row);
    })()`);
    assert(selectedChatFromUi, 'no se pudo seleccionar Chat B desde la UI');
    await waitForCondition(first.cdp, `(() => {
      const activeChatTitle = document.querySelector('.saurio-sidebar-item.active .saurio-sidebar-item__title')?.textContent?.trim();
      return activeChatTitle === 'Chat B seleccionado'
        && Boolean(document.querySelector('textarea[aria-label="Mensaje para el agente"]'));
    })()`, 'Chat B activo desde la UI');
    await waitForCondition(first.cdp, `Promise.all([
      window.saurio.invoke('settings:get', { key: 'ui.projects.lastProjectId' }),
      window.saurio.invoke('settings:get', { key: 'ui.projects.lastChatId' }),
    ]).then(([projectId, chatId]) => projectId === ${JSON.stringify(projectB.id)} && chatId === ${JSON.stringify(chatB.id)})`,
    'las preferencias de selección escritas por la UI');
    const [selectedProjectPreference, selectedChatPreference] = await Promise.all([
      first.cdp.invoke('settings:get', { key: 'ui.projects.lastProjectId' }),
      first.cdp.invoke('settings:get', { key: 'ui.projects.lastChatId' }),
    ]);
    assert(selectedProjectPreference === projectB.id && selectedChatPreference === chatB.id,
      'la selección UI no persistió los IDs exactos de Proyecto B y Chat B');
    const firstShutdown = await stop(first);
    first = undefined;
    assertCleanShutdown(firstShutdown, 'primer cierre');

    const restartStartedAt = performance.now();
    second = await launchAtPort(exePath, userDataDir);
    await waitForRenderedRoot(second.cdp);
    const restartRenderMs = Math.round(performance.now() - restartStartedAt);
    const projectsAfterRestart = await second.cdp.invoke('project:list', undefined);
    const restoredA = findProject(projectsAfterRestart, projectAPath);
    const restoredB = findProject(projectsAfterRestart, projectBPath);
    const restoredManaged = projectsAfterRestart.find((project) => project.id === managedProject.id);
    assert(restoredA?.id === projectA.id && restoredB?.id === projectB.id, 'los proyectos A/B no sobrevivieron al reinicio');
    assert(restoredManaged?.path === managedProject.path, 'el proyecto administrado no sobrevivió al reinicio');

    // No llamar project:open ni abrir el chat desde el smoke: el renderer debe restaurar ambos.
    const restoredSelectionExpression = `(() => {
      const projectRow = [...document.querySelectorAll('.saurio-project-row')]
        .find((row) => row.querySelector('.saurio-project-row__open')?.getAttribute('title') === ${JSON.stringify(projectBPath)});
      const activeChatTitle = document.querySelector('.saurio-sidebar-item.active .saurio-sidebar-item__title')?.textContent?.trim();
      return Boolean(projectRow?.classList.contains('active')
        && activeChatTitle === 'Chat B seleccionado'
        && document.querySelector('textarea[aria-label="Mensaje para el agente"]'));
    })()`;
    await waitForCondition(second.cdp, restoredSelectionExpression,
      'la restauración automática del último proyecto/chat en la UI');
    const restoredChatsA = await second.cdp.invoke('chat:list', { projectId: projectA.id });
    const restoredChatsB = await second.cdp.invoke('chat:list', { projectId: projectB.id });
    assert(restoredChatsA.length === 1 && restoredChatsA[0].id === chatA.id, 'chat A no sobrevivió o se mezcló tras reiniciar');
    assert(restoredChatsB.length === 1 && restoredChatsB[0].id === chatB.id, 'chat B no sobrevivió o se mezcló tras reiniciar');
    assert(restoredChatsA[0].title === 'Chat A renombrado' && restoredChatsA[0].archived === false,
      'el renombre o archivado/restauración del chat A no sobrevivió al reinicio');
    const restoredCollaborators = await second.cdp.invoke('agents:collaborators:get', {
      chatId: chatA.id, projectId: projectA.id,
    });
    assert(restoredCollaborators.agentIds.length === 1 && restoredCollaborators.agentIds[0] === collaborator.id,
      'los colaboradores del Director no sobrevivieron al reinicio');
    const restoredResourceSettings = await second.cdp.invoke('settings:get', { key: 'resources.localInference' });
    assert(JSON.stringify(restoredResourceSettings) === JSON.stringify(resourceSettings),
      'los ajustes de recursos no sobrevivieron al reinicio');
    const restoredPersonalProject = await second.cdp.invoke('project:personal', undefined);
    assert(restoredPersonalProject.id === personalProject.id, 'project:personal no conservó su identidad al reiniciar');
    const restoredPersonalTree = await second.cdp.invoke('files:tree', { projectId: restoredPersonalProject.id });
    assert(Array.isArray(restoredPersonalTree), 'files:tree no quedó disponible al restaurar el espacio personal');
    const restoredPersonalChats = await second.cdp.invoke('chat:list', { projectId: restoredPersonalProject.id });
    assert(restoredPersonalChats.some((chat) => chat.id === personalChat.id),
      'el chat del espacio personal no sobrevivió al reinicio');

    // Comprueba que el handler real queda disponible una vez reabierto el proyecto. Un arreglo
    // vacío no prueba recuperación de una espera: crear una PermissionRequest auténtica necesita
    // ejecutar un run contra un modelo, deliberadamente fuera de este smoke sin Ollama.
    const pendingPermissions = await second.cdp.invoke('permission:pending', undefined);
    assert(Array.isArray(pendingPermissions), 'permission:pending no devolvió un arreglo');

    const secondShutdown = await stop(second);
    second = undefined;
    assertCleanShutdown(secondShutdown, 'segundo cierre');

    console.log(JSON.stringify({
      ok: true,
      exePath,
      startup: {
        firstRenderMs, restartRenderMs,
        scope: 'Desde lanzamiento hasta primer render detectado por CDP; incluye conexión/sondeo CDP. Motor local apagado, medido en esta PC; no es un benchmark universal ni Windows limpio.',
      },
      checks: {
        rootHtmlLength,
        projectPathsWithSpaces: true,
        chatsFilteredByProject: true,
        persistedAcrossRestart: true,
        selectionPersistedByUiBeforeRestart: true,
        automaticProjectAndChatRestoreAfterRestart: true,
        managedProject: true,
        chatRenameArchive: true,
        collaboratorsPersistedAndProjectAuthorized: true,
        hardwareProfile: true,
        engineStatus: true,
        resourceSettingsPersisted: true,
        personalProjectRuntimeAndChatPersistence: true,
        permissionPendingHandler: true,
      },
      cleanShutdown: {
        first: firstShutdown,
        second: secondShutdown,
      },
      limitation: 'No crea una PermissionRequest pendiente: eso requiere ejecutar un run contra un modelo.',
    }, null, 2));
  } finally {
    if (first) await emergencyStop(first);
    if (second) await emergencyStop(second);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runUpgradeSmoke(seedExeArg, candidateExeArg) {
  const seedExePath = resolve(seedExeArg);
  const candidateExePath = resolve(candidateExeArg ?? defaultExe);
  assert(existsSync(seedExePath), `no existe el .exe de origen: ${seedExePath}`);
  assert(existsSync(candidateExePath), `no existe el .exe candidato: ${candidateExePath}`);

  const tempRoot = mkdtempSync(join(tmpdir(), 'saurio-upgrade-smoke-'));
  const userDataDir = join(tempRoot, 'perfil a migrar');
  const profileBackupDir = join(tempRoot, 'respaldo previo al candidato');
  const projectAPath = join(tempRoot, 'Proyecto A con espacios');
  const projectBPath = join(tempRoot, 'Proyecto B con espacios');
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(projectAPath, { recursive: true });
  mkdirSync(projectBPath, { recursive: true });

  const modelRef = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' };
  const syntheticApiKey = 'saurio-smoke-credencial-4242';
  let seed;
  let candidate;
  let completed = false;
  try {
    seed = await launchAtPort(seedExePath, userDataDir);
    const projectA = await seed.cdp.invoke('project:open', { path: projectAPath });
    const projectB = await seed.cdp.invoke('project:open', { path: projectBPath });
    assert(projectA.path === projectAPath && projectB.path === projectBPath,
      'la versión de origen no preservó las rutas con espacios al abrir proyectos');

    const chatA = await seed.cdp.invoke('chat:create', {
      projectId: projectA.id, agentId: 'agent_builtin_lead', mode: 'ask', modelRef,
    });
    const chatB = await seed.cdp.invoke('chat:create', {
      projectId: projectB.id, agentId: 'agent_builtin_lead', mode: 'ask', modelRef,
    });
    const agent = await seed.cdp.invoke('agents:create', {
      name: 'Agente sintético de migración',
      description: 'Fixture local de smoke de actualización; no ejecuta modelos.',
      role: 'reviewer',
      modelMode: 'fixed',
      model: modelRef,
      systemPrompt: 'No ejecutar acciones: fixture de migración.',
      allowedTools: ['read_file'],
      permissionPreset: 'balanced',
    });
    const provider = await seed.cdp.invoke('providers:add', {
      preset: 'custom',
      label: 'Credencial sintética de migración',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: syntheticApiKey,
    });
    assert(provider.hasApiKey === true && provider.apiKeyLast4 === '4242',
      'la versión de origen no confirmó la credencial sintética en el almacén seguro');
    assert(!JSON.stringify(provider).includes(syntheticApiKey), 'el IPC de origen expuso la credencial sintética');
    await seed.cdp.invoke('settings:set', { key: 'models.localOnly', value: true });
    await seed.cdp.invoke('settings:set', { key: 'updates.auto', value: false });

    const seedShutdown = await stop(seed);
    seed = undefined;
    assertCleanShutdown(seedShutdown, 'cierre de la versión de origen');

    cpSync(userDataDir, profileBackupDir, { recursive: true, force: false, errorOnExist: true });
    assert(existsSync(join(profileBackupDir, 'saurio.db')), 'no se creó el respaldo SQLite antes de abrir el candidato');

    candidate = await launchAtPort(candidateExePath, userDataDir);
    const rootHtmlLength = await waitForRenderedRoot(candidate.cdp);
    await captureOptionalScreenshot(candidate.cdp);

    const projects = await candidate.cdp.invoke('project:list', undefined);
    const restoredA = findProject(projects, projectAPath);
    const restoredB = findProject(projects, projectBPath);
    assert(restoredA?.id === projectA.id && restoredB?.id === projectB.id,
      'el candidato no conservó ambos proyectos de la versión anterior');
    const chatsA = await candidate.cdp.invoke('chat:list', { projectId: projectA.id });
    const chatsB = await candidate.cdp.invoke('chat:list', { projectId: projectB.id });
    assert(chatsA.length === 1 && chatsA[0].id === chatA.id,
      'el candidato no conservó el chat A o lo mezcló con otro proyecto');
    assert(chatsB.length === 1 && chatsB[0].id === chatB.id,
      'el candidato no conservó el chat B o lo mezcló con otro proyecto');

    const agents = await candidate.cdp.invoke('agents:list', {});
    const restoredAgent = agents.find((item) => item.id === agent.id);
    assert(restoredAgent?.name === agent.name && restoredAgent.role === 'reviewer',
      'el candidato no conservó el agente personal sembrado por la versión anterior');
    const [localOnly, updatesAuto] = await Promise.all([
      candidate.cdp.invoke('settings:get', { key: 'models.localOnly' }),
      candidate.cdp.invoke('settings:get', { key: 'updates.auto' }),
    ]);
    assert(localOnly === true, 'el candidato no conservó la preferencia models.localOnly');
    assert(updatesAuto === false, 'el candidato no conservó la preferencia de arranque updates.auto');
    const providers = await candidate.cdp.invoke('providers:list', undefined);
    const restoredProvider = providers.find((item) => item.id === provider.id);
    assert(restoredProvider?.label === provider.label && restoredProvider.hasApiKey === true && restoredProvider.apiKeyLast4 === '4242',
      'el candidato no conservó la credencial sintética en el almacén seguro');
    assert(!JSON.stringify(restoredProvider).includes(syntheticApiKey), 'el IPC del candidato expuso la credencial sintética');

    const candidateShutdown = await stop(candidate);
    candidate = undefined;
    assertCleanShutdown(candidateShutdown, 'cierre del candidato');
    completed = true;

    console.log(JSON.stringify({
      ok: true,
      mode: 'upgrade',
      seedExePath,
      candidateExePath,
      checks: {
        profileBackedUpBeforeCandidate: true,
        rootHtmlLength,
        projectsWithSpaces: true,
        chatsFilteredByProject: true,
        personalAgent: true,
        preferences: true,
        syntheticCredential: true,
      },
      cleanShutdown: { seed: seedShutdown, candidate: candidateShutdown },
      limitation: 'No ejecuta modelos, pruebas de provider ni actualizador: comprueba la compatibilidad de datos mediante IPC sobre un perfil temporal.',
    }, null, 2));
  } finally {
    if (seed) await emergencyStop(seed);
    if (candidate) await emergencyStop(candidate);
    if (completed) {
      rmSync(tempRoot, { recursive: true, force: true });
    } else {
      console.error(`Smoke de actualización falló; se preservó el perfil temporal y su respaldo para diagnóstico: ${tempRoot}`);
    }
  }
}

async function main() {
  const upgradeFrom = cliValue('--upgrade-from');
  const candidateExe = cliValue('--candidate-exe');
  if (candidateExe && !upgradeFrom) fail('--candidate-exe requiere --upgrade-from');
  if (upgradeFrom) return runUpgradeSmoke(upgradeFrom, candidateExe);
  return runFunctionalSmoke();
}

export { CdpClient, launchAtPort, stop, waitForRenderedRoot, assertCleanShutdown };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
