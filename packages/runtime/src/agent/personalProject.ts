// personalProject: proyecto personal sintético para chats directos con un agente — packages/runtime/src/agent/personalProject.ts.
// Doc 19 §0 (E2a "Mis agentes"): en vez de relajar `chats.project_id NOT NULL` (reconstruiría la
// tabla), se crea un proyecto sintético fijo al primer arranque; un chat directo con un agente
// personal fuera de cualquier proyecto abierto vive ahí. `apps/desktop/src/main/ipc/project.ts`
// (`project:list`) es responsable de excluirlo del selector visible de proyectos.
import type { Project } from '@saurio/shared';
import type { ProjectRepository } from '../persistence/types.js';

export const PERSONAL_PROJECT_ID = 'project_personal';

/** Path fijo y reconocible (nunca se abre como carpeta real, `ProjectRepository.create` solo exige
 *  que `path` sea único) — evita colisionar con la ruta real de algún proyecto que el usuario abra. */
const PERSONAL_PROJECT_PATH = '\0saurio-personal';

/** Idempotente: si ya existe (arranques posteriores), devuelve la fila existente sin tocarla. */
export async function ensurePersonalProject(
  projects: ProjectRepository, now: () => number = Date.now,
): Promise<Project> {
  const existing = await projects.get(PERSONAL_PROJECT_ID);
  if (existing) return existing;
  const ts = now();
  return projects.create({
    id: PERSONAL_PROJECT_ID,
    path: PERSONAL_PROJECT_PATH,
    name: 'Personal',
    createdAt: ts,
    lastOpenedAt: ts,
  });
}

export function isPersonalProject(projectId: string): boolean {
  return projectId === PERSONAL_PROJECT_ID;
}
