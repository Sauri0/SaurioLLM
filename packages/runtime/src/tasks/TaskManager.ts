// DefaultTaskManager: implementación de TaskManager — packages/runtime/src/tasks/TaskManager.ts.
// Define: doc 05 §2.9 paso 35 ("si la tool fue task_update, se actualiza la proyección tasks y se
// emite tasks.updated"). Inyecta TaskRepository (persistence/types.ts, sin modificar) y EventStore.
import type { Task } from '@saurio/shared';
import type { TaskRepository, EventStore } from '../persistence/types.js';
import type { TaskManager } from './types.js';

export interface TaskManagerDeps {
  tasks: TaskRepository;
  events: EventStore;
  clock: { now(): number };
}

export class DefaultTaskManager implements TaskManager {
  constructor(private readonly deps: TaskManagerDeps) {}

  async update(chatId: string, runId: string, tasks: Omit<Task, 'chatId'>[]): Promise<Task[]> {
    const full: Task[] = tasks.map((t) => ({ ...t, chatId }));
    const saved = await this.deps.tasks.upsertMany(chatId, full);
    this.deps.events.append({
      runId, chatId, ts: this.deps.clock.now(), type: 'tasks.updated', tasks: saved,
    });
    return saved;
  }

  async list(chatId: string): Promise<Task[]> {
    return this.deps.tasks.listByChat(chatId);
  }
}
