// Test de ToolCallRepository — packages/runtime/src/persistence/repositories/toolCall.test.ts.
// Cubre doc 10 §3/§5.2, doc 16 §4 ítem 16: `expected_pre_hash` viaja en upsert()/get() y sobrevive a
// cerrar y reabrir la conexión SQLite (lo que antes vivía solo en el `ReadTracker` en memoria de
// packages/runtime/src/tools no sobrevivía a un reinicio real del proceso).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDriver, type SqliteDriver } from '../driver.js';
import { runMigrations } from '../migrations/index.js';
import { createToolCallRepository } from './toolCall.js';
import type { ToolCallRecord } from '@saurio/shared';

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

function baseRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'tc-1', runId: 'run1', iteration: 0, toolName: 'edit_file', args: { path: 'a.ts' },
    argsHash: 'hash1', category: 'write', risk: 'medium', transport: 'native', status: 'pending',
    ...overrides,
  };
}

describe('persistence/repositories/toolCall (expected_pre_hash)', () => {
  let dir: string;
  let dbPath: string;
  let driver: SqliteDriver;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'saurio-toolcall-repo-test-'));
    dbPath = path.join(dir, 'saurio.db');
    driver = openDriver(dbPath);
    runMigrations(driver);
    seedRun(driver);
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('upsert() con expectedPreHash lo persiste; get() lo devuelve', async () => {
    const repo = createToolCallRepository(driver);
    await repo.upsert(baseRecord({ expectedPreHash: 'sha-abc' }));
    const got = await repo.get('tc-1');
    expect(got?.expectedPreHash).toBe('sha-abc');
  });

  it('sin expectedPreHash, get() lo devuelve undefined (NULL en SQLite)', async () => {
    const repo = createToolCallRepository(driver);
    await repo.upsert(baseRecord());
    const got = await repo.get('tc-1');
    expect(got?.expectedPreHash).toBeUndefined();
  });

  it('upserts posteriores (cambio de status) conservan el expectedPreHash ya escrito', async () => {
    const repo = createToolCallRepository(driver);
    const record = baseRecord({ expectedPreHash: 'sha-abc' });
    await repo.upsert(record);
    await repo.upsert({ ...record, status: 'running' });
    await repo.upsert({ ...record, status: 'done', resultIsError: false });
    const got = await repo.get('tc-1');
    expect(got?.status).toBe('done');
    expect(got?.expectedPreHash).toBe('sha-abc');
  });

  it('sobrevive a cerrar y reabrir la conexión (simulacro de reinicio real, doc 10 §5.2)', async () => {
    const repo = createToolCallRepository(driver);
    await repo.upsert(baseRecord({ expectedPreHash: 'sha-sobrevive', status: 'awaiting_permission' }));
    driver.close();

    const reopened = openDriver(dbPath);
    try {
      const repo2 = createToolCallRepository(reopened);
      const got = await repo2.get('tc-1');
      expect(got?.status).toBe('awaiting_permission');
      expect(got?.expectedPreHash).toBe('sha-sobrevive');
    } finally {
      reopened.close();
    }
  });

  it('listByRun() incluye expectedPreHash en cada fila', async () => {
    const repo = createToolCallRepository(driver);
    await repo.upsert(baseRecord({ expectedPreHash: 'sha-1' }));
    const list = await repo.listByRun('run1');
    expect(list).toHaveLength(1);
    expect(list[0]?.expectedPreHash).toBe('sha-1');
  });
});
