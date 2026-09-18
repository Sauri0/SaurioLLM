// Test de write_file(path, content) — doc 05 §2.8 punto 32.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteFileTool } from './write_file.js';
import { createReadFileTool } from './read_file.js';
import { defaultBuiltinToolsDeps, type BuiltinToolsDeps } from './deps.js';
import { makeToolContext } from '../testUtils.js';
import { createWorkspaceFs } from '../WorkspaceFs.js';

describe('tools/builtin/write_file', () => {
  let root: string;
  let deps: BuiltinToolsDeps;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'saurio-write-file-'));
    deps = defaultBuiltinToolsDeps();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('crea un archivo nuevo sin exigir lectura previa (change: created)', async () => {
    const tool = createWriteFileTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ path: 'nuevo.ts', content: 'hola\n' }, ctx);
    expect(res.isError).toBe(false);
    expect((res.structured as { change: string }).change).toBe('created');
    expect(readFileSync(path.join(root, 'nuevo.ts'), 'utf8')).toBe('hola\n');
  });

  it('exige lectura previa para sobreescribir un archivo existente', async () => {
    writeFileSync(path.join(root, 'existe.ts'), 'viejo\n');
    const tool = createWriteFileTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ path: 'existe.ts', content: 'nuevo\n' }, ctx);
    expect(res.isError).toBe(true);
  });

  it('sobreescribe tras leer, y detecta conflicto si el archivo cambió en el medio', async () => {
    writeFileSync(path.join(root, 'existe.ts'), 'viejo\n');
    const readTool = createReadFileTool(deps);
    const writeTool = createWriteFileTool(deps);
    const ctx = makeToolContext(root);
    await readTool.handler({ path: 'existe.ts' }, ctx);
    const ok = await writeTool.handler({ path: 'existe.ts', content: 'nuevo\n' }, ctx);
    expect(ok.isError).toBe(false);
    expect((ok.structured as { change: string }).change).toBe('modified');
    expect(readFileSync(path.join(root, 'existe.ts'), 'utf8')).toBe('nuevo\n');
  });

  it('usa tool_calls.expected_pre_hash persistido en vez del ReadTracker (doc 16 §4 ítem 16)', async () => {
    writeFileSync(path.join(root, 'existe.ts'), 'viejo\n');
    const { hash: realHash } = await createWorkspaceFs(root).readFile('existe.ts');
    const depsWithStore: BuiltinToolsDeps = {
      ...defaultBuiltinToolsDeps(),
      expectedPreHash: { async get(toolCallId) { return toolCallId === 'tc-persisted' ? realHash : undefined; } },
    };
    const tool = createWriteFileTool(depsWithStore);
    const ctx = makeToolContext(root, { toolCallId: 'tc-persisted' });
    const res = await tool.handler({ path: 'existe.ts', content: 'nuevo\n' }, ctx);
    expect(res.isError).toBe(false);
    expect(readFileSync(path.join(root, 'existe.ts'), 'utf8')).toBe('nuevo\n');
  });

  it('rehúsa escribir una ruta protegida', async () => {
    const tool = createWriteFileTool(deps);
    const ctx = makeToolContext(root);
    const res = await tool.handler({ path: '.env', content: 'X=1' }, ctx);
    expect(res.isError).toBe(true);
  });
});
