// `saurio db rebuild` (doc 02 §1 y §4.1 de la columna vertebral; doc 03 §8 "saurio db rebuild no es
// una migración"): borra las proyecciones (messages, tool_calls, tasks) y las reconstruye leyendo
// run_events en orden de seq — packages/runtime/src/persistence/rebuild.ts.
// Sigue el procedimiento literal de doc 03 §8 (7 pasos) para no violar `PRAGMA foreign_keys = ON`
// mientras `checkpoints`/`checkpoint_files` (que NO son proyecciones, doc 03 §1) siguen enteras.
import { openDriver, type SqliteDriver, type SqliteRow } from './driver.js';
import { createProjector } from '../events/projections/index.js';
import { RunEventSchema } from '@saurio/shared';
import type { RunEvent } from './types.js';

interface RunEventRow extends SqliteRow {
  seq: number; run_id: string; chat_id: string; ts: number; type: string; payload_json: string;
}

function rowToEvent(row: RunEventRow): RunEvent {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  return RunEventSchema.parse({
    ...payload, seq: row.seq, runId: row.run_id, chatId: row.chat_id, ts: row.ts, type: row.type,
  });
}

/** Reproyecta `messages`/`tool_calls`/`tasks`/`runs.state` desde `run_events`, en una única
 *  transacción (doc 03 §8, procedimiento de 7 pasos). No toca `checkpoints`/`checkpoint_files`
 *  (no son proyecciones del log) ni `run_events` (la fuente de verdad). */
export function rebuild(driver: SqliteDriver): void {
  const projector = createProjector(driver);

  driver.exec('BEGIN IMMEDIATE');
  try {
    driver.exec('PRAGMA defer_foreign_keys = ON');

    // 2. Captura + desvincula tool_calls.checkpoint_id (checkpoints no se borran, doc 03 §1).
    const savedCheckpointLinks = driver.prepare<{ id: string; checkpoint_id: string }>(
      'SELECT id, checkpoint_id FROM tool_calls WHERE checkpoint_id IS NOT NULL',
    ).all();
    driver.exec('UPDATE tool_calls SET checkpoint_id = NULL');

    // 3. Rompe la auto-referencia de messages antes de borrar.
    driver.exec('UPDATE messages SET compacted_by = NULL');

    // 4. Borra las proyecciones, en el orden que exige el doc (tool_calls -> tasks -> messages).
    driver.exec('DELETE FROM tool_calls');
    driver.exec('DELETE FROM tasks');
    driver.exec('DELETE FROM messages');

    // 5. Reproyecta desde run_events, en orden de seq, con los mismos ids (van en payload_json).
    const events = driver.prepare<RunEventRow>('SELECT * FROM run_events ORDER BY seq ASC').all().map(rowToEvent);
    for (const event of events) {
      projector.apply(event);
    }

    // 6. Revincula cada checkpoint existente con la fila de tool_calls reproyectada del mismo id.
    for (const link of savedCheckpointLinks) {
      driver.prepare('UPDATE tool_calls SET checkpoint_id = ? WHERE id = ?').run(link.checkpoint_id, link.id);
    }

    // 7. COMMIT dispara la verificación diferida de FKs de una sola vez.
    driver.exec('COMMIT');
  } catch (error) {
    driver.exec('ROLLBACK');
    throw error;
  }
}

function main(): void {
  const dbPath = process.env.SAURIO_DB_PATH ?? ':memory:';
  if (dbPath === ':memory:') {
    console.log('[db:rebuild] SAURIO_DB_PATH no definido: nada que reconstruir contra :memory:.');
    return;
  }
  const driver = openDriver(dbPath);
  try {
    rebuild(driver);
    console.log(`[db:rebuild] proyecciones reconstruidas desde run_events contra ${dbPath}.`);
  } finally {
    driver.close();
  }
}

// Solo ejecuta al invocarse directamente (`pnpm db:rebuild`), no al importarse desde tests.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  main();
}
