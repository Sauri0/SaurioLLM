// Handlers IPC del dominio "project" (doc 02 §1: apps/desktop/src/main/ipc/project.ts, doc 01 §6).
// project:open abre un diálogo nativo (HostAdapter.showOpenDirectoryDialog) cuando no se pasa `path`.
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ipc } from '@saurio/shared';
import { PERSONAL_PROJECT_ID } from '@saurio/runtime/agent/personalProject';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import { registerHandler } from './registerHandler.js';

/** Id determinístico y legible derivado de la ruta; `projects.path` es UNIQUE (doc 03 §4.1), así
 *  que abrir dos veces la misma carpeta devuelve siempre el mismo proyecto. */
function projectIdFor(projectPath: string): string {
  // Id determinístico y legible; cuando exista persistencia real, el repositorio decide el id.
  return `project_${Buffer.from(projectPath).toString('base64url')}`;
}

function managedFolderName(name: string): string {
  const safeName = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'proyecto';
  return `${safeName}-${randomUUID().slice(0, 8)}`;
}

/** Valida la raíz antes de persistirla o construir un runtime. `realpath` elimina alias/symlinks y
 * normaliza mayúsculas/minúsculas donde el filesystem lo haga (importante para Windows). */
function existingProjectDirectory(projectPath: string): string {
  if (!path.isAbsolute(projectPath)) {
    throw new Error('saurio: la carpeta del proyecto debe tener una ruta absoluta. Elegí una carpeta existente.');
  }
  const resolved = path.resolve(projectPath);
  try {
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error('not-directory');
    }
    return realpathSync.native(resolved);
  } catch {
    throw new Error(`saurio: la carpeta del proyecto no existe o ya no es accesible: ${resolved}. Elegí otra carpeta.`);
  }
}

