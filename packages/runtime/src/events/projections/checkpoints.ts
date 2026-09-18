// Proyección de `checkpoints`/`checkpoint_files` desde run_events (`checkpoint.created`,
// `checkpoint.reverted`) — doc 03 §4.5/§6, doc 04 §6, doc 09 (revert a tres vías).
// packages/runtime/src/events/projections/checkpoints.ts.
// Las pre-imágenes en appData/blobs (fuera de SQLite) y la tabla `blobs` (refcount) las escribe
// CheckpointService antes de emitir el evento (doc 03 §6, "Antes de ejecutar (si mutating)"); esta
// proyección solo refleja el estado ya decidido en el Checkpoint completo que viaja en el evento.
import type { SqliteDriver } from '../../persistence/driver.js';
import type { RunEvent } from '@saurio/shared';

function onCreated(driver: SqliteDriver, event: Extract<RunEvent, { type: 'checkpoint.created' }>): void {
  const ck = event.checkpoint;
  driver.prepare(
    `INSERT INTO checkpoints (id, run_id, chat_id, tool_call_id, iteration, label, kind, created_at, stats_json, status, reverted_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET stats_json = excluded.stats_json, status = excluded.status`,
  ).run(ck.id, ck.runId, ck.chatId, ck.toolCallId ?? null, ck.kind, event.ts, JSON.stringify(ck.stats), ck.status);

  for (const file of ck.files) {
    driver.prepare(
      `INSERT INTO checkpoint_files (checkpoint_id, rel_path, change, pre_hash, post_hash, pre_eol, pre_bom, pre_mode, blob_missing)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
       ON CONFLICT(checkpoint_id, rel_path) DO UPDATE SET
         change = excluded.change, pre_hash = excluded.pre_hash, post_hash = excluded.post_hash,
         blob_missing = excluded.blob_missing`,
    ).run(ck.id, file.relPath, file.change, file.preHash ?? null, file.postHash ?? null, file.blobMissing ? 1 : 0);
  }

  if (ck.toolCallId) {
    driver.prepare('UPDATE tool_calls SET checkpoint_id = ? WHERE id = ?').run(ck.id, ck.toolCallId);
  }
}

function onReverted(driver: SqliteDriver, event: Extract<RunEvent, { type: 'checkpoint.reverted' }>): void {
  const status = event.conflicts.length > 0 ? 'partial' : 'reverted';
  driver.prepare('UPDATE checkpoints SET status = ?, reverted_at = ? WHERE id = ?')
    .run(status, event.ts, event.checkpointId);
}

export function applyToCheckpoints(driver: SqliteDriver, event: RunEvent): void {
  switch (event.type) {
    case 'checkpoint.created': onCreated(driver, event); break;
    case 'checkpoint.reverted': onReverted(driver, event); break;
    default: break;
  }
}
