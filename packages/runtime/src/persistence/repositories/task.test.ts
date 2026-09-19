import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@saurio/shared';
import { openDriver, type SqliteDriver } from '../driver.js';
import { runMigrations } from '../migrations/index.js';
import { createTaskRepository } from './task.js';

function task(id: string, chatId: string, ord: number, status: Task['status'] = 'pending'): Task {
  return { id, chatId, ord, title: `Paso ${id}`, status };
}

function seedChats(driver: SqliteDriver): void {
  const now = Date.now();
  driver.prepare('INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)')
    .run('project-1', 'N:/tasks-test', 'tasks-test', now);
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
  }
}

describe('persistence/repositories/task', () => {
  let dir: string;
  let driver: SqliteDriver;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'saurio-task-repo-test-'));
    driver = openDriver(path.join(dir, 'saurio.db'));
    runMigrations(driver);
    seedChats(driver);
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reemplaza 3 tareas por 2 y luego por vacío, sin tocar otro chat', async () => {
    const repo = createTaskRepository(driver);
    await repo.upsertMany('chat-1', [task('a', 'chat-1', 0), task('b', 'chat-1', 1), task('c', 'chat-1', 2)]);
    await repo.upsertMany('chat-2', [task('other', 'chat-2', 0, 'done')]);

    await repo.upsertMany('chat-1', [task('a', 'chat-1', 0, 'done'), task('d', 'chat-1', 1)]);
    expect((await repo.listByChat('chat-1')).map((item) => item.id)).toEqual(['a', 'd']);
    expect(await repo.listByChat('chat-2')).toEqual([task('other', 'chat-2', 0, 'done')]);

    await repo.upsertMany('chat-1', []);
    expect(await repo.listByChat('chat-1')).toEqual([]);
    expect(await repo.listByChat('chat-2')).toEqual([task('other', 'chat-2', 0, 'done')]);
  });

  it('revierte el reemplazo completo si una tarea viola la restricción SQLite', async () => {
    const repo = createTaskRepository(driver);
    const original = [task('a', 'chat-1', 0), task('b', 'chat-1', 1), task('c', 'chat-1', 2)];
    await repo.upsertMany('chat-1', original);

    await expect(repo.upsertMany('chat-1', [
      task('replacement', 'chat-1', 0),
      task('invalid', 'chat-1', 1, 'invalid' as Task['status']),
    ])).rejects.toThrow();

    expect(await repo.listByChat('chat-1')).toEqual(original);
  });
});
