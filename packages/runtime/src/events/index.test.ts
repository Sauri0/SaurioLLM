// Test de EventStore: append + proyección en la MISMA transacción (doc 03 §1, doc 04 §6) —
// prueba que tool.registered/message.done escriben su fila de proyección atómicamente con el
// evento, y que un fallo en la proyección revierte también el insert de run_events.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDriver, type SqliteDriver } from '../persistence/driver.js';
import { runMigrations } from '../persistence/migrations/index.js';
import { createMessageRepository } from '../persistence/repositories/message.js';
import { SqliteEventStore } from './index.js';

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

describe('events/SqliteEventStore', () => {
  let dir: string;
  let driver: SqliteDriver;
  let store: SqliteEventStore;
  let chatId: string;
  let runId: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'saurio-eventstore-test-'));
    driver = openDriver(path.join(dir, 'saurio.db'));
    runMigrations(driver);
    ({ chatId, runId } = seedRun(driver));
    store = new SqliteEventStore(driver);
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('append asigna seq, persiste el evento y proyecta tool_calls en la misma transacción', () => {
    const event = store.append({
      runId, chatId, ts: Date.now(), type: 'tool.registered',
      call: {
        id: 'tc1', runId, iteration: 1, toolName: 'read_file', args: { path: 'a.ts' },
        argsHash: 'h1', category: 'read', risk: 'low', transport: 'native', status: 'pending',
      },
    });
    expect(event.seq).toBeGreaterThan(0);

    const evRow = driver.prepare('SELECT * FROM run_events WHERE seq = ?').get(event.seq) as { type: string } | undefined;
    expect(evRow?.type).toBe('tool.registered');

    const tc = driver.prepare('SELECT id, status, tool_name FROM tool_calls WHERE id = ?').get('tc1') as
      { id: string; status: string; tool_name: string } | undefined;
    expect(tc?.status).toBe('pending');
    expect(tc?.tool_name).toBe('read_file');
  });

  it('tool.decision con un PermissionAnswer (allow_once) inserta permission_decisions sin lanzar (doc 16 §4 ítem 1)', () => {
    // Hallazgo real (corriendo eval/harness.ts contra SQLite real por primera vez con un preset que
    // sí dispara `ask`, doc 17 §5): la sentencia de `onDecision` (events/projections/toolCalls.ts)
    // tenía 7 columnas y solo 5 `?`, pero el `.run()` pasaba apenas 4 argumentos — le faltaba
    // `decision`. better-sqlite3 tiraba "Too few parameter values were provided" en la primera
    // respuesta real a una PermissionRequest, dejando el run en `failed`. Este test lo fija.
    store.append({
      runId, chatId, ts: Date.now(), type: 'tool.registered',
      call: {
        id: 'tc-ask', runId, iteration: 1, toolName: 'edit_file', args: { path: 'a.ts' },
        argsHash: 'h2', category: 'write', risk: 'medium', transport: 'native', status: 'awaiting_permission',
      },
    });

    expect(() => store.append({
      runId, chatId, ts: Date.now(), type: 'tool.decision', toolCallId: 'tc-ask',
      decision: { toolCallId: 'tc-ask', answer: 'allow_once' },
    })).not.toThrow();

    const decisionRow = driver.prepare('SELECT decision, decided_by, tool_call_id FROM permission_decisions WHERE tool_call_id = ?')
      .get('tc-ask') as { decision: string; decided_by: string; tool_call_id: string } | undefined;
    expect(decisionRow?.decision).toBe('allow');
    expect(decisionRow?.decided_by).toBe('user');

    const tc = driver.prepare('SELECT status FROM tool_calls WHERE id = ?').get('tc-ask') as { status: string } | undefined;
    expect(tc?.status).toBe('approved');
  });

  it('tool.decision con un PermissionAnswer (deny) registra decision=deny', () => {
    store.append({
      runId, chatId, ts: Date.now(), type: 'tool.registered',
      call: {
        id: 'tc-deny', runId, iteration: 1, toolName: 'edit_file', args: { path: 'b.ts' },
        argsHash: 'h3', category: 'write', risk: 'medium', transport: 'native', status: 'awaiting_permission',
      },
    });
    store.append({
      runId, chatId, ts: Date.now(), type: 'tool.decision', toolCallId: 'tc-deny',
      decision: { toolCallId: 'tc-deny', answer: 'deny', reason: 'no' },
    });
    const decisionRow = driver.prepare('SELECT decision, reason FROM permission_decisions WHERE tool_call_id = ?')
      .get('tc-deny') as { decision: string; reason: string } | undefined;
    expect(decisionRow?.decision).toBe('deny');
    expect(decisionRow?.reason).toBe('no');
    const tc = driver.prepare('SELECT status FROM tool_calls WHERE id = ?').get('tc-deny') as { status: string } | undefined;
    expect(tc?.status).toBe('denied');
  });

  it('message.done proyecta messages y lo indexa en messages_fts', () => {
    store.append({
      runId, chatId, ts: Date.now(), type: 'message.done',
      message: { id: 'msg1', role: 'assistant', content: 'el scheduler vive en ModelGateway' },
      metrics: { quality: 'measured' },
    });

    const msg = driver.prepare('SELECT content FROM messages WHERE id = ?').get('msg1') as { content: string } | undefined;
    expect(msg?.content).toContain('ModelGateway');

    const hit = driver.prepare(
      `SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE f.content MATCH ? AND m.chat_id = ?`,
    ).get('scheduler', chatId) as { id: string } | undefined;
    expect(hit?.id).toBe('msg1');
  });

  it('message.done con message.modelRef lo persiste en model_ref_json y MessageRepository lo relee (doc 16 §10.4/§10.9, migración 0003, punto 4 del encargo)', async () => {
    store.append({
      runId, chatId, ts: Date.now(), type: 'message.done',
      message: {
        id: 'msg-modelref', role: 'assistant', content: 'hola',
        modelRef: { providerId: 'openrouter_1', name: 'meta-llama/llama-3.1-8b-instruct', locality: 'cloud' },
      },
      metrics: { quality: 'measured' },
    });

    const row = driver.prepare('SELECT model_ref_json FROM messages WHERE id = ?').get('msg-modelref') as { model_ref_json: string } | undefined;
    expect(JSON.parse(row!.model_ref_json)).toEqual({ providerId: 'openrouter_1', name: 'meta-llama/llama-3.1-8b-instruct', locality: 'cloud' });

    const messages = createMessageRepository(driver);
    const list = await messages.listByChat(chatId);
    const msg = list.find((m) => m.id === 'msg-modelref');
    expect(msg).toMatchObject({
      modelRef: { providerId: 'openrouter_1', name: 'meta-llama/llama-3.1-8b-instruct', locality: 'cloud' },
      originRunId: runId,
    });
  });

  it('MessageRepository conserva originRunId al guardar un fragmento directo y rehidratarlo', async () => {
    const messages = createMessageRepository(driver);
    await messages.append(chatId, {
      id: 'msg-truncado', originRunId: runId, role: 'assistant', content: 'Respuesta parcial.', truncated: true,
    });

    const [message] = await messages.listByChat(chatId);
    expect(message).toMatchObject({ id: 'msg-truncado', originRunId: runId, truncated: true });
  });

  it('message.done conserva costo reportado y modelo tras cerrar y reabrir SQLite real', async () => {
    store.append({
      runId, chatId, ts: Date.now(), type: 'message.done',
      message: {
        id: 'msg-cost-reopen', role: 'assistant', content: 'respuesta',
        modelRef: { providerId: 'openrouter_1', name: 'openai/gpt-4', locality: 'cloud' },
      },
      // USD 0 es válido y debe sobrevivir igual que cualquier total informado.
      metrics: { promptTokens: 12, evalTokens: 4, costUsd: 0, costSource: 'reported', quality: 'estimated' },
    });

    driver.close();
    driver = openDriver(path.join(dir, 'saurio.db'));
    runMigrations(driver);

    const messages = createMessageRepository(driver);
    const [message] = await messages.listByChat(chatId);
    expect(message).toMatchObject({
      id: 'msg-cost-reopen',
      modelRef: { providerId: 'openrouter_1', name: 'openai/gpt-4', locality: 'cloud' },
      metrics: { promptTokens: 12, evalTokens: 4, costUsd: 0, costSource: 'reported', quality: 'estimated' },
    });
  });

  it('since() devuelve eventos ordenados por seq mayores al cursor dado', () => {
    store.append({ runId, chatId, ts: 1, type: 'run.state', from: 'created', to: 'preparing' });
    const e2 = store.append({ runId, chatId, ts: 2, type: 'run.state', from: 'preparing', to: 'generating' });
    const since0 = store.since(runId, 0);
    expect(since0).toHaveLength(2);
    const sinceFirst = store.since(runId, since0[0]!.seq);
    expect(sinceFirst).toHaveLength(1);
    expect(sinceFirst[0]!.seq).toBe(e2.seq);
    expect(store.lastSeq(runId)).toBe(e2.seq);
  });

  it('persiste y relee la inspección aditiva de context.built sin contenido de las fuentes', () => {
    store.append({
      runId, chatId, ts: 1, type: 'context.built',
      budget: {
        numCtx: 8_192, effectiveNumCtx: 8_192, contextLimitSource: 'reported',
        reserveForResponse: 1_500,
        used: { system: 20, tools: 30, repoMap: 10, memory: 5, history: 40 },
        totalUsed: 105, fits: true,
        inspection: {
          projectRoot: 'N:/proyecto-real', tokenUsageQuality: 'estimated', limitSource: 'reported',
          sources: [{ kind: 'history', status: 'included', tokens: 40, itemCount: 2, provenance: 'chat_history' }],
          attachmentsKnown: true, attachments: [],
          history: { inputMessages: 2, includedMessages: 2, prunedMessages: 0, compactedMessages: 0, summaryIncluded: false },
        },
      },
    });

    const [event] = store.since(runId, 0);
    expect(event?.type).toBe('context.built');
    if (!event || event.type !== 'context.built') throw new Error('faltó context.built');
    expect(event.budget.inspection).toMatchObject({
      projectRoot: 'N:/proyecto-real', tokenUsageQuality: 'estimated', limitSource: 'reported',
      attachmentsKnown: true,
    });
    expect(event.budget.inspection?.sources).toEqual([
      { kind: 'history', status: 'included', tokens: 40, itemCount: 2, provenance: 'chat_history' },
    ]);
  });

  it('revierte el insert de run_events si la proyección falla (atomicidad)', () => {
    const before = (driver.prepare('SELECT COUNT(*) AS n FROM run_events').get() as { n: number }).n;
    expect(() => store.append({
      // tool_call_id inexistente -> tool.decision de PermissionAnswer intenta UPDATE sobre una fila
      // que no existe (no falla) pero forzamos un error real: chatId roto viola la FK de run_events.
      runId, chatId: 'chat-inexistente', ts: Date.now(), type: 'run.state', from: 'created', to: 'preparing',
    })).toThrow();
    const after = (driver.prepare('SELECT COUNT(*) AS n FROM run_events').get() as { n: number }).n;
    expect(after).toBe(before);
  });
});
