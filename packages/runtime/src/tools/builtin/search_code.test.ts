// Test de search_code(query, glob?, max_results?) — doc 07 §3 (rg --json, .gitignore, max_results<=50).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSearchCodeTool } from './search_code.js';
import { defaultBuiltinToolsDeps } from './deps.js';
import { makeToolContext } from '../testUtils.js';

describe('tools/builtin/search_code', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'saurio-search-'));
    writeFileSync(path.join(root, 'a.ts'), 'export function foo() {\n  return 1;\n}\n');
    writeFileSync(path.join(root, 'b.ts'), 'export function bar() {\n  return foo();\n}\n');
    writeFileSync(path.join(root, '.gitignore'), 'ignored.ts\n');
    writeFileSync(path.join(root, 'ignored.ts'), 'foo foo foo\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('encuentra coincidencias agrupadas por archivo y respeta .gitignore', async () => {
    const tool = createSearchCodeTool(defaultBuiltinToolsDeps());
    const ctx = makeToolContext(root);
    const res = await tool.handler({ query: 'foo' }, ctx);
    expect(res.isError).toBe(false);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).not.toContain('ignored.ts');
  }, 15000);

  it('cap max_results y avisa cuántos resultados quedan afuera', async () => {
    const many = mkdtempSync(path.join(tmpdir(), 'saurio-search-many-'));
    for (let i = 0; i < 10; i++) writeFileSync(path.join(many, `f${i}.ts`), 'needle\nneedle\nneedle\n');
    const tool = createSearchCodeTool(defaultBuiltinToolsDeps());
    const ctx = makeToolContext(many);
    const res = await tool.handler({ query: 'needle', max_results: 5 }, ctx);
    expect(res.truncated).toBe(true);
    rmSync(many, { recursive: true, force: true });
  }, 15000);
});
