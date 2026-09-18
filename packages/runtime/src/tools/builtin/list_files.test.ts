// Test de list_files(path, depth?) — doc 07 §3.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createListFilesTool } from './list_files.js';
import { defaultBuiltinToolsDeps } from './deps.js';
import { makeToolContext } from '../testUtils.js';

describe('tools/builtin/list_files', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'saurio-list-files-'));
    mkdirSync(path.join(root, 'src/a/b/c'), { recursive: true });
    writeFileSync(path.join(root, 'src/index.ts'), 'x');
    writeFileSync(path.join(root, 'src/a/b/c/deep.ts'), 'x');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lista archivos y carpetas hasta la profundidad clampeada', async () => {
    const tool = createListFilesTool(defaultBuiltinToolsDeps());
    const ctx = makeToolContext(root);
    const res = await tool.handler({ path: 'src', depth: 10 }, ctx);
    expect(res.isError).toBe(false);
    const structured = res.structured as { path: string; isDir: boolean }[];
    expect(structured.some((e) => e.path === 'src/index.ts')).toBe(true);
    // depth clampeada a 3: no debería llegar a src/a/b/c/deep.ts (4 niveles)
    expect(structured.some((e) => e.path === 'src/a/b/c/deep.ts')).toBe(false);
  });
});
