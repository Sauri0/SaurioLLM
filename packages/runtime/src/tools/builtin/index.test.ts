// Test de integración: createBuiltinTools() + ToolRegistry — doc 04 §4 (BuiltinToolName, 10 tools) +
// doc 19 §2.5 (E3a: `delegate` se registra siempre, pero no forma parte de `DEFAULT_ALLOWED_TOOLS`).
import { describe, expect, it } from 'vitest';
import { createBuiltinTools } from './index.js';
import { createToolRegistry } from '../ToolRegistry.js';

const EXPECTED_NAMES = [
  'list_files', 'search_code', 'read_file', 'read_output',
  'edit_file', 'write_file', 'delete_file', 'run_command',
  'task_update', 'finish', 'delegate',
];

describe('tools/builtin (integración)', () => {
  it('createBuiltinTools() produce las 10 builtins documentadas + delegate', () => {
    const tools = createBuiltinTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it('todas registran en ToolRegistry sin colisión de nombres', () => {
    const registry = createToolRegistry();
    for (const t of createBuiltinTools()) registry.register(t);
    expect(registry.list()).toHaveLength(11);
  });

  it('el filtro por modo plan expone las 6 tools de solo lectura + finish/task_update/delegate', () => {
    const registry = createToolRegistry();
    for (const t of createBuiltinTools()) registry.register(t);
    const planNames = registry.list({ mode: 'plan' }).map((t) => t.name).sort();
    expect(planNames).toEqual(['delegate', 'finish', 'list_files', 'read_file', 'read_output', 'search_code', 'task_update'].sort());
  });

  it('el filtro por modo agent expone las 10 builtins + delegate', () => {
    const registry = createToolRegistry();
    for (const t of createBuiltinTools()) registry.register(t);
    expect(registry.list({ mode: 'agent' })).toHaveLength(11);
  });

  it('cada tool tiene inputSchema derivado de argsSchema (z.toJSONSchema)', () => {
    for (const t of createBuiltinTools()) {
      expect(t.inputSchema).toBeTruthy();
      expect(t.argsSchema).toBeTruthy();
    }
  });

  it('delegate no forma parte de DEFAULT_ALLOWED_TOOLS (doc 19 §2.5)', async () => {
    const { DEFAULT_ALLOWED_TOOLS } = await import('../../agent/defaults.js');
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('delegate');
  });
});
