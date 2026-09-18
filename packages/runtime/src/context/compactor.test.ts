// Tests de Compactor con mensajes sintéticos (doc de la tarea: "compactación en un solo paso")
// — packages/runtime/src/context/compactor.test.ts.
import { describe, expect, it } from 'vitest';
import type { CompactionSummary, Summarizer } from './summarizer.js';
import { createTokenEstimator } from './token-estimator.js';
import { createCompactor, truncateOnIngestion } from './compactor.js';
import { computeBudget } from './budgets.js';
import { makeAgentConfig, makeChatMessage, makeContextPolicy, makeSyntheticHistory } from './test-fixtures.js';

const FIXED_SUMMARY: CompactionSummary = {
  objetivo: 'implementar el módulo de contexto',
  archivos_tocados: ['packages/runtime/src/context/context-builder.ts'],
  decisiones: ['compactar niveles 1 y 2 en un solo paso'],
  descubrimientos: ['el historial sintético usa 3 mensajes por turno'],
  pendientes: [],
  ultimo_error: null,
};

function makeFakeSummarizer(): Summarizer {
  return { summarize: async () => FIXED_SUMMARY };
}

function makeFailingSummarizer(): Summarizer {
  return {
    summarize: async () => {
      throw new Error('format rescatado agotó reintentos (doc 07 §7.3)');
    },
  };
}

describe('context/Compactor', () => {
  it('dispara por ratio de historial y por cantidad de turnos', () => {
    const agent = makeAgentConfig();
    const tokenCounter = createTokenEstimator(agent.model);
    const compactor = createCompactor(tokenCounter, makeFakeSummarizer());
    const budget = computeBudget(agent.contextPolicy);

    expect(compactor.shouldCompact(budget.perBlock.history + 1, budget, 0, agent.contextPolicy)).toBe(true);
    expect(compactor.shouldCompact(0, budget, agent.contextPolicy.compactEveryTurns, agent.contextPolicy)).toBe(true);
    expect(compactor.shouldCompact(1, budget, 1, agent.contextPolicy)).toBe(false);
  });

  it('compacta niveles 1 y 2 en un solo paso: stubs de tool results + resumen en posición fija', async () => {
    const agent = makeAgentConfig({ contextPolicy: makeContextPolicy({ keepLastTurns: 2 }) });
    const tokenCounter = createTokenEstimator(agent.model);
    const compactor = createCompactor(tokenCounter, makeFakeSummarizer());
    const history = makeSyntheticHistory(10); // 30 mensajes: bastante para dejar candidatos a compactar

    const result = await compactor.compact(history, agent.contextPolicy, agent.model);

    expect(result.level).toBe(2);
    expect(result.summaryMessage).toBeDefined();
    expect(result.summaryMessage?.content).toContain('implementar el módulo de contexto');
    // Los candidatos compactados son todo menos los últimos `keepLastTurns` mensajes.
    expect(result.replacedMessageIds.length).toBe(history.length - agent.contextPolicy.keepLastTurns);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it('degrada a nivel 1 puro (Plan B) cuando el resumen falla repetidamente', async () => {
    const agent = makeAgentConfig({ contextPolicy: makeContextPolicy({ keepLastTurns: 2 }) });
    const tokenCounter = createTokenEstimator(agent.model);
    const compactor = createCompactor(tokenCounter, makeFailingSummarizer());
    const history = makeSyntheticHistory(6);

    const result = await compactor.compact(history, agent.contextPolicy, agent.model);

    expect(result.level).toBe(1);
    expect(result.summaryMessage).toBeUndefined();
    expect(result.replacedMessageIds.length).toBeGreaterThan(0);
  });

  it('truncateOnIngestion recorta contenido que excede el límite (nivel 0 defensivo)', () => {
    const big = makeChatMessage({ id: 'huge', content: 'x'.repeat(50_000) });
    const truncated = truncateOnIngestion(big, 1_000);
    expect(truncated.content.length).toBeLessThan(2_000);
    expect(truncated.content).toContain('recortado en ingestión');

    const small = makeChatMessage({ id: 'small', content: 'hola' });
    expect(truncateOnIngestion(small, 1_000)).toEqual(small);
  });
});
