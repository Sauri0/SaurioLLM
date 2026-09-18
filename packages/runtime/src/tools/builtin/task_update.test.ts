// Test de task_update(steps[]) — doc 04 §10, doc 05 §2.9 punto 35.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskUpdateTool } from './task_update.js';
import { defaultBuiltinToolsDeps } from './deps.js';
import { makeToolContext } from '../testUtils.js';

describe('tools/builtin/task_update', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'saurio-task-update-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('devuelve el checklist en structured para que el runtime proyecte tasks', async () => {
    const tool = createTaskUpdateTool(defaultBuiltinToolsDeps());
    const ctx = makeToolContext(root);
    const res = await tool.handler({
      steps: [
        { title: 'leer el repo', status: 'done' },
        { title: 'proponer cambio', status: 'in_progress' },
      ],
    }, ctx);
    expect(res.isError).toBe(false);
    expect((res.structured as { steps: unknown[] }).steps).toHaveLength(2);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('[done] leer el repo');
  });
});
