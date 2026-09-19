import { describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderConfig } from '@saurio/shared';
import { eligibleManualProviders, manualDefinitionModels, manualModelName } from './ManualModelForm.js';

function provider(id: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id, preset: 'openai', kind: 'cloud', label: id, baseUrl: 'https://example.test', enabled: true,
    locality: 'cloud', hasApiKey: true, removable: true, ...overrides,
  };
}

describe('ManualModelForm', () => {
  it('sólo ofrece proveedores API habilitados y nunca Ollama', () => {
    const enabled = provider('openai');
    const disabled = provider('disabled', { enabled: false });
    const ollama = provider('ollama', { kind: 'ollama', locality: 'local' });

    expect(eligibleManualProviders([enabled, disabled, ollama])).toEqual([enabled]);
  });

  it('conserva el ID exacto salvo espacios externos y rechaza entradas inválidas', () => {
    expect(manualModelName('  org/model:latest  ')).toBe('org/model:latest');
    expect(manualModelName('')).toBeUndefined();
    expect(manualModelName('modelo\notro')).toBeUndefined();
    expect(manualModelName(`modelo\0otro`)).toBeUndefined();
    expect(manualModelName('x'.repeat(201))).toBeUndefined();
  });

  it('permite retirar una definición manual aunque el catálogo remoto conserve sus metadatos', () => {
    const remote: ModelInfo = {
      ref: { providerId: 'openai', name: 'gpt-catalogado', locality: 'cloud' }, digest: 'remoto', sizeBytes: 0,
      family: 'remote', parameterSize: '', quantization: '', contextMax: 128_000,
      capabilities: { tools: true, thinking: false, vision: true, embedding: false }, metadataSource: 'openrouter',
      manualDefinition: true,
    };

    expect(manualDefinitionModels([remote])).toEqual([remote]);
    expect(remote.metadataSource).toBe('openrouter');
    expect(remote.contextMax).toBe(128_000);
  });
});
