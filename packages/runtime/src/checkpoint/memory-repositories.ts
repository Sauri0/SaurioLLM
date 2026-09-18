// Implementaciones en memoria de los repositorios locales — packages/runtime/src/checkpoint/memory-repositories.ts.
// Uso: tests de este módulo (regla "Persistencia vía interfaces de repositorio inyectadas, no
// acoplarse a drizzle"). Una implementación real sobre better-sqlite3/drizzle se conecta en la fase
// de persistencia, fuera del alcance de esta tarea.
import type { Checkpoint } from '@saurio/shared';
import type {
  BlobRecord, BlobRefStore, CheckpointCommitInput, CheckpointStoreRepository, FileMatchAttribution,
  StoredCheckpoint,
} from './repositories.js';

export class InMemoryBlobRefStore implements BlobRefStore {
  private readonly records = new Map<string, BlobRecord>();

  get(hash: string): BlobRecord | undefined {
    return this.records.get(hash);
  }

  upsertRef(hash: string, size: number, createdAt: number): number {
    const existing = this.records.get(hash);
    if (existing) {
      existing.refcount += 1;
      return existing.refcount;
    }
    this.records.set(hash, { hash, size, createdAt, refcount: 1 });
    return 1;
  }

  releaseRef(hash: string): number {
    const existing = this.records.get(hash);
    if (!existing) return 0;
    existing.refcount = Math.max(0, existing.refcount - 1);
    return existing.refcount;
  }
}

export class InMemoryCheckpointStore implements CheckpointStoreRepository {
  private readonly checkpoints = new Map<string, StoredCheckpoint>();

  async commit(input: CheckpointCommitInput): Promise<StoredCheckpoint> {
    const checkpoint: StoredCheckpoint = {
      id: input.id,
      runId: input.runId,
      chatId: input.chatId,
      toolCallId: input.toolCallId,
      kind: input.kind,
      files: input.files,
      stats: input.stats,
      status: 'active',
      createdAt: input.createdAt,
      gitHead: input.gitHead,
    };
    this.checkpoints.set(checkpoint.id, checkpoint);
    return checkpoint;
  }

  async findLatestFileMatch(relPath: string, postHash: string): Promise<FileMatchAttribution | undefined> {
    let best: (FileMatchAttribution & { createdAt: number }) | undefined;
    for (const checkpoint of this.checkpoints.values()) {
      const file = checkpoint.files.find((f) => f.relPath === relPath && f.postHash === postHash);
      if (!file) continue;
      if (!best || checkpoint.createdAt > best.createdAt) {
        best = { runId: checkpoint.runId, chatId: checkpoint.chatId, createdAt: checkpoint.createdAt };
      }
    }
    return best;
  }

  async get(id: string): Promise<StoredCheckpoint | undefined> {
    return this.checkpoints.get(id);
  }

  async getMany(ids: string[]): Promise<StoredCheckpoint[]> {
    return ids.map((id) => this.checkpoints.get(id)).filter((c): c is StoredCheckpoint => c !== undefined);
  }

  async listByChat(chatId: string): Promise<StoredCheckpoint[]> {
    return [...this.checkpoints.values()].filter((c) => c.chatId === chatId);
  }

  async updateStatus(id: string, status: Checkpoint['status']): Promise<void> {
    const checkpoint = this.checkpoints.get(id);
    if (checkpoint) checkpoint.status = status;
  }
}
