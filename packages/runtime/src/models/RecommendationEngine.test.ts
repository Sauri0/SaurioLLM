// Tests de RecommendationEngine — packages/runtime/src/models/RecommendationEngine.test.ts.
import { describe, expect, it } from 'vitest';
import { RecommendationEngine, RecommendationEnrichmentUnavailableError } from './RecommendationEngine.js';
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
  it('recomienda con estimaciones si el enriquecimiento está offline, sin repetir el sondeo', async () => {
    let probes = 0;
    const engine = new RecommendationEngine([
      entry({ name: 'small', sizeBytes: GIB }), entry({ name: 'other', sizeBytes: 2 * GIB }),
    ], undefined, {
      fitClassFor: async () => {
        probes++;
        throw new RecommendationEnrichmentUnavailableError(new Error('motor apagado'));
      },
    });
    const results = await engine.recommend(hw(8), 'coding', 'quality');
    expect(probes).toBe(1);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.fitQuality === 'estimated' && result.contextUsed === 40960)).toBe(true);
  });

  it('mantiene las recomendaciones curadas si falla el lookup tested opcional', async () => {
    let probes = 0;
    const engine = new RecommendationEngine([
      entry({ name: 'small', sizeBytes: GIB }), entry({ name: 'other', sizeBytes: 2 * GIB }),
    ], {
      lookup: async () => {
        probes++;
        throw new RecommendationEnrichmentUnavailableError(new Error('Ollama offline'));
      },
    });

    const results = await engine.recommend(hw(8), 'coding', 'speed');

    expect(probes).toBe(1);
    expect(results.map((result) => result.catalogEntry.name)).toEqual(['small', 'other']);
    expect(results.every((result) => result.fitQuality === 'estimated' && result.tested === undefined)).toBe(true);
  });

  it('no oculta errores generales del lookup opcional', async () => {
    const engine = new RecommendationEngine([entry({})], undefined, {
      fitClassFor: async () => { throw new Error('inventario corrupto'); },
    });

    await expect(engine.recommend(hw(8), 'coding', 'quality')).rejects.toThrow('inventario corrupto');
  });

  it('no anuncia tight en una GPU integrada si excede la RAM compartida disponible', async () => {
    const hardware = hw(16);
    hardware.gpu!.integrated = true;
    hardware.ram.freeBytes.value = 8 * GIB;
    // 7.59 GiB estimados frente a 7.5 disponibles: dentro del 5 %, pero fuera del pool físico.
    const catalog = [entry({ sizeBytes: 6.6 * GIB, contextMax: 16_384 })];
    const [result] = await new RecommendationEngine(catalog).recommend(hardware, 'coding', 'quality');
    expect(result?.fitClass).toBe('no_fit');
  });

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
    const [result] = await engine.recommend(hw(10, 0.9), 'chat', 'speed');
    expect(result?.fitClass).toBe('fits_gpu');
    expect(result?.speedHint).toBe('fast');
  });

  it('clasifica no_fit cuando ni los pesos entran en la VRAM libre (caso gemma4:31b real)', async () => {
    const catalog = [entry({ name: 'gemma4', tag: '31b', sizeBytes: 19.87 * GIB, suggestedUse: ['chat'] })];
    const engine = new RecommendationEngine(catalog);
    const [result] = await engine.recommend(hw(8, 0.9), 'chat', 'speed');
    expect(result?.fitClass).toBe('no_fit');
    expect(result?.usesCpuOffload).toBe(false);
  });

  it('ordena por tamaño ascendente con goal=speed y descendente con goal=quality', async () => {
    const catalog = [
      entry({ name: 'small', sizeBytes: 1 * GIB, suggestedUse: ['chat'] }),
      entry({ name: 'big', sizeBytes: 8 * GIB, suggestedUse: ['chat'] }),
    ];
    const engine = new RecommendationEngine(catalog);
    const speed = await engine.recommend(hw(64), 'chat', 'speed');
    expect(speed.map((r) => r.catalogEntry.name)).toEqual(['small', 'big']);
    const quality = await engine.recommend(hw(64), 'chat', 'quality');
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

  it('nunca recomienda variantes cloud y prioriza un fit viable sobre un modelo mayor que no entra', async () => {
    const catalog = [
      entry({ name: 'cloud', cloud: true, sizeBytes: 0, suggestedUse: ['analysis'] }),
      entry({ name: 'huge', sizeBytes: 80 * GIB, suggestedUse: ['analysis'] }),
      entry({ name: 'local', sizeBytes: 2 * GIB, suggestedUse: ['analysis'] }),
    ];
    const results = await new RecommendationEngine(catalog).recommend(hw(8), 'analysis', 'quality');
    expect(results.map((item) => item.catalogEntry.name)).toEqual(['local', 'huge']);
    expect(results[0]).toMatchObject({ locality: 'local', fitQuality: 'estimated', contextUsed: 40960 });
    expect(results[0]?.reason).toContain('contexto');
  });

  it('consulta el fit instalado al máximo de contexto y conserva su calidad de evidencia', async () => {
    const seen: number[] = [];
    const engine = new RecommendationEngine([entry({ contextMax: 32768, suggestedUse: ['coding'] })], undefined, {
      fitClassFor: async (_catalogEntry, contextMax) => {
        seen.push(contextMax);
        return { fitClass: 'partial_offload', fitQuality: 'estimated', contextUsed: contextMax };
      },
    });
    const [result] = await engine.recommend(hw(8), 'coding', 'quality');
    expect(seen).toEqual([32768]);
    expect(result).toMatchObject({ fitClass: 'partial_offload', usesCpuOffload: true, fitQuality: 'estimated', contextUsed: 32768 });
    expect(result?.reason).toContain('offload');
  });

  it('reconsulta la evidencia con el fingerprint vigente cuando cambia el hardware', async () => {
    const seen: string[] = [];
    const engine = new RecommendationEngine([entry({ suggestedUse: ['chat'] })], undefined, {
      fitClassFor: async (_catalogEntry, contextMax, hardwareFingerprint) => {
        seen.push(hardwareFingerprint);
        return { fitClass: 'fits_gpu', fitQuality: 'measured', contextUsed: contextMax };
      },
    });
    const first = hw(8);
    const refreshed = { ...hw(8), fingerprint: 'fp-refreshed' };

    await engine.recommend(first, 'chat', 'quality');
    await engine.recommend(refreshed, 'chat', 'quality');

    expect(seen).toEqual(['fp-test', 'fp-refreshed']);
  });

  it('usa mayor contexto como desempate de calidad, sin inventar un score', async () => {
    const catalog = [
      entry({ name: 'short', sizeBytes: 2 * GIB, contextMax: 8192, suggestedUse: ['chat'] }),
      entry({ name: 'long', sizeBytes: 2 * GIB, contextMax: 32768, suggestedUse: ['chat'] }),
    ];
    const results = await new RecommendationEngine(catalog).recommend(hw(64), 'chat', 'quality');
    expect(results.map((item) => item.catalogEntry.name)).toEqual(['long', 'short']);
  });

  it('iGPU no declara fit por el techo gráfico cuando la RAM libre real no alcanza', async () => {
    const integrated: HardwareProfile = {
      ...hw(16),
      ram: {
        totalBytes: { value: 32 * GIB, quality: 'measured', source: 'os', sampledAt: 0 },
        freeBytes: { value: 2 * GIB, quality: 'measured', source: 'os', sampledAt: 0 },
      },
      gpu: {
        vendor: 'intel', integrated: true,
        vramTotalBytes: { value: 16 * GIB, quality: 'measured', source: 'ollama', sampledAt: 0 },
        vramUsedBytes: { value: 0, quality: 'measured', source: 'ollama', sampledAt: 0 },
      },
    };
    const [result] = await new RecommendationEngine([
      entry({ name: 'shared-memory-too-large', sizeBytes: 6 * GIB, suggestedUse: ['chat'] }),
    ]).recommend(integrated, 'chat', 'quality');
    expect(result?.fitClass).toBe('no_fit');
  });

  it('en offload estimado prioriza el modelo chico para dejar margen, aun con goal quality', async () => {
    const catalog = [
      entry({ name: 'gemma4', tag: '31b', sizeBytes: 20 * GIB, contextMax: 262144, suggestedUse: ['analysis'] }),
      entry({ name: 'qwen3', tag: '8b', sizeBytes: 5 * GIB, contextMax: 40960, suggestedUse: ['analysis'] }),
    ];
    const engine = new RecommendationEngine(catalog, undefined, {
      fitClassFor: async (_catalogEntry, contextMax) => ({
        fitClass: 'partial_offload', fitQuality: 'estimated', contextUsed: contextMax,
      }),
    });
    const results = await engine.recommend(hw(8), 'analysis', 'quality');
    expect(results.map((result) => result.catalogEntry.name)).toEqual(['qwen3', 'gemma4']);
    expect(results.map((result) => result.contextUsed)).toEqual([40960, 262144]);
    expect(results[0]?.reason).toContain('modelos más chicos');
    expect(results[0]?.reason).toContain('Estimación de memoria');
  });
});
