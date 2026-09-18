// Tasks: manager de la lista de tareas del run — packages/runtime/src/tasks/types.ts.
// Define: doc 04 §10. Solo interfaz (sin implementación). Task/Plan ya están definidos en
// @saurio/shared (domain.ts, doc 04 §2); acá solo el manager.
import type { Task } from '@saurio/shared';

export type { Task };

export interface TaskManager {
  update(chatId: string, runId: string, tasks: Omit<Task, 'chatId'>[]): Promise<Task[]>;   // tool task_update
  list(chatId: string): Promise<Task[]>;
}
