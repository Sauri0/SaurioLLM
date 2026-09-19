import { describe, expect, it } from 'vitest';
import type { AgentProfile, ModelInfo, ModelRef } from '@saurio/shared';
import { modelSelectionForAgent } from './AgentsView.js';

const localRef: ModelRef = { providerId: 'ollama', name: 'qwen-role-fit:8b', locality: 'local' };
const cloudRef: ModelRef = { providerId: 'cloud-one', name: 'legacy-cloud', locality: 'cloud' };
const localModel: ModelInfo = {
  ref: localRef, digest: 'sha', sizeBytes: 1, family: 'qwen', parameterSize: '8B', quantization: 'Q4',
  capabilities: { tools: true, thinking: false, vision: false, embedding: false },
};
const agent = (overrides: Partial<AgentProfile>): AgentProfile => ({
  id: 'agent', name: 'Agente', role: 'custom', ownerKind: 'personal', modelMode: 'auto',
  systemPrompt: '', allowedTools: [], permissionPreset: 'balanced', createdAt: 1, ...overrides,
});

describe('modelSelectionForAgent', () => {
  it('auto permite preparar el chat sin motor y resuelve el modelo sólo al ejecutar', () => {
    expect(modelSelectionForAgent(agent({ model: cloudRef }), [localModel]))
      .toEqual({ modelRef: undefined, modelSelection: 'auto' });
    expect(modelSelectionForAgent(agent({ model: cloudRef }), []))
      .toEqual({ modelRef: undefined, modelSelection: 'auto' });
  });

  it('fixed conserva el modelo explícito, incluida una elección cloud', () => {
    expect(modelSelectionForAgent(agent({ modelMode: 'fixed', model: cloudRef }), []))
      .toEqual({ modelRef: cloudRef, modelSelection: 'explicit' });
  });
});
