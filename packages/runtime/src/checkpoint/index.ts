// BlobStore, CheckpointService, diff.ts (wrapper de jsdiff) — packages/runtime/src/checkpoint/index.ts.
// Define: doc 02 §1, ADR-007; doc 09 (protección del proyecto, checkpoints, revert).
export type { BlobStore, CheckpointService, RevertResolution } from './types.js';
export type { RevertPlan, RevertResult } from './types.js';

export { FileBlobStore } from './blob-store.js';
export { FsCheckpointService, type CheckpointServiceDeps } from './checkpoint-service.js';
export { computeDiffStats, computeUnifiedDiff, type DiffStats } from './diff.js';
export { detectContentProfile, hashFileStreaming, sha256, type ContentProfile, type Eol } from './hash.js';
export { atomicUnlink, atomicWrite, PathLockedError, readFileRaw, statOrUndefined } from './fs-atomic.js';
export type {
  BlobRecord, BlobRefStore, CheckpointCommitInput, CheckpointStoreRepository, StoredCheckpoint,
} from './repositories.js';
export { InMemoryBlobRefStore, InMemoryCheckpointStore } from './memory-repositories.js';
export { createGitHeadReader, type GitHead, type GitHeadReader } from './git.js';
