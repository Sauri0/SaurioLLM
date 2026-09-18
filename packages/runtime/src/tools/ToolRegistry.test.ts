// Test de ToolRegistry: register/unregister/list/get/onChanged, match tolerante de nombre.
// Define: doc 04 §4 (interfaz ToolRegistry) y doc 05 §2.5 paso 22 (match tolerante).
import { describe, expect, it, vi } from 'vitest';
import { createToolRegistry } from './ToolRegistry.js';
import type { ToolDefinition } from './types.js';

function stubTool(name: string, modes: ToolDefinition['allowedInModes'] = ['agent']): ToolDefinition {
  return {
    name,
    description: 'stub',
    inputSchema: {},
    category: 'read',
    mutating: false,
    idempotent: true,
    allowedInModes: modes,
    source: { kind: 'builtin' },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  };
}

describe('tools/ToolRegistry', () => {
  it('registra, lista y obtiene por nombre', () => {
    const reg = createToolRegistry();
    reg.register(stubTool('read_file'));
    expect(reg.get('read_file')?.name).toBe('read_file');
    expect(reg.list()).toHaveLength(1);
  });

  it('rechaza nombres inválidos', () => {
    const reg = createToolRegistry();
    expect(() => reg.register(stubTool('con espacio'))).toThrow();
  });

  it('unregister quita la tool', () => {
    const reg = createToolRegistry();
    reg.register(stubTool('finish'));
    reg.unregister('finish');
    expect(reg.get('finish')).toBeUndefined();
  });

  it('list filtra por mode y por names', () => {
    const reg = createToolRegistry();
    reg.register(stubTool('list_files', ['plan', 'agent']));
    reg.register(stubTool('edit_file', ['edit', 'agent']));
    expect(reg.list({ mode: 'plan' }).map((t) => t.name)).toEqual(['list_files']);
    expect(reg.list({ names: ['edit_file'] }).map((t) => t.name)).toEqual(['edit_file']);
  });

  it('onChanged notifica en register y unregister', () => {
    const reg = createToolRegistry();
    const cb = vi.fn();
    const off = reg.onChanged(cb);
    reg.register(stubTool('finish'));
    reg.unregister('finish');
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    reg.register(stubTool('finish'));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('resolveTolerant matchea case-insensitive, snake/camel y Levenshtein <= 2', () => {
    const reg = createToolRegistry();
    reg.register(stubTool('read_file'));
    expect(reg.resolveTolerant('READ_FILE')?.name).toBe('read_file');
    expect(reg.resolveTolerant('readFile')?.name).toBe('read_file');
    expect(reg.resolveTolerant('read_fyle')?.name).toBe('read_file');
    expect(reg.resolveTolerant('totalmente_otra_cosa')).toBeUndefined();
  });
});
