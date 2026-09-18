// Test de read_file(path, start_line?, end_line?) — doc 07 §3, doc 09 §3.2.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadFileTool } from './read_file.js';
import { defaultBuiltinToolsDeps, type BuiltinToolsDeps } from './deps.js';
import { makeToolContext } from '../testUtils.js';

describe('tools/builtin/read_file', () => {
  let root: string;
  let deps: BuiltinToolsDeps;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'saurio-read-file-'));
    deps = defaultBuiltinToolsDeps({ maxReadLines: 5 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lee el archivo completo si entra en maxReadLines y registra el hash leído', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'l1\nl2\nl3\n');
    const tool = createReadFileTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ path: 'a.ts' }, ctx);
    expect(res.isError).toBe(false);
    expect(res.content[0]?.type === 'text' ? res.content[0].text : '').toBe('l1\nl2\nl3\n');
    expect(deps.readTracker.lastHash('run-test', 'a.ts')).toBeDefined();
  });

  it('devuelve el tramo inicial + aviso cuando el archivo excede maxReadLines sin rango', async () => {
    writeFileSync(path.join(root, 'big.ts'), Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n'));
    const tool = createReadFileTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ path: 'big.ts' }, ctx);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('[archivo de 20 líneas; usá start_line/end_line');
    expect(res.truncated).toBe(true);
  });

  it('respeta start_line/end_line explícitos', async () => {
    writeFileSync(path.join(root, 'r.ts'), ['a', 'b', 'c', 'd', 'e'].join('\n'));
    const tool = createReadFileTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ path: 'r.ts', start_line: 2, end_line: 3 }, ctx);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toBe('b\nc');
  });

  it('falla con isError si el archivo no existe', async () => {
    const tool = createReadFileTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ path: 'nope.ts' }, ctx);
    expect(res.isError).toBe(true);
  });

  it('rehúsa leer una ruta protegida', async () => {
    writeFileSync(path.join(root, '.env'), 'SECRET=1');
    const tool = createReadFileTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ path: '.env' }, ctx);
    expect(res.isError).toBe(true);
  });

  it('exige start_line/end_line cuando el archivo excede el límite de WorkspaceFs.readFile', async () => {
    writeFileSync(path.join(root, 'huge.ts'), Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n'));
    const smallLimit = defaultBuiltinToolsDeps({ maxReadLines: 100 });
    const tool = createReadFileTool(smallLimit);
    const ctx = makeToolContext(root, {}, { maxReadBytes: 5 });
    const withoutRange = await tool.handler({ path: 'huge.ts' }, ctx);
    expect(withoutRange.isError).toBe(true);

    const withRange = await tool.handler({ path: 'huge.ts', start_line: 1, end_line: 3 }, ctx);
    expect(withRange.isError).toBe(false);
    const text = withRange.content[0]?.type === 'text' ? withRange.content[0].text : '';
    expect(text).toBe('line0\nline1\nline2');
  });
});
