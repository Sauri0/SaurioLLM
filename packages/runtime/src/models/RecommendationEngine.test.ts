// Tests de RecommendationEngine — packages/runtime/src/models/RecommendationEngine.test.ts.
import { describe, expect, it } from 'vitest';
import { RecommendationEngine } from './RecommendationEngine.js';
import type { HardwareProfile, ModelCatalogEntry } from './types.js';

const GIB = 1024 * 1024 * 1024;

function hw(vramTotalGib: number, vramUsedGib = 0): HardwareProfile {
  return {
    cpu: { name: { value: 'x', quality: 'measured', source: 'os', sampledAt: 0 }, threads: { value: 8, quality: 'measured', source: 'os', sampledAt: 0 } },
    ram: { totalBytes: { value: 32 * GIB, quality: 'measured', source: 'os', sampledAt: 0 }, freeBytes: { value: 16 * GIB, quality: 'measured', source: 'os', sampledAt: 0 } },
    gpu: {
      vendor: 'nvidia',
      vramTotalBytes: { value: vramTotalGib * GIB, quality: 'measured', source: 'nvidia-smi', sampledAt: 0 },
      vramUsedBytes: { value: vramUsedGib * GIB, quality: 'measured', source: 'nvidia-smi', sampledAt: 0 },
    },
    fingerprint: 'fp-test',
    sampledAt: 0,
  };
}

function entry(overrides: Partial<ModelCatalogEntry>): ModelCatalogEntry {
  return {
    name: 'qwen3', tag: '8b', sizeBytes: 5 * GIB,
    capabilities: { tools: true, thinking: true, vision: false, embedding: false },
    contextMax: 40960, suggestedUse: ['coding', 'chat'],
    ...overrides,
  };
}

describe('RecommendationEngine', () => {
  it('filtra por capability requerida (coding exige tools, vision exige vision)', async () => {
    const catalog = [
      entry({ name: 'no-tools', capabilities: { tools: false, thinking: false, vision: false, embedding: false }, suggestedUse: ['coding'] }),
      entry({ name: 'yes-tools', suggestedUse: ['coding'] }),
    ];
    const engine = new RecommendationEngine(catalog);
    const results = await engine.recommend(hw(8), 'coding', 'speed');
    expect(results.map((r) => r.catalogEntry.name)).toEqual(['yes-tools']);
  });

  it('clasifica fits_gpu cuando el modelo entra cómodo en la VRAM libre', async () => {
    const catalog = [entry({ name: 'qwen3', sizeBytes: 5 * GIB, suggestedUse: ['chat'] })];
    const engine = new RecommendationEngine(catalog);
    const [result] = await engine.recommend(hw(8, 0.9), 'chat', 'speed');
    expect(result?.fitClass).toBe('fits_gpu');
    expect(result?.speedHint).toBe('fast');
  });

  it('clasifica no_fit cuando ni los pesos entran en la VRAM libre (caso gemma4:31b real)', async () => {
    const catalog = [entry({ name: 'gemma4', tag: '31b', sizeBytes: 19.87 * GIB, suggestedUse: ['chat'] })];
    const engine = new RecommendationEngine(catalog);
    const [result] = await engine.recommend(hw(8, 0.9), 'chat', 'speed');
    expect(result?.fitClass).toBe('no_fit');
    expect(result?.usesCpuOffload).toBe(true);
  });

  it('ordena por tamaño ascendente con goal=speed y descendente con goal=quality', async () => {
    const catalog = [
      entry({ name: 'small', sizeBytes: 1 * GIB, suggestedUse: ['chat'] }),
      entry({ name: 'big', sizeBytes: 8 * GIB, suggestedUse: ['chat'] }),
    ];
    const engine = new RecommendationEngine(catalog);
    const speed = await engine.recommend(hw(8), 'chat', 'speed');
    expect(speed.map((r) => r.catalogEntry.name)).toEqual(['small', 'big']);
    const quality = await engine.recommend(hw(8), 'chat', 'quality');
    expect(quality.map((r) => r.catalogEntry.name)).toEqual(['big', 'small']);
  });

  it('marca "tested" solo si hay una fila model_compat para este hardwareFingerprint', async () => {
    const catalog = [entry({ name: 'qwen3', suggestedUse: ['chat'] })];
    const engine = new RecommendationEngine(catalog, {
      lookup: async (catalogEntry) =>
        catalogEntry.name === 'qwen3' ? { tokPerSec: 62, testedAt: 123 } : undefined,
    });
    const [result] = await engine.recommend(hw(8), 'chat', 'speed');
    expect(result?.tested).toEqual({ tokPerSec: 62, testedAt: 123, hardwareFingerprint: 'fp-test' });
  });
});
