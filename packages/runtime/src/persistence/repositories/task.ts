// TaskRepository (doc 03 §4.6, doc 04 §2 Task) — packages/runtime/src/persistence/repositories/task.ts.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { TaskRepository } from '../types.js';
import type { Task } from '@saurio/shared';

interface TaskRow extends SqliteRow {
  id: string; chat_id: string; ord: number; title: string; status: string;
}

function rowToTask(row: TaskRow): Task {
  return { id: row.id, chatId: row.chat_id, ord: row.ord, title: row.title, status: row.status as Task['status'] };
}

export function createTaskRepository(driver: SqliteDriver): TaskRepository {
  return {
    async upsertMany(chatId: string, tasks: Task[]): Promise<Task[]> {
      const now = Date.now();
      // `task_update` entrega el checklist entero vigente para ESTE chat. Borrar antes de
      // insertar también maneja una lista vacía y evita que sobrevivan pasos omitidos en la nueva
      // versión. La operación directa del repositorio necesita su propia transacción; la
      // proyección de eventos ya corre dentro de la de SqliteEventStore.
      driver.exec('BEGIN IMMEDIATE');
      try {
        driver.prepare('DELETE FROM tasks WHERE chat_id = ?').run(chatId);
        for (const task of tasks) {
          driver.prepare(
            `INSERT INTO tasks (id, chat_id, run_id, ord, title, status, updated_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?)`,
          ).run(task.id, chatId, task.ord, task.title, task.status, now);
        }
        driver.exec('COMMIT');
      } catch (error) {
        driver.exec('ROLLBACK');
        throw error;
      }
      return tasks;
    },
    async listByChat(chatId: string): Promise<Task[]> {
      return driver.prepare<TaskRow>('SELECT * FROM tasks WHERE chat_id = ? ORDER BY ord ASC').all(chatId).map(rowToTask);
    },
  };
}
