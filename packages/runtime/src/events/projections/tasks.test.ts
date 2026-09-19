import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@saurio/shared';
import { SqliteEventStore } from '../index.js';
import { openDriver, type SqliteDriver } from '../../persistence/driver.js';
import { runMigrations } from '../../persistence/migrations/index.js';
import { rebuild } from '../../persistence/rebuild.js';

function task(id: string, chatId: string, ord: number): Task {
  return { id, chatId, ord, title: `Paso ${id}`, status: 'pending' };
}

function seedRuns(driver: SqliteDriver): void {
  const now = Date.now();
  driver.prepare('INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)')
    .run('project-1', 'N:/task-projection-test', 'task-projection-test', now);
  driver.prepare(
    `INSERT INTO agents (id, project_id, name, role, model_ref_json, system_prompt, system_prompt_hash,
       allowed_tools_json, permission_policy_json, context_policy_json, default_mode, thinking,
       tool_transport, max_iterations, is_builtin, updated_at)
     VALUES ('agent-1', NULL, 'Coder', 'coder', '{}', 'sistema', 'hash', '[]', '{}', '{}', 'agent', 'off', 'auto', 10, 1, ?)`,
  ).run(now);
  for (const id of ['chat-1', 'chat-2']) {
    driver.prepare(
      `INSERT INTO chats (id, project_id, agent_id, mode, created_at, updated_at)
       VALUES (?, 'project-1', 'agent-1', 'agent', ?, ?)`,
    ).run(id, now, now);
    driver.prepare(
      `INSERT INTO runs (id, chat_id, agent_id, mode, model_ref_json, effective_config_json, state, started_at)
       VALUES (?, ?, 'agent-1', 'agent', '{}', '{}', 'generating', ?)`,
    ).run(`run-${id}`, id, now);
  }
}

function taskRows(driver: SqliteDriver): unknown[] {
  return driver.prepare('SELECT id, chat_id, run_id, ord, title, status FROM tasks ORDER BY chat_id, ord').all();
}

describe('events/projections/tasks', () => {
  let dir: string;
  let driver: SqliteDriver;
  let store: SqliteEventStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'saurio-task-projection-test-'));
    driver = openDriver(path.join(dir, 'saurio.db'));
    runMigrations(driver);
    seedRuns(driver);
    store = new SqliteEventStore(driver);
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reemplaza la lista completa por chat y rebuild reproduce el resultado', () => {
    store.append({ runId: 'run-chat-1', chatId: 'chat-1', ts: 1, type: 'tasks.updated', tasks: [
      task('a', 'chat-1', 0), task('b', 'chat-1', 1), task('c', 'chat-1', 2),
    ] });
    store.append({ runId: 'run-chat-2', chatId: 'chat-2', ts: 2, type: 'tasks.updated', tasks: [task('other', 'chat-2', 0)] });
    store.append({ runId: 'run-chat-1', chatId: 'chat-1', ts: 3, type: 'tasks.updated', tasks: [
      task('a', 'chat-1', 0), task('d', 'chat-1', 1),
    ] });
    store.append({ runId: 'run-chat-1', chatId: 'chat-1', ts: 4, type: 'tasks.updated', tasks: [] });

    const before = taskRows(driver);
    expect(before).toEqual([{ id: 'other', chat_id: 'chat-2', run_id: 'run-chat-2', ord: 0, title: 'Paso other', status: 'pending' }]);

    rebuild(driver);
    expect(taskRows(driver)).toEqual(before);
  });
});
