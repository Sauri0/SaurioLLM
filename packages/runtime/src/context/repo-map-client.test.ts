// Test del stub de RepoMapClient: árbol plano de archivos, recortado por presupuesto
// — packages/runtime/src/context/repo-map-client.test.ts.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepoMapClient } from './repo-map-client.js';

describe('context/RepoMapClient (stub árbol plano)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'saurio-repomap-test-'));
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1;');
    writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), '// no debería aparecer');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lista archivos del proyecto sin node_modules', async () => {
    const client = createRepoMapClient();
    const { text } = await client.build(dir, { budgetTokens: 1_000, mentioned: [], touched: [] });

    expect(text).toContain('src/a.ts');
    expect(text).toContain('src/b.ts');
    expect(text).not.toContain('node_modules');
  });

  it('respeta el presupuesto de tokens y prioriza archivos mencionados/tocados', async () => {
    const client = createRepoMapClient();
    const { text, tokens } = await client.build(dir, { budgetTokens: 1, mentioned: ['src/b.ts'], touched: [] });

    expect(tokens).toBeGreaterThan(0);
    // Con presupuesto mínimo entra al menos el primer archivo priorizado.
    expect(text).toContain('src/b.ts');
  });
});
