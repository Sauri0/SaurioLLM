// Test de resolveRepoMapResourceDirs (punto 5 del encargo: "recibir la ruta inyectada desde main")
// — apps/desktop/src/main/services/resources.test.ts. Arma layouts de carpetas reales en un temp
// dir (sin mockear fs) que imitan la forma real de dev (monorepo) y de un build empaquetado
// (extraResources de electron-builder.yml), y verifica que resolveRepoMapResourceDirs encuentra
// exactamente lo que createRuntime.ts espera pasarle a configureRepoMapResources.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRepoMapResourceDirs } from './resources.js';

describe('resolveRepoMapResourceDirs', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'saurio-resources-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('en dev (sin resourcesPath), resuelve resources/grammars y packages/repomap/queries dos niveles arriba de appPath', () => {
    const appPath = path.join(tmp, 'apps', 'desktop');
    mkdirSync(path.join(tmp, 'resources', 'grammars'), { recursive: true });
    mkdirSync(path.join(tmp, 'packages', 'repomap', 'queries'), { recursive: true });
    mkdirSync(appPath, { recursive: true });

    const result = resolveRepoMapResourceDirs({ appPath });

    expect(result.grammarsDir).toBe(path.join(tmp, 'resources', 'grammars'));
    expect(result.queriesDir).toBe(path.join(tmp, 'packages', 'repomap', 'queries'));
  });

  it('en empaquetado (con resourcesPath), resuelve resourcesPath/grammars y resourcesPath/repomap-queries planos, sin mirar el layout de dev', () => {
    const appPath = path.join(tmp, 'app.asar'); // dentro del asar: la ruta de dev candidata no existe
    const resourcesPath = path.join(tmp, 'resources-pkg');
    mkdirSync(path.join(resourcesPath, 'grammars'), { recursive: true });
    mkdirSync(path.join(resourcesPath, 'repomap-queries'), { recursive: true });

    const result = resolveRepoMapResourceDirs({ appPath, resourcesPath });

    expect(result.grammarsDir).toBe(path.join(resourcesPath, 'grammars'));
    expect(result.queriesDir).toBe(path.join(resourcesPath, 'repomap-queries'));
  });

  it('sin ninguna carpeta real (ni dev ni empaquetado), devuelve undefined en vez de una ruta inexistente', () => {
    const appPath = path.join(tmp, 'apps', 'desktop');
    mkdirSync(appPath, { recursive: true });

    const result = resolveRepoMapResourceDirs({ appPath, resourcesPath: path.join(tmp, 'no-existe') });

    expect(result.grammarsDir).toBeUndefined();
    expect(result.queriesDir).toBeUndefined();
  });
});
