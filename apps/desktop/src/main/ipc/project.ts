// Handlers IPC del dominio "project" (doc 02 §1: apps/desktop/src/main/ipc/project.ts, doc 01 §6).
// project:open abre un diálogo nativo (HostAdapter.showOpenDirectoryDialog) cuando no se pasa `path`.
import { existsSync } from 'node:fs';
import path from 'node:path';
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

export function registerProjectHandlers(host: RuntimeHost): void {
  registerHandler('project:open', ipc['project:open'], async (input) => {
    let projectPath = input.path;
    if (!projectPath) {
      const dialogResult = await host.hostAdapter.showOpenDirectoryDialog({ title: 'Abrir proyecto' });
      if (dialogResult.canceled || !dialogResult.path) {
        throw new Error('saurio: se canceló la selección de carpeta de proyecto');
      }
      projectPath = dialogResult.path;
    }

    const now = Date.now();
    const repo = host.projectRepository;
    const fallback = {
      id: projectIdFor(projectPath),
      path: projectPath,
      name: path.basename(projectPath),
      createdAt: now,
      lastOpenedAt: now,
    };

    let project = fallback;
    if (repo) {
      const existing = (await repo.list()).find((p) => p.path === projectPath);
      if (existing) {
        await repo.touchLastOpened(existing.id, now);
        // Punto 12 del encargo: reabrir un proyecto que se había sacado de "recientes"
        // (project:remove) lo reingresa a la lista — abrirlo es una señal explícita de que el
        // usuario lo quiere ahí de nuevo.
        await repo.setRemovedFromRecents(existing.id, false);
        project = { ...existing, name: existing.name ?? path.basename(projectPath), lastOpenedAt: now };
      } else {
        project = { ...(await repo.create(fallback)), name: fallback.name, lastOpenedAt: now };
      }
    } else {
      console.warn('[ipc/project] sin runtime real: project:open devuelve un Project efímero, sin persistir');
    }

    // Abrir un proyecto es lo que instancia el RunController/CheckpointService/repo map de esa raíz
    // (ver host/RuntimeHost.ts): sin esto, run:* y checkpoint:* no tienen contra qué workspace correr.
    // Punto 7.a del encargo: `openProject` cancela los runs vivos del proyecto anterior antes de
    // reemplazarlo (un solo proyecto abierto a la vez).
    if (host.hasRuntime()) await host.openProject(project);
    return project;
  });

  registerHandler('project:list', ipc['project:list'], async () => {
    const repo = host.projectRepository;
    if (!repo) return [];
    // Doc 19 §0 (E2a "Mis agentes"): el proyecto personal sintético (chats directos con un agente
    // fuera de cualquier proyecto abierto) nunca aparece en el selector visible de proyectos.
    return (await repo.list()).filter((p) => p.id !== PERSONAL_PROJECT_ID);
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
    const repo = host.projectRepository;
    if (!repo) return;
    await repo.setRemovedFromRecents(input.id, true);
  });

  registerHandler('project:rename', ipc['project:rename'], async (input) => {
    const repo = host.projectRepository;
    if (!repo) throw new Error('saurio: sin runtime real, no se puede renombrar el proyecto');
    return repo.rename(input.id, input.name);
  });
}
