// Test de agent/defaults.ts: numCtx por defecto inyectable por modelo (doc 16, "numCtx efectivo") —
// packages/runtime/src/agent/defaults.test.ts.
import { describe, expect, it } from 'vitest';
import {
  createDefaultAgentConfig, contextPolicyForNumCtx, DEFAULT_CONTEXT_POLICY, DEFAULT_MODEL_REF,
} from './defaults.js';
import type { ModelRef } from '@saurio/shared';

describe('agent/defaults — contextPolicyForNumCtx', () => {
  it('con numCtx === base.numCtx, devuelve exactamente la policy base (sin recalcular)', () => {
    const policy = contextPolicyForNumCtx(DEFAULT_CONTEXT_POLICY.numCtx);
    expect(policy).toBe(DEFAULT_CONTEXT_POLICY);
  });

  it('escala reserveForResponse/repoMapTokens hacia arriba para un numCtx de 16k', () => {
    const policy = contextPolicyForNumCtx(16_384);
    expect(policy.numCtx).toBe(16_384);
    expect(policy.reserveForResponse).toBeGreaterThan(DEFAULT_CONTEXT_POLICY.reserveForResponse);
    expect(policy.repoMapTokens).toBeGreaterThan(DEFAULT_CONTEXT_POLICY.repoMapTokens);
  });

  it('escala hacia arriba de nuevo para 32k, más que para 16k', () => {
    const at16k = contextPolicyForNumCtx(16_384);
    const at32k = contextPolicyForNumCtx(32_768);
    expect(at32k.reserveForResponse).toBeGreaterThan(at16k.reserveForResponse);
    expect(at32k.repoMapTokens).toBeGreaterThan(at16k.repoMapTokens);
  });

  it('conserva el resto de los campos de ContextPolicy sin tocar (ratios, límites de exploración)', () => {
    const policy = contextPolicyForNumCtx(16_384);
    expect(policy.compactAtRatio).toBe(DEFAULT_CONTEXT_POLICY.compactAtRatio);
    expect(policy.maxReadLines).toBe(DEFAULT_CONTEXT_POLICY.maxReadLines);
    expect(policy.keepLastTurns).toBe(DEFAULT_CONTEXT_POLICY.keepLastTurns);
  });

  it('nunca deja valores negativos para un numCtx muy chico', () => {
    const policy = contextPolicyForNumCtx(1);
    expect(policy.reserveForResponse).toBeGreaterThanOrEqual(0);
    expect(policy.repoMapTokens).toBeGreaterThanOrEqual(0);
  });
});

describe('agent/defaults — createDefaultAgentConfig con defaultNumCtxFor', () => {
  it('sin defaultNumCtxFor, usa el numCtx literal de siempre (8192, comportamiento previo)', () => {
    const agent = createDefaultAgentConfig('/workspace');
    expect(agent.contextPolicy).toBe(DEFAULT_CONTEXT_POLICY);
    expect(agent.contextPolicy.numCtx).toBe(8192);
  });

  it('con defaultNumCtxFor devolviendo un numCtx por modelo, se aplica y escala la policy', () => {
    const bigModel: ModelRef = { providerId: 'ollama', name: 'un-modelo-grande:70b', locality: 'local' };
    const agent = createDefaultAgentConfig('/workspace', bigModel, (model) => (model.name.includes('70b') ? 32_768 : undefined));
    expect(agent.contextPolicy.numCtx).toBe(32_768);
    expect(agent.contextPolicy.reserveForResponse).toBeGreaterThan(DEFAULT_CONTEXT_POLICY.reserveForResponse);
  });

  it('si defaultNumCtxFor devuelve undefined para ese modelo, cae al default de siempre', () => {
    const agent = createDefaultAgentConfig('/workspace', DEFAULT_MODEL_REF, () => undefined);
    expect(agent.contextPolicy.numCtx).toBe(8192);
  });

  it('el numCtx elegido queda en AgentConfig.contextPolicy.numCtx, listo para que RunController lo copie a EffectiveConfig', () => {
    const model: ModelRef = { providerId: 'ollama', name: 'modelo-16k', locality: 'local' };
    const agent = createDefaultAgentConfig('/workspace', model, () => 16_384);
    // RunController.buildEffectiveConfig hace `numCtx: agent.contextPolicy.numCtx` tal cual — este
    // test fija ese contrato desde el lado de defaults.ts sin duplicar RunController acá.
    expect(agent.contextPolicy.numCtx).toBe(16_384);
  });
});
