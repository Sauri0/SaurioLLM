import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@saurio/shared';
import { contextModelPage } from './contextModelList.js';

function model(index: number): ModelInfo {
  return {
    ref: { providerId: index % 2 === 0 ? 'ollama' : 'openrouter', name: `modelo-${index}`, locality: index % 2 === 0 ? 'local' : 'cloud' },
    digest: '', sizeBytes: 0, family: '', parameterSize: '', quantization: '',
    capabilities: { tools: false, thinking: false, vision: false, embedding: false },
  };
}

describe('contextModelPage', () => {
  it('filtra por modelo o proveedor y no renderiza más de 20 filas', () => {
    const models = Array.from({ length: 45 }, (_, index) => model(index));
    expect(contextModelPage(models, '', 1)).toMatchObject({ total: 45, pageCount: 3, page: 1 });
    expect(contextModelPage(models, '', 1).items).toHaveLength(20);
    expect(contextModelPage(models, 'openrouter', 1)).toMatchObject({ total: 22, pageCount: 2 });
  });

  it('acota una página que dejó de existir después de buscar', () => {
    const models = Array.from({ length: 45 }, (_, index) => model(index));
    const result = contextModelPage(models, 'modelo-1', 3);
    expect(result.page).toBe(1);
    expect(result.items.map((item) => item.ref.name)).toEqual(['modelo-1', 'modelo-10', 'modelo-11', 'modelo-12', 'modelo-13', 'modelo-14', 'modelo-15', 'modelo-16', 'modelo-17', 'modelo-18', 'modelo-19']);
  });
});
