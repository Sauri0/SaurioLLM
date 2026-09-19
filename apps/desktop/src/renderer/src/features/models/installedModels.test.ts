import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@saurio/shared';
import {
  installedModelKey, installedPage, installedPageCount, localDetailCandidates, mapWithConcurrency,
} from './installedModels.js';

function model(index: number, providerId = 'ollama', locality: ModelInfo['ref']['locality'] = 'local'): ModelInfo {
  return {
    ref: { providerId, name: `modelo-${index}`, locality },
    digest: `digest-${index}`,
    sizeBytes: index,
    family: 'test',
    parameterSize: '1B',
    quantization: 'Q4',
    capabilities: { tools: false, thinking: false, vision: false, embedding: false },
  };
}

describe('installedModels', () => {
  it('identifica por providerId+name aunque dos proveedores usen el mismo nombre', () => {
    expect(installedModelKey({ providerId: 'ollama', name: 'same' })).toBe('ollama::same');
    expect(installedModelKey({ providerId: 'openrouter', name: 'same' })).toBe('openrouter::same');
  });

  it('pagina toda la colección sin ocultar lo que queda después de los primeros 100', () => {
    const models = Array.from({ length: 137 }, (_, index) => model(index));

    expect(installedPageCount(models.length, 20)).toBe(7);
    expect(installedPage(models, 1, 20).map((item) => item.ref.name)).toEqual(
      Array.from({ length: 20 }, (_, index) => `modelo-${index}`),
    );
    expect(installedPage(models, 7, 20).map((item) => item.ref.name)).toEqual(
      Array.from({ length: 17 }, (_, index) => `modelo-${index + 120}`),
    );
  });

  it('pide detalle sólo para locales visibles que no fueron solicitados', () => {
    const localA = model(1, 'ollama', 'local');
    const updatedLocalA = { ...localA, digest: 'digest-actualizado' };
    const localB = model(2, 'ollama', 'local');
    const cloud = model(3, 'openrouter', 'cloud');
    const requested = new Set([`${installedModelKey(localA.ref)}::${localA.digest}`]);

    expect(localDetailCandidates([localA, cloud, localB], requested)).toEqual([localB]);
    expect(localDetailCandidates([updatedLocalA], requested)).toEqual([updatedLocalA]);
    const manual: ModelInfo = { ...localB, metadataSource: 'manual', manualDefinition: true };
    expect(localDetailCandidates([manual], new Set())).toEqual([]);
  });

  it('limita el trabajo concurrente a dos y conserva el orden', async () => {
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];
    const work = mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return value * 10;
    });

    while (release.length < 2) await Promise.resolve();
    release.shift()?.();
    while (release.length < 2) await Promise.resolve();
    release.shift()?.();
    while (release.length < 2) await Promise.resolve();
    release.shift()?.();
    while (release.length < 2) await Promise.resolve();
    release.shift()?.();
    while (release.length < 1) await Promise.resolve();
    release.shift()?.();

    await expect(work).resolves.toEqual([10, 20, 30, 40, 50]);
    expect(maxActive).toBe(2);
  });
});
