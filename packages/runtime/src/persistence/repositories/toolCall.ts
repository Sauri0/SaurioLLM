// ToolCallRepository (doc 03 §4.3, doc 04 §5 ToolCallRecord) — packages/runtime/src/persistence/repositories/toolCall.ts.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { ToolCallRepository } from '../types.js';
import type { ToolCallRecord } from '@saurio/shared';

interface ToolCallRow extends SqliteRow {
  id: string; run_id: string; message_id: string | null; iteration: number | null; tool_name: string;
  args_json: string; args_hash: string; category: string; risk: string; transport: string; status: string;
  permission_decision_id: string | null; checkpoint_id: string | null; started_at: number | null;
  finished_at: number | null; result_preview: string | null; result_path: string | null;
  result_is_error: number | null; error_json: string | null; match_level: string | null;
  expected_pre_hash: string | null;
}

function rowToToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    runId: row.run_id,
    messageId: row.message_id ?? undefined,
    iteration: row.iteration ?? 0,
    toolName: row.tool_name,
    args: JSON.parse(row.args_json),
    argsHash: row.args_hash,
    category: row.category as ToolCallRecord['category'],
    risk: row.risk as ToolCallRecord['risk'],
    transport: row.transport as ToolCallRecord['transport'],
    status: row.status as ToolCallRecord['status'],
    permissionDecisionId: row.permission_decision_id ?? undefined,
    checkpointId: row.checkpoint_id ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    resultPreview: row.result_preview ?? undefined,
    resultPath: row.result_path ?? undefined,
    resultIsError: row.result_is_error === null ? undefined : row.result_is_error === 1,
    error: row.error_json ? JSON.parse(row.error_json) : undefined,
    matchLevel: (row.match_level as ToolCallRecord['matchLevel']) ?? undefined,
    expectedPreHash: row.expected_pre_hash ?? undefined,
  };
}

const OPEN_STATUSES = ['pending', 'awaiting_permission', 'approved', 'running', 'awaiting_input'];

export function createToolCallRepository(driver: SqliteDriver): ToolCallRepository {
  return {
    async upsert(record: ToolCallRecord): Promise<ToolCallRecord> {
      // `expected_pre_hash` (doc 10 §3/§5.2, doc 16 §4 ítem 16): antes se insertaba siempre en NULL
      // acá y nunca se volvía a tocar. Ahora viaja como cualquier otro campo del `record` — quien
      // llama (`RunController.executeOneToolCall`) lo completa una sola vez al registrar la tool call
      // y lo sigue portando en los `{...record, status: ...}` de los upserts posteriores, así que
      // incluirlo en el UPDATE SET no lo pisa con NULL en las llamadas de seguimiento (status, etc.).
      driver.prepare(
        `INSERT INTO tool_calls (id, run_id, message_id, iteration, tool_name, args_json, args_hash, category, risk, transport, status, permission_decision_id, checkpoint_id, started_at, finished_at, result_preview, result_path, result_is_error, error_json, match_level, expected_pre_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, permission_decision_id = excluded.permission_decision_id,
           checkpoint_id = excluded.checkpoint_id, started_at = excluded.started_at,
           finished_at = excluded.finished_at, result_preview = excluded.result_preview,
           result_path = excluded.result_path, result_is_error = excluded.result_is_error,
           error_json = excluded.error_json, match_level = excluded.match_level,
           expected_pre_hash = excluded.expected_pre_hash`,
      ).run(
        record.id, record.runId, record.messageId ?? null, record.iteration, record.toolName,
        JSON.stringify(record.args), record.argsHash, record.category, record.risk, record.transport,
        record.status, record.permissionDecisionId ?? null, record.checkpointId ?? null,
        record.startedAt ?? null, record.finishedAt ?? null, record.resultPreview ?? null,
        record.resultPath ?? null, record.resultIsError === undefined ? null : (record.resultIsError ? 1 : 0),
        record.error ? JSON.stringify(record.error) : null, record.matchLevel ?? null,
        record.expectedPreHash ?? null,
      );
      return record;
    },
    async get(id: string): Promise<ToolCallRecord | undefined> {
      const row = driver.prepare<ToolCallRow>('SELECT * FROM tool_calls WHERE id = ?').get(id);
      return row ? rowToToolCall(row) : undefined;
    },
    async listByRun(runId: string): Promise<ToolCallRecord[]> {
      return driver.prepare<ToolCallRow>('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY iteration ASC')
        .all(runId).map(rowToToolCall);
    },
    async listOpenAtStartup(): Promise<ToolCallRecord[]> {
      const placeholders = OPEN_STATUSES.map(() => '?').join(', ');
      return driver.prepare<ToolCallRow>(`SELECT * FROM tool_calls WHERE status IN (${placeholders})`)
        .all(...OPEN_STATUSES).map(rowToToolCall);
    },
  };
}
