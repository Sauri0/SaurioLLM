// Test de make_dir(paths) — punto 4 del encargo (feedback real v0.2.1: crear varias carpetas sin
// pasar por run_command/mkdir -p).
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMakeDirTool } from './make_dir.js';
import { defaultBuiltinToolsDeps, type BuiltinToolsDeps } from './deps.js';
import { makeToolContext } from '../testUtils.js';

describe('tools/builtin/make_dir', () => {
  let root: string;
  let deps: BuiltinToolsDeps;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'saurio-make-dir-'));
    deps = defaultBuiltinToolsDeps();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('crea una sola carpeta', async () => {
    const tool = createMakeDirTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ paths: ['Carpeta1'] }, ctx);
    expect(res.isError).toBe(false);
    expect(existsSync(path.join(root, 'Carpeta1'))).toBe(true);
    expect(statSync(path.join(root, 'Carpeta1')).isDirectory()).toBe(true);
  });

  it('crea varias carpetas de una sola llamada, incluidas intermedias', async () => {
    const tool = createMakeDirTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ paths: ['Ana', 'Beto', 'sub/Carla'] }, ctx);
    expect(res.isError).toBe(false);
    expect(existsSync(path.join(root, 'Ana'))).toBe(true);
    expect(existsSync(path.join(root, 'Beto'))).toBe(true);
    expect(existsSync(path.join(root, 'sub', 'Carla'))).toBe(true);
  });

  it('es idempotente: no falla si la carpeta ya existe', async () => {
    const tool = createMakeDirTool(deps);
    const ctx = makeToolContext(root);
    await tool.handler({ paths: ['Ya'] }, ctx);
    const res = await tool.handler({ paths: ['Ya'] }, ctx);
    expect(res.isError).toBe(false);
  });

  it('falla accionablemente si el path ya existe como archivo', async () => {
    writeFileSync(path.join(root, 'archivo.txt'), 'x');
    const tool = createMakeDirTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ paths: ['archivo.txt'] }, ctx);
    expect(res.isError).toBe(true);
    expect(res.structured).toMatchObject({ created: [], failed: [{ path: 'archivo.txt' }] });
  });

  it('rechaza rutas protegidas (.git)', async () => {
    const tool = createMakeDirTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ paths: ['.git/hooks'] }, ctx);
    expect(res.isError).toBe(true);
    expect(existsSync(path.join(root, '.git'))).toBe(false);
  });

  it('classify() declara category write y los paths pedidos', () => {
    const tool = createMakeDirTool(deps);
    expect(tool.classify?.({ paths: ['A', 'B'] })).toMatchObject({ category: 'write', paths: ['A', 'B'] });
  });
});
