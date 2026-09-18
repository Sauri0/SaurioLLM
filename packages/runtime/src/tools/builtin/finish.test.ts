// Test de finish(summary, tasks?) — doc 05 §2.4/§2.14, columna vertebral §5 (Plan).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFinishTool } from './finish.js';
import { defaultBuiltinToolsDeps } from './deps.js';
import { makeToolContext } from '../testUtils.js';

describe('tools/builtin/finish', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'saurio-finish-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('devuelve summary y tasks en structured', async () => {
    const tool = createFinishTool(defaultBuiltinToolsDeps());
    const ctx = makeToolContext(root);
    const res = await tool.handler({ summary: 'listo', tasks: [{ title: 'x', status: 'done' }] }, ctx);
    expect(res.isError).toBe(false);
    expect(res.structured).toEqual({ summary: 'listo', tasks: [{ title: 'x', status: 'done' }] });
  });

  it('tasks es opcional', async () => {
    const tool = createFinishTool(defaultBuiltinToolsDeps());
    const ctx = makeToolContext(root);
    const res = await tool.handler({ summary: 'listo' }, ctx);
    expect(res.structured).toEqual({ summary: 'listo', tasks: [] });
  });
});
