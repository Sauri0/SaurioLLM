// CheckpointStoreRepository + BlobRefStore sobre SQLite (doc 03 §4.5: checkpoints, checkpoint_files,
// blobs) — packages/runtime/src/persistence/repositories/checkpointStore.ts.
// El módulo checkpoint definió esas dos interfaces locales a sí mismo (checkpoint/repositories.ts)
// porque persistence/types.ts solo declara `CheckpointRepository` sobre el `Checkpoint` de IPC, sin
// `createdAt` ni `getMany`. La fase de integración las implementa acá para que FsCheckpointService
// trabaje contra saurio.db en vez de las implementaciones en memoria de memory-repositories.ts.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type {
  BlobRecord, BlobRefStore, CheckpointCommitInput, CheckpointStoreRepository, FileMatchAttribution,
  StoredCheckpoint,
} from '../../checkpoint/repositories.js';
import type { Checkpoint, CheckpointFile } from '@saurio/shared';

interface CheckpointRow extends SqliteRow {
  id: string; run_id: string; chat_id: string; tool_call_id: string | null;
  kind: string; created_at: number; stats_json: string | null; status: string;
  git_head: string | null;
}

interface CheckpointFileRow extends SqliteRow {
  rel_path: string; change: string; pre_hash: string | null; post_hash: string | null; blob_missing: number;
}

interface BlobRow extends SqliteRow {
  hash: string; size: number; created_at: number; refcount: number;
}

function toFiles(driver: SqliteDriver, checkpointId: string): CheckpointFile[] {
  return driver.prepare<CheckpointFileRow>(
    'SELECT rel_path, change, pre_hash, post_hash, blob_missing FROM checkpoint_files WHERE checkpoint_id = ? ORDER BY rel_path',
  ).all(checkpointId).map((f) => ({
    relPath: f.rel_path,
    change: f.change as CheckpointFile['change'],
    ...(f.pre_hash ? { preHash: f.pre_hash } : {}),
    ...(f.post_hash ? { postHash: f.post_hash } : {}),
    ...(f.blob_missing === 1 ? { blobMissing: true } : {}),
  }));
}

function toStored(driver: SqliteDriver, row: CheckpointRow): StoredCheckpoint {
  return {
    id: row.id,
    runId: row.run_id,
    chatId: row.chat_id,
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    kind: row.kind as Checkpoint['kind'],
    files: toFiles(driver, row.id),
    stats: row.stats_json
      ? (JSON.parse(row.stats_json) as Checkpoint['stats'])
      : { files: 0, added: 0, removed: 0 },
    status: row.status as Checkpoint['status'],
    createdAt: row.created_at,
    // Doc 09 §2.2: `checkpoints.git_head` (migración 2) guarda un JSON `{sha, branch}` en una sola
    // columna TEXT — no hace falta partirlo en dos columnas para lo que `planRevert` necesita leer.
    ...(row.git_head ? { gitHead: JSON.parse(row.git_head) as StoredCheckpoint['gitHead'] } : {}),
  };
}

