// Test de la tool `delegate` (doc 19 §2.5) — packages/runtime/src/tools/builtin/delegate.test.ts.
import { describe, expect, it } from 'vitest';
import { createDelegateTool } from './delegate.js';
import { defaultBuiltinToolsDeps } from './deps.js';
import type { ToolContext } from '../types.js';

function fakeCtx(): ToolContext {
  return {
    projectRoot: '/proj', cwd: '/proj', runId: 'run-1', toolCallId: 'call-1',
    signal: new AbortController().signal, timeoutMs: 1000,
    fs: {
      readFile: async () => { throw new Error('no fs'); },
      writeFileAtomic: async () => { throw new Error('no fs'); },
      deleteFile: async () => { throw new Error('no fs'); },
      listDir: async () => [],
      isProtected: () => false,
      isIgnored: () => false,
      resolve: (p: string) => p,
    },
    checkpoint: { checkpointId: '', before: async () => {}, after: async () => {} },
    emit: () => {},
    log: () => {},
  };
}

describe('createDelegateTool', () => {
  const tool = createDelegateTool(defaultBuiltinToolsDeps());

  it('declara category delegate, source delegate, y no es mutating', () => {
    expect(tool.category).toBe('delegate');
    expect(tool.source).toEqual({ kind: 'delegate' });
    expect(tool.mutating).toBe(false);
    expect(tool.idempotent).toBe(false);
  });

  it('el argsSchema valida el esquema chico de DelegationRequest (doc 19 §2.2)', () => {
    const parsed = tool.argsSchema!.safeParse({ task: 'revisar el módulo X', expectedDeliverable: 'resumen de hallazgos' });
    expect(parsed.success).toBe(true);
  });

  it('el argsSchema rechaza un input sin task/expectedDeliverable', () => {
    const parsed = tool.argsSchema!.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('el handler genérico nunca debe ejecutarse en un run real (RunController la intercepta)', async () => {
    await expect(tool.handler(
      { task: 'x', expectedDeliverable: 'y' }, fakeCtx(),
    )).rejects.toThrow(/RunController/);
  });
});
