// CheckpointRepository (doc 03 §4.5, doc 04 §9 Checkpoint) — packages/runtime/src/persistence/repositories/checkpoint.ts.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { CheckpointRepository } from '../types.js';
import type { Checkpoint } from '@saurio/shared';

interface CheckpointRow extends SqliteRow {
  id: string; run_id: string; chat_id: string; tool_call_id: string | null; kind: string;
  stats_json: string | null; status: string;
}
interface CheckpointFileRow extends SqliteRow {
  rel_path: string; change: string; pre_hash: string | null; post_hash: string | null; blob_missing: number;
}

function loadCheckpoint(driver: SqliteDriver, row: CheckpointRow): Checkpoint {
  const files = driver.prepare<CheckpointFileRow>(
    'SELECT rel_path, change, pre_hash, post_hash, blob_missing FROM checkpoint_files WHERE checkpoint_id = ?',
  ).all(row.id);
  return {
    id: row.id,
    runId: row.run_id,
    chatId: row.chat_id,
    toolCallId: row.tool_call_id ?? undefined,
    kind: row.kind as Checkpoint['kind'],
    files: files.map((f) => ({
      relPath: f.rel_path,
      change: f.change as 'created' | 'modified' | 'deleted',
      preHash: f.pre_hash ?? undefined,
      postHash: f.post_hash ?? undefined,
      blobMissing: f.blob_missing === 1 ? true : undefined,
    })),
    stats: row.stats_json ? JSON.parse(row.stats_json) : { files: 0, added: 0, removed: 0 },
    status: row.status as Checkpoint['status'],
  };
}

export function createCheckpointRepository(driver: SqliteDriver): CheckpointRepository {
  return {
    async create(checkpoint: Checkpoint): Promise<Checkpoint> {
      const now = Date.now();
      driver.prepare(
        `INSERT INTO checkpoints (id, run_id, chat_id, tool_call_id, iteration, label, kind, created_at, stats_json, status, reverted_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL)`,
      ).run(checkpoint.id, checkpoint.runId, checkpoint.chatId, checkpoint.toolCallId ?? null, checkpoint.kind, now, JSON.stringify(checkpoint.stats), checkpoint.status);
      for (const file of checkpoint.files) {
        driver.prepare(
          `INSERT INTO checkpoint_files (checkpoint_id, rel_path, change, pre_hash, post_hash, pre_eol, pre_bom, pre_mode, blob_missing)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        ).run(checkpoint.id, file.relPath, file.change, file.preHash ?? null, file.postHash ?? null, file.blobMissing ? 1 : 0);
      }
      return checkpoint;
    },
    async get(id: string): Promise<Checkpoint | undefined> {
      const row = driver.prepare<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?').get(id);
      return row ? loadCheckpoint(driver, row) : undefined;
    },
    async listByChat(chatId: string): Promise<Checkpoint[]> {
      const rows = driver.prepare<CheckpointRow>('SELECT * FROM checkpoints WHERE chat_id = ? ORDER BY created_at DESC').all(chatId);
      return rows.map((row) => loadCheckpoint(driver, row));
    },
    async updateStatus(id: string, status: Checkpoint['status']): Promise<void> {
      driver.prepare('UPDATE checkpoints SET status = ? WHERE id = ?').run(status, id);
    },
  };
}
