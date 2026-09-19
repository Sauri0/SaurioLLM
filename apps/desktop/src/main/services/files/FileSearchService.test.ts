import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSearchService, type FileSearchWorkspace } from './FileSearchService.js';

const roots: string[] = [];

function makeWorkspace(name: string): FileSearchWorkspace {
  const root = mkdtempSync(path.join(tmpdir(), `saurio-file-search-${name}-`));
  roots.push(root);
  // El servicio recibe estas reglas del WorkspaceFs real. Las representamos para verificar que las
  // consulta antes de recorrer/leer; WorkspaceFs tiene sus propias pruebas de parseo de ignores.
  return {
    projectId: name,
    projectRoot: root,
    workspaceFs: {
      isProtected: (relPath) => relPath.split('/').includes('.git') || relPath.startsWith('.env'),
      isIgnored: (relPath) => ['ignored.txt', 'ignored-dir', 'ignored-dir/', 'private.txt'].includes(relPath),
    },
  };
}

function input(projectId: string, requestId: string, query: string, extra: Partial<{
  mode: 'path' | 'content' | 'all'; offset: number; limit: number;
}> = {}) {
  return { projectId, requestId, query, ...extra };
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('FileSearchService', () => {
  it('queda dentro del proyecto y no indexa protegidos, ignorados, binarios ni enlaces', async () => {
    const projectA = makeWorkspace('project-a');
    const projectB = makeWorkspace('project-b');
    mkdirSync(path.join(projectA.projectRoot, 'src'));
    mkdirSync(path.join(projectA.projectRoot, '.git'));
    mkdirSync(path.join(projectA.projectRoot, 'ignored-dir'));
    writeFileSync(path.join(projectA.projectRoot, '.gitignore'), 'ignored.txt\nignored-dir/\n');
    writeFileSync(path.join(projectA.projectRoot, '.saurioignore'), 'private.txt\n');
    writeFileSync(path.join(projectA.projectRoot, 'src', 'needle-name.ts'), 'const value = 1;');
    // La coincidencia queda después de 512 KiB para asegurar que la búsqueda es streaming, no una
    // lectura parcial ni una acumulación del archivo completo.
    writeFileSync(path.join(projectA.projectRoot, 'src', 'content.ts'), `${'x\n'.repeat(300_000)}const phrase = "needle content";`);
    writeFileSync(path.join(projectA.projectRoot, '.git', 'needle-secret.txt'), 'needle');
    writeFileSync(path.join(projectA.projectRoot, 'ignored.txt'), 'needle');
    writeFileSync(path.join(projectA.projectRoot, 'ignored-dir', 'needle.ts'), 'needle');
    writeFileSync(path.join(projectA.projectRoot, 'private.txt'), 'needle');
    writeFileSync(path.join(projectA.projectRoot, 'binary.dat'), Buffer.from('needle\u0000binary', 'utf8'));
    writeFileSync(path.join(projectB.projectRoot, 'needle-other-project.ts'), 'needle');
    try {
      symlinkSync(path.join(projectB.projectRoot, 'needle-other-project.ts'), path.join(projectA.projectRoot, 'outside-link.ts'), 'file');
    } catch {
      // Algunos Windows de CI no permiten symlinks a usuarios sin Developer Mode; el servicio igual
      // se protege por lstat/realpath y el resto del caso cubre el aislamiento de raíz.
    }

    const result = await new FileSearchService().search(projectA, input('project-a', 'request-1', 'needle'));
    expect(result.cancelled).toBe(false);
    expect(result.items.map((item) => item.relPath)).toEqual(['src/content.ts', 'src/needle-name.ts']);
    expect(result.items.find((item) => item.relPath === 'src/content.ts')).toMatchObject({ match: 'content', line: 300001, excerpt: expect.stringContaining('needle content') });
    expect(result.items.some((item) => item.relPath.includes('outside-link'))).toBe(false);
  });

  it('centra el extracto de una línea larga en la coincidencia', async () => {
    const workspace = makeWorkspace('excerpt');
    writeFileSync(path.join(workspace.projectRoot, 'long.ts'), `${'x'.repeat(500)}needle-centrado${'y'.repeat(500)}`);
    const result = await new FileSearchService().search(workspace, input('excerpt', 'request-excerpt', 'needle-centrado', { mode: 'content' }));
    const excerpt = result.items[0]?.excerpt;
    if (!excerpt) throw new Error('la coincidencia debe traer un extracto');
    expect(excerpt).toContain('needle-centrado');
    expect(excerpt.length).toBeLessThanOrEqual(400);
  });

  it('pagina resultados acotados por archivo con orden repetible', async () => {
    const workspace = makeWorkspace('pagination');
    for (let index = 0; index < 25; index += 1) {
      writeFileSync(path.join(workspace.projectRoot, `match-${String(index).padStart(2, '0')}.ts`), 'x');
    }
    const service = new FileSearchService();
    const first = await service.search(workspace, input('pagination', 'page-1', 'match', { mode: 'path', limit: 10 }));
    const second = await service.search(workspace, input('pagination', 'page-2', 'match', { mode: 'path', limit: 10, offset: 10 }));
    const last = await service.search(workspace, input('pagination', 'page-3', 'match', { mode: 'path', limit: 10, offset: 20 }));
    expect([first.items.length, second.items.length, last.items.length]).toEqual([10, 10, 5]);
    expect([first.hasMore, second.hasMore, last.hasMore]).toEqual([true, true, false]);
    expect(new Set([...first.items, ...second.items, ...last.items].map((item) => item.relPath)).size).toBe(25);
  });

  it('cancela la consulta vigente por projectId y requestId sin devolver resultados parciales', async () => {
    const workspace = makeWorkspace('cancel');
    writeFileSync(path.join(workspace.projectRoot, 'needle.ts'), 'needle');
    const service = new FileSearchService();
    const searching = service.search(workspace, input('cancel', 'request-cancel', 'needle'));
    service.cancel('cancel', 'request-cancel');
    await expect(searching).resolves.toEqual({ requestId: 'request-cancel', items: [], hasMore: false, cancelled: true });
  });

  it('cancela todas las búsquedas pendientes al cerrar o cambiar de proyecto', async () => {
    const workspace = makeWorkspace('cancel-all');
    writeFileSync(path.join(workspace.projectRoot, 'needle.ts'), 'needle');
    const service = new FileSearchService();
    const searching = service.search(workspace, input('cancel-all', 'request-all', 'needle'));
    service.cancelAll();
    await expect(searching).resolves.toMatchObject({ requestId: 'request-all', cancelled: true, items: [] });
  });
});
