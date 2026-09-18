// Test de edit_file(path, old_string, new_string, replace_all?) — doc 05 §2.8 punto 32, doc 09 §3.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEditFileTool } from './edit_file.js';
import { createReadFileTool } from './read_file.js';
import { defaultBuiltinToolsDeps, type BuiltinToolsDeps } from './deps.js';
import { makeToolContext } from '../testUtils.js';
import { createWorkspaceFs } from '../WorkspaceFs.js';

describe('tools/builtin/edit_file', () => {
  let root: string;
  let deps: BuiltinToolsDeps;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'saurio-edit-file-'));
    deps = defaultBuiltinToolsDeps();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('falla con edit_conflict si el archivo no fue leído antes en este run', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
    const editTool = createEditFileTool(deps);
    const ctx = makeToolContext(root, {}, undefined);
    const res = await editTool.handler({ path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0]?.type === 'text' ? res.content[0].text : '')).toContain('nunca lo leíste');
  });

  it('aplica un reemplazo exacto tras leer el archivo, y actualiza el disco', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\nconst b = 2;\n');
    const readTool = createReadFileTool(deps);
    const editTool = createEditFileTool(deps);
    const ctx = makeToolContext(root);
    await readTool.handler({ path: 'a.ts' }, ctx);
    const res = await editTool.handler({ path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 42;' }, ctx);
    expect(res.isError).toBe(false);
    const structured = res.structured as { matchLevel: string; count: number };
    expect(structured.matchLevel).toBe('exact');
    const onDisk = readFileSync(path.join(root, 'a.ts'), 'utf8');
    expect(onDisk).toBe('const a = 42;\nconst b = 2;\n');
  });

  it('falla con edit_conflict si el archivo cambió en disco desde la última lectura', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
    const readTool = createReadFileTool(deps);
    const editTool = createEditFileTool(deps);
    const ctx = makeToolContext(root);
    await readTool.handler({ path: 'a.ts' }, ctx);
    writeFileSync(path.join(root, 'a.ts'), 'const a = 999;\n'); // cambio externo
    const res = await editTool.handler({ path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0]?.type === 'text' ? res.content[0].text : '')).toContain('cambió desde que lo leíste');
  });

  it('usa el matching en cascada (indentación distinta) y permite editar de nuevo tras releer', async () => {
    writeFileSync(path.join(root, 'b.ts'), 'function f() {\n    if (x) {\n        return 1;\n    }\n}\n');
    const readTool = createReadFileTool(deps);
    const editTool = createEditFileTool(deps);
    const ctx = makeToolContext(root);
    await readTool.handler({ path: 'b.ts' }, ctx);
    const res = await editTool.handler(
      { path: 'b.ts', old_string: 'if (x) {\n    return 1;\n}', new_string: 'if (x) {\n    return 2;\n}' },
      ctx,
    );
    expect(res.isError).toBe(false);
    expect((res.structured as { matchLevel: string }).matchLevel).toBe('indent');
    // la tool releyó y re-registró el hash: se puede volver a editar sin pasar por read_file de nuevo.
    const res2 = await editTool.handler({ path: 'b.ts', old_string: 'return 2;', new_string: 'return 3;' }, ctx);
    expect(res2.isError).toBe(false);
  });

  it('replace_all reemplaza todas las ocurrencias exactas', async () => {
    writeFileSync(path.join(root, 'c.ts'), 'foo();\nfoo();\nfoo();\n');
    const readTool = createReadFileTool(deps);
    const editTool = createEditFileTool(deps);
    const ctx = makeToolContext(root);
    await readTool.handler({ path: 'c.ts' }, ctx);
    const res = await editTool.handler({ path: 'c.ts', old_string: 'foo();', new_string: 'bar();', replace_all: true }, ctx);
    expect(res.isError).toBe(false);
    const onDisk = readFileSync(path.join(root, 'c.ts'), 'utf8');
    expect(onDisk).toBe('bar();\nbar();\nbar();\n');
  });

  it('usa tool_calls.expected_pre_hash persistido en vez del ReadTracker cuando está inyectado (doc 16 §4 ítem 16: sobrevive a un reinicio real)', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
    const { hash: realHash } = await createWorkspaceFs(root).readFile('a.ts');

    // Simula la fila `tool_calls` tal como quedó persistida ANTES de un reinicio real: expected_pre_hash
    // ya vale el hash correcto para este toolCallId, aunque el ReadTracker de ESTE proceso (uno nuevo,
    // "reabierto") esté completamente vacío — nunca se llamó a read_file acá.
    const persisted = new Map<string, string>([['tc-persisted', realHash]]);
    const depsWithStore: BuiltinToolsDeps = {
      ...defaultBuiltinToolsDeps(),
      expectedPreHash: { async get(toolCallId) { return persisted.get(toolCallId); } },
    };
    const editTool = createEditFileTool(depsWithStore);
    const ctx = makeToolContext(root, { toolCallId: 'tc-persisted' });

    // Sin este mecanismo, la comparación contra `depsWithStore.readTracker` (vacío) fallaría con
    // "nunca lo leíste en este run" pese a que el archivo no cambió.
    const res = await editTool.handler({ path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 42;' }, ctx);
    expect(res.isError).toBe(false);
    expect(readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('const a = 42;\n');
  });

  it('detecta conflicto contra expected_pre_hash persistido aunque el ReadTracker (memoria) tenga otro valor', async () => {
    writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
    const depsWithStore: BuiltinToolsDeps = {
      ...defaultBuiltinToolsDeps(),
      expectedPreHash: { async get() { return 'hash-viejo-que-no-coincide'; } },
    };
    const readTool = createReadFileTool(depsWithStore);
    const editTool = createEditFileTool(depsWithStore);
    const ctx = makeToolContext(root, { toolCallId: 'tc-conflict' });
    // El ReadTracker SÍ registra el hash real (como si read_file se hubiera llamado en este mismo
    // proceso) — pero con el puerto persistido inyectado, ese registro en memoria no debe ganar.
    await readTool.handler({ path: 'a.ts' }, ctx);
    const res = await editTool.handler({ path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0]?.type === 'text' ? res.content[0].text : '')).toContain('cambió desde que lo leíste');
  });

  it('rehúsa editar una ruta protegida', async () => {
    writeFileSync(path.join(root, '.env'), 'SECRET=1');
    const editTool = createEditFileTool(deps);
    const ctx = makeToolContext(root);
    const res = await editTool.handler({ path: '.env', old_string: 'SECRET=1', new_string: 'SECRET=2' }, ctx);
    expect(res.isError).toBe(true);
  });
});
