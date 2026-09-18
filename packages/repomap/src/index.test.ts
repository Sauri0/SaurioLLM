// Test de humo del pipeline completo de @saurio/repomap sobre un fixture mini (doc 07 §2).
// Se salta si no hay grammars en resources/grammars (mismo criterio que loader.test.ts).
// Nota: `files.ts` prefiere `rg --files`, pero en este equipo `rg` solo existe como función de
// shell de Claude Code (no como binario real en PATH accesible a child_process.spawn) — cae al
// walker manual de fallback, así que el pipeline igual corre acá (ver files.ts, walkManually).
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hasGrammar } from './loader.js';
import { RepoMapEngine } from './index.js';
import { buildGraph } from './graph.js';
import { personalizedPageRank } from './pagerank.js';
import { estimateTokens, renderFileBlock, renderRepoMap } from './render.js';
import type { RepoTag } from './types.js';

const canRun = hasGrammar('typescript') && hasGrammar('python');

function makeFixture(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saurio-repomap-'));
  mkdirSync(path.join(dir, 'src'));

  writeFileSync(
    path.join(dir, 'src', 'gateway.ts'),
    [
      'export interface ModelGateway {',
      '  chat(ref: string): Promise<string>;',
      '}',
      '',
      'export class DefaultGateway implements ModelGateway {',
      '  async chat(ref: string): Promise<string> {',
      '    return ref;',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    path.join(dir, 'src', 'context.ts'),
    [
      "import { DefaultGateway } from './gateway.js';",
      '',
      'export class ContextBuilder {',
      '  private gateway = new DefaultGateway();',
      '',
      '  build(): Promise<string> {',
      "    return this.gateway.chat('hola');",
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  writeFileSync(
    path.join(dir, 'src', 'unused.ts'),
    ['export function unrelatedHelper(): number {', '  return 42;', '}', ''].join('\n'),
  );

  writeFileSync(
    path.join(dir, 'main.py'),
    [
      'class Runner:',
      '    def run(self):',
      '        return build_context()',
      '',
      'def build_context():',
      "    return 'ok'",
      '',
    ].join('\n'),
  );

  writeFileSync(path.join(dir, 'notes.md'), '# solo texto, sin grammar\n');

  return dir;
}

describe.skipIf(!canRun)('repomap/RepoMapEngine (pipeline completo)', () => {
  let dir: string;

  beforeAll(() => {
    dir = makeFixture();
  });

  afterEach(() => {
    // nada por test; el fixture se limpia en el afterAll implícito del proceso (tmpdir del SO)
  });

  it('index() indexa los archivos soportados y extrae tags', async () => {
    const engine = new RepoMapEngine();
    const result = await engine.index(dir);
    expect(result.filesIndexed).toBeGreaterThan(0);

    const gatewayTags = engine.tagsFor('src/gateway.ts');
    const defNames = gatewayTags.filter((t) => t.kind === 'def').map((t) => t.name);
    expect(defNames).toContain('DefaultGateway');
    expect(defNames).toContain('ModelGateway');
  });

  it('rankFiles() sube context.ts por referenciar a DefaultGateway de gateway.ts', async () => {
    const engine = new RepoMapEngine();
    await engine.index(dir);
    const ranked = engine.rankFiles();
    const files = ranked.map((r) => r.file);
    expect(files).toContain('src/gateway.ts');
    expect(files).toContain('src/context.ts');

    // gateway.ts es referenciado por context.ts -> debería rankear por encima de unused.ts,
    // que no tiene ninguna arista entrante.
    const gatewayRank = ranked.find((r) => r.file === 'src/gateway.ts')?.rank ?? 0;
    const unusedRank = ranked.find((r) => r.file === 'src/unused.ts')?.rank ?? 0;
    expect(gatewayRank).toBeGreaterThan(unusedRank);
  });

  it('rank(query, budgetTokens) arma texto compacto dentro del presupuesto', async () => {
    const engine = new RepoMapEngine();
    await engine.index(dir);
    const wide = engine.rank({}, 2000);
    expect(wide.text).toContain('src/gateway.ts:');
    expect(wide.text).toContain('│ DefaultGateway');
    expect(wide.tokens).toBeLessThanOrEqual(2000);

    const narrow = engine.rank({}, 5);
    expect(narrow.tokens).toBeLessThanOrEqual(5);
  });

  it('índice incremental (changedFiles) no reprocesa archivos no tocados', async () => {
    const engine = new RepoMapEngine();
    await engine.index(dir);
    const before = engine.tagsFor('src/gateway.ts');

    const second = await engine.index(dir, ['src/context.ts']);
    expect(second.filesIndexed).toBe(1);
    expect(engine.tagsFor('src/gateway.ts')).toEqual(before);
  });

  it('python entra con la grammar de python (defs de main.py)', async () => {
    const engine = new RepoMapEngine();
    await engine.index(dir);
    const names = engine.tagsFor('main.py').filter((t) => t.kind === 'def').map((t) => t.name);
    expect(names).toContain('Runner');
    expect(names).toContain('build_context');
  });

  it('archivo sin grammar (notes.md) queda indexado sin tags (degradación a plano)', async () => {
    const engine = new RepoMapEngine();
    await engine.index(dir);
    expect(engine.listIndexedFiles()).toContain('notes.md');
    expect(engine.tagsFor('notes.md')).toEqual([]);
  });
});

describe('repomap/graph+pagerank+render (unidad, sin filesystem)', () => {
  it('buildGraph conecta A->B cuando A referencia un símbolo definido en B', () => {
    const tags = new Map<string, RepoTag[]>([
      ['a.ts', [{ file: 'a.ts', name: 'foo', kind: 'ref', line: 1 }]],
      ['b.ts', [{ file: 'b.ts', name: 'foo', kind: 'def', line: 1 }]],
    ]);
    const graph = buildGraph(tags);
    expect(graph.edges.get('a.ts')?.get('b.ts')).toBeGreaterThan(0);
  });

  it('personalizedPageRank sesga hacia el archivo personalizado', () => {
    const tags = new Map<string, RepoTag[]>([
      ['a.ts', [{ file: 'a.ts', name: 'foo', kind: 'ref', line: 1 }]],
      ['b.ts', [{ file: 'b.ts', name: 'foo', kind: 'def', line: 1 }]],
      ['c.ts', []],
    ]);
    const graph = buildGraph(tags);
    const ranked = personalizedPageRank(graph, { personalization: ['c.ts'] });
    const c = ranked.find((r) => r.file === 'c.ts');
    expect(c).toBeDefined();
    expect(c!.rank).toBeGreaterThan(0);
  });

  it('renderFileBlock separa definiciones no contiguas con ⋮', () => {
    const block = renderFileBlock('src/x.ts', [
      { name: 'foo', line: 1 },
      { name: 'bar', line: 10 },
    ]);
    expect(block).toContain('src/x.ts:');
    expect(block).toContain('│ foo');
    expect(block).toContain('⋮');
    expect(block).toContain('│ bar');
  });

  it('renderRepoMap respeta el presupuesto (nunca se pasa)', () => {
    const ranked = [
      { file: 'a.ts', rank: 1, lang: 'typescript' as const, tags: [{ file: 'a.ts', name: 'foo', kind: 'def' as const, line: 1 }] },
      { file: 'b.ts', rank: 0.5, lang: 'typescript' as const, tags: [{ file: 'b.ts', name: 'bar', kind: 'def' as const, line: 1 }] },
    ];
    const result = renderRepoMap(ranked, 3);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(3);
  });
});
