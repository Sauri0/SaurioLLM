// Test de modelPolicy.resolveModelRef — packages/runtime/src/agent/modelPolicy.test.ts.
// Doc 19 §1.5/§5: 'fixed' es el comportamiento previo sin cambios; 'auto' es la heurística mínima
// (HIPÓTESIS A PROBAR) — preferir el modelo ya cargado si "entra", si no caer al modelo del agente.
import { describe, expect, it } from 'vitest';
import { resolveModelRef, resolveModelSelection } from './modelPolicy.js';
import { DEFAULT_MODEL_REF } from './defaults.js';
import type { ModelRef } from '@saurio/shared';

const agentModel: ModelRef = { providerId: 'ollama', name: 'qwen2.5-coder:7b', locality: 'local' };
const loadedModel: ModelRef = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' };

describe('resolveModelRef', () => {
  it('expone procedencia real para override, perfil fijo y fallback builtin sin duplicar la selección', async () => {
    const chatModel: ModelRef = { providerId: 'ollama', name: 'chat:7b', locality: 'local' };
    await expect(resolveModelSelection({ modelMode: 'auto', model: agentModel }, chatModel))
      .resolves.toEqual({ ref: chatModel, resolution: { source: 'chat_override' } });
    await expect(resolveModelSelection({ modelMode: 'fixed', model: agentModel }, undefined))
      .resolves.toEqual({ ref: agentModel, resolution: { source: 'agent_fixed' } });
    await expect(resolveModelSelection({ modelMode: 'fixed' }, undefined))
      .resolves.toEqual({ ref: DEFAULT_MODEL_REF, resolution: { source: 'builtin_fallback' } });
  });

  it('marca el fit automático como estimado y conserva contexto y origen', async () => {
    const recommended = await resolveModelSelection({ modelMode: 'auto', model: agentModel }, undefined, {
      listRecommendedRefs: () => [{ ref: loadedModel, contextMax: 32768 }],
      fits: () => ({ fitClass: 'tight' }),
    });
    expect(recommended.resolution).toEqual({
      source: 'automatic_recommendation', contextMax: 32768, fitClass: 'tight', fitQuality: 'estimated',
    });

    const loaded = await resolveModelSelection({ modelMode: 'auto', model: agentModel }, undefined, {
      listLoadedRefs: () => [loadedModel], contextMaxForRef: () => 40960,
      fits: () => ({ fitClass: 'fits_gpu' }),
    });
    expect(loaded.resolution).toEqual({
      source: 'automatic_loaded', contextMax: 40960, fitClass: 'fits_gpu', fitQuality: 'estimated',
    });

    const profile = await resolveModelSelection({ modelMode: 'auto', model: agentModel }, undefined, {
      contextMaxForRef: () => 16384, fits: () => ({ fitClass: 'partial_offload' }),
    });
    expect(profile.resolution).toEqual({
      source: 'automatic_profile', contextMax: 16384, fitClass: 'partial_offload', fitQuality: 'estimated',
    });
  });

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
      numCtx: 40960,
    });
    expect(ref).toEqual(loadedModel);
  });

  it('modelMode auto: si ningún candidato entra, devuelve un error accionable', async () => {
    await expect(resolveModelRef({ modelMode: 'auto', model: agentModel }, undefined, {
      listLoadedRefs: () => [loadedModel],
      fits: () => ({ fitClass: 'no_fit' }),
      numCtx: 40960,
    })).rejects.toThrow(/modelo local más chico|elegí uno explícitamente/);
  });

  it('modelMode auto: sin verificación no inventa el modelo del agente ni el builtin', async () => {
    await expect(resolveModelRef({ modelMode: 'auto', model: agentModel }, undefined))
      .rejects.toThrow(/máximo contexto confirmado/);
  });

  it('modelMode auto: si listLoadedRefs lanza y no puede verificar otro candidato, informa el bloqueo', async () => {
    await expect(resolveModelRef({ modelMode: 'auto', model: agentModel }, undefined, {
      listLoadedRefs: () => { throw new Error('ECONNREFUSED'); },
    })).rejects.toThrow(/modelo local/);
  });

  it('modelMode auto: nunca selecciona un modelo remoto implícitamente', async () => {
    const remote: ModelRef = { providerId: 'openai', name: 'cloud', locality: 'cloud' };
    await expect(resolveModelRef({ modelMode: 'auto', model: remote }, undefined, {
      listLoadedRefs: () => [remote],
      fits: () => ({ fitClass: 'fits_gpu' }),
      numCtx: 40960,
    })).rejects.toThrow(/modelo local/);
  });

  it('no elige un modelo cargado si desconoce su máximo real', async () => {
    await expect(resolveModelRef({ modelMode: 'auto', model: agentModel }, undefined, {
      listLoadedRefs: () => [loadedModel],
      fits: () => ({ fitClass: 'fits_gpu' }),
    })).rejects.toThrow(/máximo contexto confirmado/);
  });

  it('modelMode auto: usa el primer recomendado local que entra a su contexto máximo', async () => {
    const tooLarge: ModelRef = { providerId: 'ollama', name: 'big:latest', locality: 'local' };
    const recommended: ModelRef = { providerId: 'ollama', name: 'coder:7b', locality: 'local' };
    const checked: { name: string; numCtx: number }[] = [];
    const ref = await resolveModelRef({ modelMode: 'auto', role: 'coder', model: agentModel }, undefined, {
      listRecommendedRefs: () => [
        { ref: tooLarge, contextMax: 131072 },
        { ref: recommended, contextMax: 32768 },
      ],
      fits: (candidate, numCtx) => {
        checked.push({ name: candidate.name, numCtx });
        return { fitClass: candidate.name === tooLarge.name ? 'no_fit' : 'fits_gpu' };
      },
    });
    expect(ref).toEqual(recommended);
    expect(checked).toEqual([{ name: 'big:latest', numCtx: 131072 }, { name: 'coder:7b', numCtx: 32768 }]);
  });

  it('continúa con el siguiente recomendado si falla la estimación de uno', async () => {
    const broken: ModelRef = { providerId: 'ollama', name: 'broken', locality: 'local' };
    const good: ModelRef = { providerId: 'ollama', name: 'good', locality: 'local' };
    const ref = await resolveModelRef({ modelMode: 'auto', role: 'reviewer' }, undefined, {
      listRecommendedRefs: () => [{ ref: broken, contextMax: 40960 }, { ref: good, contextMax: 32768 }],
      fits: (candidate) => {
        if (candidate.name === 'broken') throw new Error('describe falló');
        return { fitClass: 'tight' };
      },
    });
    expect(ref).toEqual(good);
  });

  it('acepta offload a RAM/CPU como ejecución local viable', async () => {
    const cpuCandidate: ModelRef = { providerId: 'ollama', name: 'cpu-fit:8b', locality: 'local' };
    const ref = await resolveModelRef({ modelMode: 'auto', role: 'coder' }, undefined, {
      listRecommendedRefs: () => [{ ref: cpuCandidate, contextMax: 40960 }],
      fits: () => ({ fitClass: 'partial_offload' }),
    });
    expect(ref).toEqual(cpuCandidate);
  });

  it('usa el modelo local del perfil sólo si verifica su máximo confirmado', async () => {
    const checked: number[] = [];
    const ref = await resolveModelRef({ modelMode: 'auto', model: agentModel }, undefined, {
      contextMaxForRef: () => 40960,
      fits: (_candidate, numCtx) => { checked.push(numCtx); return { fitClass: 'partial_offload' }; },
    });
    expect(ref).toEqual(agentModel);
    expect(checked).toEqual([40960]);
  });
});
