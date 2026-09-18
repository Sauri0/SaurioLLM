// Tests puros de chatStore (sin renderizar React ni mockear IPC: no hay @testing-library en el
// monorepo — missingDeps) — apps/desktop/src/renderer/src/stores/chatStore.test.ts.
// Cubre `buildToolCallOrderByRun`, extraída de `loadHistory` (hallazgo #3 del corte de
// integración: tras reiniciar, las tarjetas de tool call desaparecían del historial porque
// `loadHistory` volcaba `history.toolCalls` en `runStore.toolCalls` pero nunca reconstruía
// `toolCallOrderByRun`, que es lo que `ChatMessageList` usa para pintar las tarjetas de un run
// que ya no está "activo").
import { describe, expect, it } from 'vitest';
import type { ToolCallRecord } from '@saurio/shared';
import { buildToolCallOrderByRun } from './chatStore.js';

function call(overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, 'id' | 'runId' | 'iteration'>): ToolCallRecord {
  return {
    toolName: 'read_file',
    args: {},
    argsHash: 'hash',
    category: 'read',
    risk: 'low',
    transport: 'native',
    status: 'completed',
    ...overrides,
  } as ToolCallRecord;
}

describe('buildToolCallOrderByRun', () => {
  it('agrupa por runId y ordena por iteration', () => {
    const calls = [
      call({ id: 'c2', runId: 'run-1', iteration: 1 }),
      call({ id: 'c1', runId: 'run-1', iteration: 0 }),
      call({ id: 'd1', runId: 'run-2', iteration: 0 }),
    ];
    expect(buildToolCallOrderByRun(calls)).toEqual({
      'run-1': ['c1', 'c2'],
      'run-2': ['d1'],
    });
  });

  it('usa startedAt como desempate cuando la iteration coincide', () => {
    const calls = [
      call({ id: 'later', runId: 'run-1', iteration: 0, startedAt: 200 }),
      call({ id: 'earlier', runId: 'run-1', iteration: 0, startedAt: 100 }),
    ];
    expect(buildToolCallOrderByRun(calls)).toEqual({ 'run-1': ['earlier', 'later'] });
  });

  it('no duplica ids repetidos y devuelve objeto vacío para lista vacía', () => {
    const calls = [
      call({ id: 'c1', runId: 'run-1', iteration: 0 }),
      call({ id: 'c1', runId: 'run-1', iteration: 0 }),
    ];
    expect(buildToolCallOrderByRun(calls)).toEqual({ 'run-1': ['c1'] });
    expect(buildToolCallOrderByRun([])).toEqual({});
  });
});
