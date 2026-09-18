// Handlers IPC del dominio "project" (doc 02 §1: apps/desktop/src/main/ipc/project.ts, doc 01 §6).
// project:open abre un diálogo nativo (HostAdapter.showOpenDirectoryDialog) cuando no se pasa `path`.
import path from 'node:path';
import { ipc } from '@saurio/shared';
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
    return repo.list();
  });
}
