// Helpers de test compartidos (no es *.test.ts a propósito: vitest no lo corre como suite).
// Construye un ToolContext mínimo sobre un WorkspaceFs real en una carpeta temporal, con un
// CheckpointHandle stub (CheckpointService es otro módulo, fuera de mi alcance — doc 09).
import { randomUUID } from 'node:crypto';
import { createWorkspaceFs, type WorkspaceFsOptions } from './WorkspaceFs.js';
import type { ToolContext } from './types.js';

export function makeToolContext(root: string, overrides: Partial<ToolContext> = {}, fsOpts?: WorkspaceFsOptions): ToolContext {
  const fs = overrides.fs ?? createWorkspaceFs(root, fsOpts);
  return {
    projectRoot: root,
    cwd: root,
    runId: 'run-test',
    toolCallId: randomUUID(),
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    fs,
    checkpoint: {
      checkpointId: 'ckpt-test',
      before: async () => undefined,
      after: async () => undefined,
    },
    emit: () => undefined,
    log: () => undefined,
    ...overrides,
  };
}
