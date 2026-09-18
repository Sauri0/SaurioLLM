// RunRepository sobre SQLite (tabla `runs`, doc 03 §4.2) — packages/runtime/src/persistence/repositories/run.ts.
// Satisface el puerto `RunRepository` de packages/runtime/src/agent/ports.ts (que el módulo agent
// definió local porque persistence/types.ts no lo declara: ver deviations del módulo persistence y
// del módulo agent-runtime). La fase de integración lo implementa acá, junto al resto de los
// repositorios, para que RunController y recover() trabajen contra saurio.db real.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { RunRecord, RunRepository } from '../../agent/ports.js';
import type { EffectiveConfig, RunError } from '../../agent/types.js';
import type { Mode, ModelRef, RunState } from '@saurio/shared';

/** Estados no terminales (doc 05 §1 / doc 10 §2); coincide con el índice parcial `runs_active`. */
const ACTIVE_STATES = [
  'created', 'preparing', 'queued', 'generating', 'parsing',
  'awaiting_permission', 'executing_tool', 'compacting', 'cancelling',
] as const;

const PLACEHOLDER_MODEL_REF: ModelRef = { providerId: 'ollama', name: 'unknown', locality: 'local' };

interface RunRow extends SqliteRow {
  id: string;
  chat_id: string;
  parent_run_id: string | null;
  agent_id: string;
  mode: string;
  model_ref_json: string;
  effective_config_json: string;
  state: string;
  state_reason: string | null;
  iteration: number;
  started_at: number | null;
  finished_at: number | null;
  error_json: string | null;
  last_event_seq: number | null;
  owner_session_id: string | null;
  heartbeat_at: number | null;
}

function rowToRecord(row: RunRow): RunRecord {
  const effectiveConfig = row.effective_config_json
    ? (JSON.parse(row.effective_config_json) as EffectiveConfig | null)
    : null;
  return {
    id: row.id,
    chatId: row.chat_id,
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    agentId: row.agent_id,
    mode: row.mode as Mode,
    state: row.state as RunState,
    ...(row.state_reason ? { stateReason: row.state_reason } : {}),
    iteration: row.iteration,
    lastEventSeq: row.last_event_seq ?? 0,
    ...(effectiveConfig ? { effectiveConfig } : {}),
    ...(row.error_json ? { error: JSON.parse(row.error_json) as RunError } : {}),
    ...(row.owner_session_id ? { ownerSessionId: row.owner_session_id } : {}),
    ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
    createdAt: row.started_at ?? 0,
  };
}

/** Superset del puerto `RunRepository`: agrega `listByChat`, que la app de escritorio necesita para
 *  `chat:history` (un chat tiene varios runs en el tiempo y `ToolCallRepository` solo expone
 *  `listByRun`). No se modificó `agent/ports.ts` ni `persistence/types.ts`. */
export interface SqliteRunRepository extends RunRepository {
  listByChat(chatId: string): Promise<RunRecord[]>;
}

export function createRunRepository(driver: SqliteDriver): SqliteRunRepository {
  const getRow = (id: string): RunRow | undefined =>
    driver.prepare<RunRow>('SELECT * FROM runs WHERE id = ?').get(id);

  return {
    async create(run: RunRecord): Promise<RunRecord> {
      driver.prepare(
        `INSERT INTO runs (id, chat_id, parent_run_id, agent_id, mode, model_ref_json, effective_config_json,
                           state, state_reason, iteration, started_at, finished_at, error_json, metrics_json,
                           last_event_seq, owner_session_id, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
      ).run(
        run.id, run.chatId, run.parentRunId ?? null, run.agentId, run.mode,
        JSON.stringify(run.effectiveConfig?.model ?? PLACEHOLDER_MODEL_REF),
        JSON.stringify(run.effectiveConfig ?? null),
        run.state, run.stateReason ?? null, run.iteration, run.createdAt,
        run.error ? JSON.stringify(run.error) : null,
        run.lastEventSeq, run.ownerSessionId ?? null, run.heartbeatAt ?? null,
      );
      return run;
    },

    async get(id: string): Promise<RunRecord | undefined> {
      const row = getRow(id);
      return row ? rowToRecord(row) : undefined;
    },

    async update(id: string, patch: Partial<Omit<RunRecord, 'id'>>): Promise<RunRecord> {
      const current = getRow(id);
      if (!current) throw new Error(`saurio: no existe el run "${id}" que se intenta actualizar`);

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown): void => { sets.push(`${column} = ?`); params.push(value); };

      if (patch.chatId !== undefined) set('chat_id', patch.chatId);
      if (patch.parentRunId !== undefined) set('parent_run_id', patch.parentRunId ?? null);
      if (patch.agentId !== undefined) set('agent_id', patch.agentId);
      if (patch.mode !== undefined) set('mode', patch.mode);
      if (patch.state !== undefined) {
        set('state', patch.state);
        if (patch.state === 'completed' || patch.state === 'cancelled' || patch.state === 'failed' || patch.state === 'interrupted') {
          set('finished_at', Date.now());
        }
      }
      if (patch.stateReason !== undefined) set('state_reason', patch.stateReason ?? null);
      if (patch.iteration !== undefined) set('iteration', patch.iteration);
      if (patch.lastEventSeq !== undefined) set('last_event_seq', patch.lastEventSeq);
      if (patch.effectiveConfig !== undefined) {
        set('effective_config_json', JSON.stringify(patch.effectiveConfig ?? null));
        set('model_ref_json', JSON.stringify(patch.effectiveConfig?.model ?? PLACEHOLDER_MODEL_REF));
      }
      if (patch.error !== undefined) set('error_json', patch.error ? JSON.stringify(patch.error) : null);
      if (patch.ownerSessionId !== undefined) set('owner_session_id', patch.ownerSessionId ?? null);
      if (patch.heartbeatAt !== undefined) set('heartbeat_at', patch.heartbeatAt ?? null);
      if (patch.createdAt !== undefined) set('started_at', patch.createdAt);

      if (sets.length > 0) {
        params.push(id);
        driver.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      }
      const updated = getRow(id);
      if (!updated) throw new Error(`saurio: el run "${id}" desapareció durante la actualización`);
      return rowToRecord(updated);
    },

    async listActive(): Promise<RunRecord[]> {
      const placeholders = ACTIVE_STATES.map(() => '?').join(', ');
      return driver.prepare<RunRow>(
        `SELECT * FROM runs WHERE state IN (${placeholders}) ORDER BY started_at ASC`,
      ).all(...ACTIVE_STATES).map(rowToRecord);
    },

    async listByChat(chatId: string): Promise<RunRecord[]> {
      return driver.prepare<RunRow>(
        'SELECT * FROM runs WHERE chat_id = ? ORDER BY started_at ASC',
      ).all(chatId).map(rowToRecord);
    },
  };
}
