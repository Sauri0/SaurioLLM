// Test de modelPolicy.resolveModelRef — packages/runtime/src/agent/modelPolicy.test.ts.
// Doc 19 §1.5/§5: 'fixed' es el comportamiento previo sin cambios; 'auto' es la heurística mínima
// (HIPÓTESIS A PROBAR) — preferir el modelo ya cargado si "entra", si no caer al modelo del agente.
import { describe, expect, it } from 'vitest';
import { resolveModelRef } from './modelPolicy.js';
import { DEFAULT_MODEL_REF } from './defaults.js';
import type { ModelRef } from '@saurio/shared';

const agentModel: ModelRef = { providerId: 'ollama', name: 'qwen2.5-coder:7b', locality: 'local' };
const loadedModel: ModelRef = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' };

describe('resolveModelRef', () => {
  it('modelMode fixed: usa el modelo del chat si está presente', async () => {
    const chatModel: ModelRef = { providerId: 'ollama', name: 'llama3:8b', locality: 'local' };
    const ref = await resolveModelRef({ modelMode: 'fixed', model: agentModel }, chatModel);
    expect(ref).toEqual(chatModel);
  });

  it('modelMode fixed: sin modelo de chat, usa el modelo del agente', async () => {
    const ref = await resolveModelRef({ modelMode: 'fixed', model: agentModel }, undefined);
    expect(ref).toEqual(agentModel);
  });

  it('modelMode fixed: sin agente ni chat, cae al builtin', async () => {
    const ref = await resolveModelRef({ modelMode: 'fixed' }, undefined);
    expect(ref).toEqual(DEFAULT_MODEL_REF);
  });

  it('modelMode auto: respeta el modelo de chat si el usuario ya eligió uno explícito', async () => {
    const chatModel: ModelRef = { providerId: 'ollama', name: 'llama3:8b', locality: 'local' };
    const ref = await resolveModelRef({ modelMode: 'auto', model: agentModel }, chatModel);
    expect(ref).toEqual(chatModel);
  });

  it('modelMode auto: prefiere el modelo ya cargado si cabe en numCtx', async () => {
    const ref = await resolveModelRef({ modelMode: 'auto', model: agentModel }, undefined, {
      listLoadedRefs: () => [loadedModel],
      fits: () => ({ fitClass: 'fits_gpu' }),
    });
    expect(ref).toEqual(loadedModel);
  });

  it('modelMode auto: si el cargado no entra, cae al modelo del agente', async () => {
    const ref = await resolveModelRef({ modelMode: 'auto', model: agentModel }, undefined, {
      listLoadedRefs: () => [loadedModel],
      fits: () => ({ fitClass: 'no_fit' }),
    });
    expect(ref).toEqual(agentModel);
  });

  it('modelMode auto: sin listLoadedRefs, cae directo al modelo del agente', async () => {
    const ref = await resolveModelRef({ modelMode: 'auto', model: agentModel }, undefined);
    expect(ref).toEqual(agentModel);
  });

  it('modelMode auto: si listLoadedRefs lanza (provider caído), no rompe la resolución', async () => {
    const ref = await resolveModelRef({ modelMode: 'auto', model: agentModel }, undefined, {
      listLoadedRefs: () => { throw new Error('ECONNREFUSED'); },
    });
    expect(ref).toEqual(agentModel);
  });
});