export function createCheckpointStoreRepository(driver: SqliteDriver): CheckpointStoreRepository {
  return {
    async commit(input: CheckpointCommitInput): Promise<StoredCheckpoint> {
      driver.exec('BEGIN IMMEDIATE');
      try {
        driver.prepare(
          `INSERT INTO checkpoints (id, run_id, chat_id, tool_call_id, iteration, label, kind, created_at, stats_json, status, reverted_at, git_head)
           VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'active', NULL, ?)`,
        ).run(
          input.id, input.runId, input.chatId, input.toolCallId ?? null, input.kind, input.createdAt,
          JSON.stringify(input.stats), input.gitHead ? JSON.stringify(input.gitHead) : null,
        );
        for (const file of input.files) {
          driver.prepare(
            `INSERT INTO checkpoint_files (checkpoint_id, rel_path, change, pre_hash, post_hash, pre_eol, pre_bom, pre_mode, blob_missing)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
          ).run(input.id, file.relPath, file.change, file.preHash ?? null, file.postHash ?? null, file.blobMissing ? 1 : 0);
        }
        driver.exec('COMMIT');
      } catch (error) {
        driver.exec('ROLLBACK');
        throw error;
      }
      return {
        id: input.id, runId: input.runId, chatId: input.chatId,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        kind: input.kind, files: input.files, stats: input.stats,
        status: 'active', createdAt: input.createdAt,
        ...(input.gitHead ? { gitHead: input.gitHead } : {}),
      };
    },

    async get(id: string): Promise<StoredCheckpoint | undefined> {
      const row = driver.prepare<CheckpointRow>('SELECT * FROM checkpoints WHERE id = ?').get(id);
      return row ? toStored(driver, row) : undefined;
    },

    async getMany(ids: string[]): Promise<StoredCheckpoint[]> {
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(', ');
      return driver.prepare<CheckpointRow>(
        `SELECT * FROM checkpoints WHERE id IN (${placeholders}) ORDER BY created_at DESC`,
      ).all(...ids).map((row) => toStored(driver, row));
    },

    async listByChat(chatId: string): Promise<StoredCheckpoint[]> {
      return driver.prepare<CheckpointRow>(
        'SELECT * FROM checkpoints WHERE chat_id = ? ORDER BY created_at DESC',
      ).all(chatId).map((row) => toStored(driver, row));
    },

    async updateStatus(id: string, status: Checkpoint['status']): Promise<void> {
      driver.prepare('UPDATE checkpoints SET status = ?, reverted_at = ? WHERE id = ?')
        .run(status, status === 'active' ? null : Date.now(), id);
    },

    async findLatestFileMatch(relPath: string, postHash: string): Promise<FileMatchAttribution | undefined> {
      // Doc 09 §5.3 "Atribución del conflicto": la fila `checkpoint_files` más reciente (de
      // CUALQUIER checkpoint) con ese `rel_path`/`post_hash` — el join solo necesita `checkpoints`
      // para `run_id`/`chat_id`/`created_at`, ordenado por lo más nuevo primero.
      const row = driver.prepare<{ run_id: string; chat_id: string; created_at: number }>(
        `SELECT c.run_id, c.chat_id, c.created_at
           FROM checkpoint_files cf JOIN checkpoints c ON c.id = cf.checkpoint_id
          WHERE cf.rel_path = ? AND cf.post_hash = ?
          ORDER BY c.created_at DESC LIMIT 1`,
      ).get(relPath, postHash);
      return row ? { runId: row.run_id, chatId: row.chat_id, createdAt: row.created_at } : undefined;
    },
  };
}

/** `BlobRefStore` es síncrono por contrato (`BlobStore.addRef/releaseRef` devuelven void, doc 04 §9);
 *  better-sqlite3 también lo es, así que el refcount de `blobs` (doc 09 §2.2) se implementa directo. */
export function createBlobRefStore(driver: SqliteDriver): BlobRefStore {
  return {
    get(hash: string): BlobRecord | undefined {
      const row = driver.prepare<BlobRow>('SELECT * FROM blobs WHERE hash = ?').get(hash);
      return row ? { hash: row.hash, size: row.size, createdAt: row.created_at, refcount: row.refcount } : undefined;
    },

    upsertRef(hash: string, size: number, createdAt: number): number {
      driver.prepare(
        `INSERT INTO blobs (hash, size, created_at, refcount) VALUES (?, ?, ?, 1)
         ON CONFLICT(hash) DO UPDATE SET refcount = refcount + 1`,
      ).run(hash, size, createdAt);
      const row = driver.prepare<BlobRow>('SELECT refcount FROM blobs WHERE hash = ?').get(hash);
      return row?.refcount ?? 1;
    },

    releaseRef(hash: string): number {
      // doc 03 §4.5: el CHECK de la tabla impide refcount < 0; en el MVP no hay GC de blobs.
      driver.prepare('UPDATE blobs SET refcount = MAX(refcount - 1, 0) WHERE hash = ?').run(hash);
      const row = driver.prepare<BlobRow>('SELECT refcount FROM blobs WHERE hash = ?').get(hash);
      return row?.refcount ?? 0;
    },
  };
}
