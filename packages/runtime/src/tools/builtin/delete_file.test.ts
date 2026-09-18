// Test de delete_file(path) — doc 09 §3.3 (mismo mecanismo de checkpoint, sin cuarentena en el caso normal).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeleteFileTool } from './delete_file.js';
import { createReadFileTool } from './read_file.js';
import { defaultBuiltinToolsDeps, type BuiltinToolsDeps } from './deps.js';
import { makeToolContext } from '../testUtils.js';
import { createWorkspaceFs } from '../WorkspaceFs.js';

describe('tools/builtin/delete_file', () => {
  let root: string;
  let deps: BuiltinToolsDeps;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'saurio-delete-file-'));
    deps = defaultBuiltinToolsDeps();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('exige lectura previa antes de borrar', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'x');
    const tool = createDeleteFileTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ path: 'a.ts' }, ctx);
    expect(res.isError).toBe(true);
    expect(existsSync(path.join(root, 'a.ts'))).toBe(true);
  });

  it('borra el archivo tras leerlo', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'x');
    const readTool = createReadFileTool(deps);
    const deleteTool = createDeleteFileTool(deps);
    const ctx = makeToolContext(root);
    await readTool.handler({ path: 'a.ts' }, ctx);
    const res = await deleteTool.handler({ path: 'a.ts' }, ctx);
    expect(res.isError).toBe(false);
    expect(existsSync(path.join(root, 'a.ts'))).toBe(false);
  });

  it('usa tool_calls.expected_pre_hash persistido en vez del ReadTracker (doc 16 §4 ítem 16)', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'x');
    const { hash: realHash } = await createWorkspaceFs(root).readFile('a.ts');
    const depsWithStore: BuiltinToolsDeps = {
      ...defaultBuiltinToolsDeps(),
      expectedPreHash: { async get() { return realHash; } },
    };
    const tool = createDeleteFileTool(depsWithStore);
    const ctx = makeToolContext(root, { toolCallId: 'tc-persisted' });
    const res = await tool.handler({ path: 'a.ts' }, ctx);
    expect(res.isError).toBe(false);
    expect(existsSync(path.join(root, 'a.ts'))).toBe(false);
  });

  it('rehúsa borrar una ruta protegida', async () => {
    const tool = createDeleteFileTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ path: '.git/config' }, ctx);
    expect(res.isError).toBe(true);
  });
});