function sameExistingDirectory(savedPath: string, canonicalPath: string): boolean {
  try {
    return existingProjectDirectory(savedPath) === canonicalPath;
  } catch {
    return false;
  }
}

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function isSameDirectory(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function directoriesOverlap(left: string, right: string): boolean {
  const fromLeft = path.relative(left, right);
  const fromRight = path.relative(right, left);
  const isWithin = (relative: string) => relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  return isWithin(fromLeft) || isWithin(fromRight);
}

/** El espacio Personal conserva sus chats bajo un ID sintético, pero sus herramientas necesitan
 * una raíz física privada. Nunca se comparte ni se muestra como un proyecto normal. */
function personalProjectDirectory(host: RuntimeHost): string {
  const userDataPath = existingProjectDirectory(host.hostAdapter.paths.userDataDir);
  const candidate = path.join(userDataPath, 'personal-project');
  if (existsSync(candidate)) {
    const entry = lstatSync(candidate);
    if (entry.isSymbolicLink()) {
      throw new Error('saurio: la carpeta del espacio personal es un enlace o junction. Eliminá ese enlace para proteger tus proyectos.');
    }
    if (!entry.isDirectory()) {
      throw new Error('saurio: la ruta reservada del espacio personal no es una carpeta.');
    }
  } else {
    mkdirSync(candidate, { recursive: false });
  }

  const canonical = realpathSync.native(candidate);
  const relative = path.relative(userDataPath, canonical);
  if (!isSameDirectory(relative, 'personal-project') || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('saurio: la carpeta del espacio personal sale del directorio privado de la aplicación.');
  }
  return canonical;
}

function assertNotPersonalDirectory(host: RuntimeHost, canonicalPath: string): void {
  const personalPath = path.join(realpathSync.native(host.hostAdapter.paths.userDataDir), 'personal-project');
  const reservedPaths = existsSync(personalPath)
    ? [personalPath, realpathSync.native(personalPath)]
    : [personalPath];
  if (reservedPaths.some((reserved) => directoriesOverlap(reserved, canonicalPath))) {
    throw new Error('saurio: esa carpeta está reservada para el espacio Personal y no se puede abrir como proyecto.');
  }
}

async function openProjectAtPath(host: RuntimeHost, projectPath: string, displayName?: string) {
  const canonicalPath = existingProjectDirectory(projectPath);
  assertNotPersonalDirectory(host, canonicalPath);
  const now = Date.now();
  const repo = host.projectRepository;
  const fallback = {
    id: projectIdFor(canonicalPath),
    path: canonicalPath,
    name: displayName ?? path.basename(canonicalPath),
    createdAt: now,
    lastOpenedAt: now,
  };

  let project = fallback;
  if (repo) {
    const existing = (await repo.list()).find((p) => p.path === canonicalPath || sameExistingDirectory(p.path, canonicalPath));
    if (existing) {
      await repo.touchLastOpened(existing.id, now);
      // Reabrir un proyecto que se había quitado de la lista es una señal explícita de que el
      // usuario quiere recuperarlo; no toca ni archivos ni historial.
      await repo.setRemovedFromRecents(existing.id, false);
      // Las filas creadas por versiones previas pueden conservar una ruta con distinta capitalización
      // o un alias. La sesión usa la raíz canónica sin reescribir el historial persistido.
      project = { ...existing, path: canonicalPath, name: existing.name || fallback.name, lastOpenedAt: now };
    } else {
      project = { ...(await repo.create(fallback)), name: fallback.name, lastOpenedAt: now };
    }
  } else {
    console.warn('[ipc/project] sin runtime real: project:open devuelve un Project efímero, sin persistir');
  }

  // Abrir un proyecto instancia el runtime de ESA raíz y cancela runs del anterior.
  if (host.hasRuntime()) await host.openProject(project);
  return project;
}

export function registerProjectHandlers(host: RuntimeHost): void {
  registerHandler('project:relocate', ipc['project:relocate'], async (input) => {
    if (input.id === PERSONAL_PROJECT_ID) throw new Error('El espacio Personal no se puede reubicar.');
    const repo = host.projectRepository;
    const saved = await repo?.get(input.id);
    if (!saved || !repo?.relocate) throw new Error('No se encontró el proyecto que querés reubicar.');
    let selectedPath = input.path;
    if (!selectedPath) {
      const result = await host.hostAdapter.showOpenDirectoryDialog({ title: `Localizar carpeta de ${saved.name}` });
      if (result.canceled || !result.path) return null;
      selectedPath = result.path;
    }
    const canonicalPath = existingProjectDirectory(selectedPath);
    assertNotPersonalDirectory(host, canonicalPath);
    const collision = (await repo.list()).find((project) => project.id !== saved.id
      && (isSameDirectory(project.path, canonicalPath) || sameExistingDirectory(project.path, canonicalPath)));
    if (collision) throw new Error(`Esa carpeta ya pertenece al proyecto “${collision.name}”. No se mezclaron los historiales.`);
    // Cancelar y liberar la raíz anterior antes de reasociar. Si falla, no cambia la fila.
    if (host.activeProject?.projectId === saved.id) await host.closeProject();
    return repo.relocate(saved.id, canonicalPath);
  });
  registerHandler('project:personal', ipc['project:personal'], async () => {
    const saved = await host.projectRepository?.get(PERSONAL_PROJECT_ID);
    if (!saved || !host.hasRuntime()) throw new Error('No se pudo abrir el espacio personal. Reiniciá la aplicación.');
    // Conserva el ID y los chats heredados; la ruta sintética de SQLite nunca se usa en herramientas.
    const personalPath = personalProjectDirectory(host);
    const collision = (await host.projectRepository?.list())?.find((project) =>
      project.id !== PERSONAL_PROJECT_ID && sameExistingDirectory(project.path, personalPath));
    if (collision) {
      throw new Error(`saurio: la carpeta del espacio personal ya pertenece al proyecto “${collision.name}”. Elegí otra carpeta para ese proyecto.`);
    }
    const project = { ...saved, path: personalPath, lastOpenedAt: Date.now() };
    await host.openProject(project);
    return project;
  });
  registerHandler('project:open', ipc['project:open'], async (input) => {
    let projectPath = input.path;
    if (!projectPath) {
      const dialogResult = await host.hostAdapter.showOpenDirectoryDialog({ title: 'Abrir proyecto' });
      if (dialogResult.canceled || !dialogResult.path) {
        throw new Error('saurio: se canceló la selección de carpeta de proyecto');
      }
      projectPath = dialogResult.path;
    }

    return openProjectAtPath(host, projectPath);
  });

  registerHandler('project:createManaged', ipc['project:createManaged'], async (input) => {
    const managedRoot = path.join(host.hostAdapter.paths.userDataDir, 'managed-projects');
    mkdirSync(managedRoot, { recursive: true });
    const projectPath = path.join(managedRoot, managedFolderName(input.name));
    // El sufijo aleatorio hace que una creación nunca pise un proyecto anterior de igual nombre.
    mkdirSync(projectPath, { recursive: false });
    return openProjectAtPath(host, projectPath, input.name);
  });

  registerHandler('project:list', ipc['project:list'], async () => {
    const repo = host.projectRepository;
    if (!repo) return [];
    // Doc 19 §0 (E2a "Mis agentes"): el proyecto personal sintético (chats directos con un agente
    // fuera de cualquier proyecto abierto) nunca aparece en el selector visible de proyectos. La
    // lista visible respeta además `project:remove`: quitar un proyecto de SaurioLLM conserva sus
    // archivos e historial, pero no debe reaparecer en la barra lateral por este endpoint.
    return (await repo.listRecent())
      .map((entry) => entry.project)
      .filter((p) => p.id !== PERSONAL_PROJECT_ID);
  });

  // Punto 12 del encargo ("proyectos persistentes como Claude Code/Codex"): lista de proyectos
  // abiertos alguna vez, más reciente primero, con cantidad de chats y si la carpeta sigue
  // existiendo — `folderExists` se resuelve acá (fs.existsSync, síncrono y barato) porque
  // packages/runtime/src/persistence no debe importar `node:fs` (regla de esa zona, sin fs directo).
  registerHandler('project:recent', ipc['project:recent'], async () => {
    const repo = host.projectRepository;
    if (!repo) return [];
    const rows = await repo.listRecent();
    return rows
      .filter((r) => r.project.id !== PERSONAL_PROJECT_ID)
      .map((r) => ({
        id: r.project.id, path: r.project.path, name: r.project.name,
        lastOpenedAt: r.project.lastOpenedAt, chatCount: r.chatCount,
        folderExists: existsSync(r.project.path),
      }));
  });

  registerHandler('project:remove', ipc['project:remove'], async (input) => {
    if (input.id === PERSONAL_PROJECT_ID) {
      throw new Error('saurio: el espacio Personal no se puede quitar de SaurioLLM.');
    }
    const repo = host.projectRepository;
    if (!repo) return;
    if (host.activeProject?.projectId === input.id) await host.closeProject();
    await repo.setRemovedFromRecents(input.id, true);
  });

  registerHandler('project:rename', ipc['project:rename'], async (input) => {
    if (input.id === PERSONAL_PROJECT_ID) {
      throw new Error('saurio: el espacio Personal no se puede renombrar.');
    }
    const repo = host.projectRepository;
    if (!repo) throw new Error('saurio: sin runtime real, no se puede renombrar el proyecto');
    return repo.rename(input.id, input.name);
  });
}
