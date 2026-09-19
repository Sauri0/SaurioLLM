import { describe, expect, it } from 'vitest';
import type { ToolCallRecord } from '@saurio/shared';
import { toolStepLabel, turnSummaryLabel } from './stepLabel.js';

function call(overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, 'category'>): ToolCallRecord {
  return {
    id: 't1', runId: 'r1', iteration: 0, toolName: 'tool_x', args: {}, argsHash: 'h',
    risk: 'low', transport: 'native', status: 'done',
    ...overrides,
  } as ToolCallRecord;
}

describe('toolStepLabel', () => {
  it('lectura de archivo, terminada', () => {
    expect(toolStepLabel(call({ category: 'read', toolName: 'read_file', args: { path: 'src/a.ts' } })))
      .toBe('Leyó src/a.ts');
  });

  it('lectura en curso (running) usa gerundio', () => {
    expect(toolStepLabel(call({ category: 'read', toolName: 'read_file', args: { path: 'src/a.ts' }, status: 'running' })))
      .toBe('Leyendo src/a.ts');
  });

  it('búsqueda usa el query entre comillas, no el path', () => {
    expect(toolStepLabel(call({ category: 'read', toolName: 'search_files', args: { query: 'listCheckpoints' } })))
      .toBe('Buscó "listCheckpoints"');
  });

  it('comando de terminal', () => {
    expect(toolStepLabel(call({ category: 'terminal', toolName: 'run_command', args: { command: 'npm test' } })))
      .toBe('Ejecutó: npm test');
  });

  it('escritura', () => {
    expect(toolStepLabel(call({ category: 'write', toolName: 'edit_file', args: { path: 'src/b.ts' } })))
      .toBe('Editó src/b.ts');
  });

  it('permiso pendiente tiene prioridad sobre la categoría', () => {
    expect(toolStepLabel(call({ category: 'write', toolName: 'edit_file', status: 'awaiting_permission' })))
      .toBe('Esperando tu permiso: edit_file');
  });

  it('falló', () => {
    expect(toolStepLabel(call({ category: 'terminal', toolName: 'run_command', status: 'failed' })))
      .toBe('Falló: run_command');
  });
});

describe('turnSummaryLabel', () => {
  it('formato "Trabajó Xs · N lecturas · M comando · K archivos editados", sin partes en cero', () => {
    const counts = { reads: 3, commands: 1, edits: 2, other: 0, toolCallCount: 6, usedThinking: false };
    expect(turnSummaryLabel(counts, 14_000)).toBe('Trabajó 14 s · 3 lecturas · 1 comando · 2 archivos editados');
  });

  it('singular cuando el conteo es 1', () => {
    const counts = { reads: 1, commands: 1, edits: 0, other: 0, toolCallCount: 2, usedThinking: false };
    expect(turnSummaryLabel(counts, 2_000)).toBe('Trabajó 2 s · 1 lectura · 1 comando');
  });

  it('solo pensó, sin tool calls', () => {
    const counts = { reads: 0, commands: 0, edits: 0, other: 0, toolCallCount: 0, usedThinking: true };
    expect(turnSummaryLabel(counts, undefined)).toBe('Trabajó · pensó antes de responder');
  });
});
