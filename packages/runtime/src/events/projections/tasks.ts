// Proyección de `tasks` desde run_events (`tasks.updated`) — doc 03 §4.6/§6, doc 04 §6.
// packages/runtime/src/events/projections/tasks.ts.
// "TaskManager sobreescribe, no acumula por run" (doc 03 §7): cada evento trae la lista completa
// vigente; se hace upsert por id y se sincroniza el ord/status/title.
import type { SqliteDriver } from '../../persistence/driver.js';
import type { RunEvent } from '@saurio/shared';

export function applyToTasks(driver: SqliteDriver, event: RunEvent): void {
  if (event.type !== 'tasks.updated') return;
  for (const task of event.tasks) {
    driver.prepare(
      `INSERT INTO tasks (id, chat_id, run_id, ord, title, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ord = excluded.ord, title = excluded.title, status = excluded.status,
         run_id = excluded.run_id, updated_at = excluded.updated_at`,
    ).run(task.id, task.chatId, event.runId, task.ord, task.title, task.status, event.ts);
  }
}
