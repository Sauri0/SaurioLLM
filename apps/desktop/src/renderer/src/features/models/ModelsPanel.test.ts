import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@saurio/shared';
import { visibleInstalledModels } from './ModelsPanel.js';

function model(name: string, providerId = 'ollama'): ModelInfo {
  return {
    ref: { providerId, name, locality: 'local' }, digest: name, sizeBytes: 1,
    family: 'test', parameterSize: '8B', quantization: 'Q4',
    capabilities: { tools: false, thinking: false, vision: false, embedding: false },
  };
}

describe('ModelsPanel: visibilidad', () => {
  it('oculta por identidad compuesta y conserva el modelo en uso hasta que se lo restaure', () => {
    const ollama = model('same', 'ollama');
    const otherProvider = model('same', 'openrouter');
    const hidden = new Set(['ollama::same']);

    expect(visibleInstalledModels([ollama, otherProvider], hidden, false, 'ollama::same')).toEqual([ollama, otherProvider]);
    expect(visibleInstalledModels([ollama, otherProvider], hidden, false)).toEqual([otherProvider]);
    expect(visibleInstalledModels([ollama, otherProvider], hidden, true)).toEqual([ollama, otherProvider]);
  });
});
