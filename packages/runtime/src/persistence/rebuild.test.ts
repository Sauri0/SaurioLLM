// Test de `saurio db rebuild`: reproyectar desde run_events debe reproducir bit a bit las mismas
// proyecciones (doc 03 §8, "criterio de listo del MVP, §10" citado por doc 10 §2).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDriver, type SqliteDriver } from './driver.js';
import { runMigrations } from './migrations/index.js';
import { SqliteEventStore } from '../events/index.js';
import { rebuild } from './rebuild.js';

function seedRun(driver: SqliteDriver): { chatId: string; runId: string } {
  const now = Date.now();
  driver.prepare('INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)')
    .run('proj1', 'N:/fake-project', 'fake', now);
  driver.prepare(
    `INSERT INTO agents (id, project_id, name, role, model_ref_json, system_prompt, system_prompt_hash,
       allowed_tools_json, permission_policy_json, context_policy_json, default_mode, thinking,
       tool_transport, max_iterations, is_builtin, updated_at)
     VALUES ('agent1', NULL, 'Coder', 'coder', '{}', 'eres coder', 'hash', '[]', '{}', '{}', 'agent', 'off', 'auto', 10, 1, ?)`,
  ).run(now);
  driver.prepare(
    `INSERT INTO chats (id, project_id, agent_id, mode, created_at, updated_at)
     VALUES ('chat1', 'proj1', 'agent1', 'agent', ?, ?)`,
  ).run(now, now);
  driver.prepare(
    `INSERT INTO runs (id, chat_id, agent_id, mode, model_ref_json, effective_config_json, state, started_at)
     VALUES ('run1', 'chat1', 'agent1', 'agent', '{}', '{}', 'generating', ?)`,
  ).run(now);
  return { chatId: 'chat1', runId: 'run1' };
}

function snapshot(driver: SqliteDriver): unknown {
  const tables = ['messages', 'tool_calls', 'tasks'];
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    out[t] = driver.prepare(`SELECT * FROM ${t} ORDER BY id`).all();
  }
  out.runsState = driver.prepare('SELECT id, state, state_reason FROM runs ORDER BY id').all();
  return out;
}

describe('persistence/rebuild', () => {
  let dir: string;
  let driver: SqliteDriver;
  let store: SqliteEventStore;
  let chatId: string;
  let runId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'saurio-rebuild-test-'));
    driver = openDriver(path.join(dir, 'saurio.db'));
    runMigrations(driver);
    ({ chatId, runId } = seedRun(driver));
    store = new SqliteEventStore(driver);

    store.append({ runId, chatId, ts: 1, type: 'run.state', from: 'created', to: 'preparing' });
    store.append({
      runId, chatId, ts: 2, type: 'tool.registered',
      call: { id: 'tc1', runId, iteration: 1, toolName: 'read_file', args: { path: 'a.ts' }, argsHash: 'h1', category: 'read', risk: 'low', transport: 'native', status: 'pending' },
    });
    store.append({ runId, chatId, ts: 3, type: 'tool.status', toolCallId: 'tc1', status: 'running' });
    store.append({ runId, chatId, ts: 4, type: 'tool.status', toolCallId: 'tc1', status: 'done', resultPreview: 'ok' });
    store.append({
      runId, chatId, ts: 5, type: 'message.done',
      message: { id: 'msg1', role: 'assistant', content: 'listo' },
      metrics: { quality: 'measured' },
    });
    store.append({
      runId, chatId, ts: 6, type: 'tasks.updated',
      tasks: [{ id: 'task1', chatId, ord: 0, title: 'leer archivo', status: 'done' }],
    });
    store.append({ runId, chatId, ts: 7, type: 'run.state', from: 'generating', to: 'completed' });
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reproduce proyecciones idénticas tras rebuild', () => {
    const before = snapshot(driver);
    rebuild(driver);
    const after = snapshot(driver);
    expect(after).toEqual(before);
  });

  it('no toca run_events (la fuente de verdad)', () => {
    const before = driver.prepare('SELECT COUNT(*) AS n FROM run_events').get() as { n: number };
    rebuild(driver);
    const after = driver.prepare('SELECT COUNT(*) AS n FROM run_events').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('re-vincula checkpoints existentes con la fila de tool_calls reproyectada del mismo id', () => {
    driver.prepare(
      `INSERT INTO checkpoints (id, run_id, chat_id, tool_call_id, kind, created_at, status)
       VALUES ('ck1', ?, ?, 'tc1', 'tool', ?, 'active')`,
    ).run(runId, chatId, Date.now());
    driver.prepare('UPDATE tool_calls SET checkpoint_id = ? WHERE id = ?').run('ck1', 'tc1');

    rebuild(driver);

    const tc = driver.prepare('SELECT checkpoint_id FROM tool_calls WHERE id = ?').get('tc1') as { checkpoint_id: string | null };
    expect(tc.checkpoint_id).toBe('ck1');
    const ck = driver.prepare('SELECT id FROM checkpoints WHERE id = ?').get('ck1') as { id: string } | undefined;
    expect(ck?.id).toBe('ck1');
  });
});
