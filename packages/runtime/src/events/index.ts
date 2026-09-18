// EventStore: append de run_events + proyecciones en la MISMA transacción (doc 02 §1, ADR-3,
// doc 04 §6) — packages/runtime/src/events/index.ts.
import type { SqliteDriver, SqliteRow } from '../persistence/driver.js';
import type { EventStore, EventProjector, RunEvent, DistributiveOmit } from '../persistence/types.js';
import { RunEventSchema } from '@saurio/shared';
import { createProjector } from './projections/index.js';

interface RunEventRow extends SqliteRow {
  seq: number;
  run_id: string;
  chat_id: string;
  ts: number;
  type: string;
  payload_json: string;
}

function rowToEvent(row: RunEventRow): RunEvent {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  return RunEventSchema.parse({
    ...payload,
    seq: row.seq,
    runId: row.run_id,
    chatId: row.chat_id,
    ts: row.ts,
    type: row.type,
  });
}

/** Implementación SQLite de EventStore (doc 04 §6). `append` es la única operación de escritura:
 *  inserta la fila de `run_events` (seq autoincrement) y aplica el EventProjector compuesto dentro
 *  de una única transacción `BEGIN IMMEDIATE`/`COMMIT` (doc 03 §1 "misma transacción que el evento
 *  que las origina"). Si la proyección lanza, la transacción entera se revierte: nunca queda un
 *  evento persistido sin su proyección ni viceversa. */
export class SqliteEventStore implements EventStore {
  private readonly projector: EventProjector;

  constructor(private readonly driver: SqliteDriver, projector?: EventProjector) {
    this.projector = projector ?? createProjector(driver);
  }

  append(event: DistributiveOmit<RunEvent, 'seq'>): RunEvent {
    const { runId, chatId, ts, type, ...rest } = event;
    const payloadJson = JSON.stringify(rest);

    this.driver.exec('BEGIN IMMEDIATE');
    try {
      const result = this.driver.prepare(
        'INSERT INTO run_events (run_id, chat_id, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)',
      ).run(runId, chatId, ts, type, payloadJson);
      const seq = Number(result.lastInsertRowid);

      const fullEvent = RunEventSchema.parse({ ...rest, seq, runId, chatId, ts, type }) as RunEvent;
      this.projector.apply(fullEvent);

      this.driver.exec('COMMIT');
      return fullEvent;
    } catch (error) {
      this.driver.exec('ROLLBACK');
      throw error;
    }
  }

  since(runId: string, seq: number): RunEvent[] {
    return this.driver.prepare<RunEventRow>(
      'SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC',
    ).all(runId, seq).map(rowToEvent);
  }

  lastSeq(runId: string): number {
    const row = this.driver.prepare<{ max: number | null }>(
      'SELECT MAX(seq) AS max FROM run_events WHERE run_id = ?',
    ).get(runId);
    return row?.max ?? 0;
  }
}

export { createProjector } from './projections/index.js';
