// Checkpoints: begin/commit/diff/revert — packages/runtime/src/checkpoint/types.ts.
// Define: doc 04 §9. Solo interfaces/tipos (sin implementación). MVP completo salvo el shadow-repo
// detector (v0.3). RevertPlan/RevertResult tienen su schema zod en @saurio/shared (domain.ts)
// porque cruzan IPC ('checkpoint:planRevert' / 'checkpoint:revert') — doc 02 §3.
import type { Checkpoint, RevertPlan, RevertResult, DiffResult } from '@saurio/shared';
import type { CheckpointHandle } from '../tools/types.js';

export type { RevertPlan, RevertResult };

export interface CheckpointService {
  begin(runId: string, toolCallId: string, paths: string[]): Promise<CheckpointHandle>;
  commit(handle: CheckpointHandle): Promise<Checkpoint>;
  diff(checkpointId: string, relPath: string): Promise<DiffResult>;
  planRevert(checkpointIds: string[]): Promise<RevertPlan>;
  revert(checkpointIds: string[], resolution: Record<string, RevertResolution>): Promise<RevertResult>;
}

export type RevertResolution = 'restore' | 'keep_mine' | 'skip';

export interface BlobStore {
  put(content: Buffer | string): Promise<{ hash: string; size: number }>;
  get(hash: string): Promise<Buffer | null>;
  addRef(hash: string): void; releaseRef(hash: string): void;   // recuento para GC de blobs
}
