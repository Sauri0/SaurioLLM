// Proyección de `tasks` desde run_events (`tasks.updated`) — doc 03 §4.6/§6, doc 04 §6.
// packages/runtime/src/events/projections/tasks.ts.
// "TaskManager sobreescribe, no acumula por run" (doc 03 §7): cada evento trae la lista completa
// vigente; se reemplaza la proyección de ese chat, incluso si la lista queda vacía. Esta función
// no abre una transacción: SqliteEventStore.append() y rebuild() ya la proveen.
import type { SqliteDriver } from '../../persistence/driver.js';
import type { RunEvent } from '@saurio/shared';

export function applyToTasks(driver: SqliteDriver, event: RunEvent): void {
  if (event.type !== 'tasks.updated') return;
  driver.prepare('DELETE FROM tasks WHERE chat_id = ?').run(event.chatId);
  for (const task of event.tasks) {
    driver.prepare(
      `INSERT INTO tasks (id, chat_id, run_id, ord, title, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(task.id, event.chatId, event.runId, task.ord, task.title, task.status, event.ts);
  }
}
