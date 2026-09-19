import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@saurio/shared';
import { DEFAULT_MODEL_FILTERS, filterModels } from './modelFilter.js';

function model(index: number, overrides: Partial<ModelInfo['ref']> & Partial<Pick<ModelInfo, 'contextMax'>> = {}): ModelInfo {
  return {
    ref: { providerId: overrides.providerId ?? 'ollama', name: overrides.name ?? `model-${index}`, locality: overrides.locality ?? 'local' },
    digest: `sha-${index}`, sizeBytes: 1, family: 'test', parameterSize: '8B', quantization: 'Q4',
    capabilities: { tools: false, thinking: false, vision: false, embedding: false }, contextMax: overrides.contextMax ?? 8192,
  };
}

describe('modelFilter', () => {
  it('only treats confirmed zero tariffs without request or image charges as free', () => {
    const free: ModelInfo = { ...model(1), metadataSource: 'openrouter', metadataCheckedAt: 1,
      pricing: { promptUsdPerToken: 0, completionUsdPerToken: 0, requestUsd: 0, imageUsd: 0 } };
    const unknownRequestOrImage = { ...free, ref: { ...free.ref, name: 'unknown-request-or-image' },
      pricing: { promptUsdPerToken: 0, completionUsdPerToken: 0 } };
    const requestFee = { ...free, ref: { ...free.ref, name: 'request-fee' }, pricing: { ...free.pricing, requestUsd: 0.01 } };
    const imageFee = { ...free, ref: { ...free.ref, name: 'image-fee' }, pricing: { ...free.pricing, imageUsd: 0.01 } };
    expect(filterModels([free, unknownRequestOrImage, requestFee, imageFee, model(2)], { ...DEFAULT_MODEL_FILTERS, freeOnly: true })).toEqual([free]);
  });

  it('keeps favorite membership isolated between providers with equal model names', () => {
    const first = model(1, { name: 'same', providerId: 'one' });
    const second = model(2, { name: 'same', providerId: 'two' });
    expect(filterModels([first, second], { ...DEFAULT_MODEL_FILTERS, favoritesOnly: true }, { favoriteIds: new Set(['two::same']) })).toEqual([second]);
  });
  it('deduplica por providerId/name y limita el resultado a los modelos reales', () => {
    const models = Array.from({ length: 1000 }, (_, index) => model(index));
    const result = filterModels([...models, models[0]!], DEFAULT_MODEL_FILTERS);
    expect(result).toHaveLength(1000);
  });

  it('combina búsqueda, localidad, capabilities y contexto', () => {
    const models = [
      model(1, { name: 'coder-pro', providerId: 'openai', locality: 'cloud', contextMax: 32768 }),
      model(2, { name: 'coder-local', contextMax: 4096 }),
    ];
    const result = filterModels(models, {
      ...DEFAULT_MODEL_FILTERS, query: 'coder', locality: 'cloud', providerId: 'openai', minContext: 16000,
    });
    expect(result.map((item) => item.ref.name)).toEqual(['coder-pro']);
  });

  it('ordena costo confirmado por entrada, salida, nombre y proveedor, dejando desconocidos al final', () => {
    const base = { metadataSource: 'openrouter' as const, metadataCheckedAt: 1 };
    const models = [
      { ...model(1, { name: 'same', providerId: 'zeta' }), ...base, pricing: { promptUsdPerToken: 0.000002, completionUsdPerToken: 0.000004 } },
      { ...model(2, { name: 'same', providerId: 'alfa' }), ...base, pricing: { promptUsdPerToken: 0.000002, completionUsdPerToken: 0.000004 } },
      { ...model(3, { name: 'expensive' }), ...base, pricing: { promptUsdPerToken: 0.00001, completionUsdPerToken: 0.00001 } },
      { ...model(4, { name: 'unknown' }), ...base, pricing: { completionUsdPerToken: 0 } },
    ];
    expect(filterModels(models, { ...DEFAULT_MODEL_FILTERS, costOrder: 'low-to-high' }).map((item) => `${item.ref.providerId}:${item.ref.name}`))
      .toEqual(['alfa:same', 'zeta:same', 'ollama:expensive', 'ollama:unknown']);
  });
});
