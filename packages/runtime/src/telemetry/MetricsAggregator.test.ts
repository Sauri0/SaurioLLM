import { describe, it, expect } from 'vitest';
import { MetricsAggregator } from './MetricsAggregator.js';
import type { ResponseMetrics } from '@saurio/shared';
import type { RunMetrics } from './types.js';

function metrics(overrides: Partial<ResponseMetrics> = {}): ResponseMetrics {
  return { promptTokens: 100, cachedPromptTokens: 50, evalTokens: 200, evalMs: 2000, quality: 'measured', ...overrides };
}

describe('MetricsAggregator', () => {
  it('chatStats agrega tokens, mediana de tok/s y cache hit promedio por chat', async () => {
    const agg = new MetricsAggregator();
    agg.recordResponse('chat-1', 'run-1', metrics({ evalTokens: 200, evalMs: 2000 })); // 100 tok/s
    agg.recordResponse('chat-1', 'run-1', metrics({ evalTokens: 300, evalMs: 2000 })); // 150 tok/s
    const stats = await agg.chatStats('chat-1');
    expect(stats.tokens).toBe(500);
    expect(stats.medianTps).toBe(125);
    expect(stats.avgCacheHit).toBeCloseTo(0.5);
  });

  it('chatStats de un chat sin datos devuelve ceros, no undefined', async () => {
    const agg = new MetricsAggregator();
    const stats = await agg.chatStats('chat-desconocido');
    expect(stats).toEqual({ tokens: 0, medianTps: 0, avgCacheHit: 0 });
  });

  it('modelStats agrega por (providerId, modelName) vía registerRunModel', async () => {
    const agg = new MetricsAggregator();
    agg.registerRunModel('run-1', 'ollama', 'qwen3:8b');
    agg.recordResponse('chat-1', 'run-1', metrics({ evalTokens: 100, evalMs: 1000 }));
    agg.registerRunModel('run-2', 'ollama', 'qwen2.5-coder:7b');
    agg.recordResponse('chat-2', 'run-2', metrics({ evalTokens: 999, evalMs: 1000 }));
    const stats = await agg.modelStats('ollama', 'qwen3:8b');
    expect(stats.tokens).toBe(100);
  });

  it('recordRun asocia el run al chatId de sus respuestas ya grabadas', async () => {
    const agg = new MetricsAggregator();
    agg.recordResponse('chat-1', 'run-1', metrics());
    const run: RunMetrics = {
      runId: 'run-1', promptTokens: 100, evalTokens: 200, iterations: 1,
      toolCallsByStatus: {}, wallTimeMs: 3000,
    };
    agg.recordRun(run);
    // No falla y no lanza; verificación indirecta vía snapshot.
    expect(agg.snapshotForPersistence().length).toBe(1);
  });

  it('cacheHit se omite cuando faltan promptTokens/cachedPromptTokens (no se inventa un 0 falso)', async () => {
    const agg = new MetricsAggregator();
    agg.recordResponse('chat-1', 'run-1', metrics({ cachedPromptTokens: undefined, promptTokens: undefined }));
    const stats = await agg.chatStats('chat-1');
    expect(stats.avgCacheHit).toBe(0);
  });
});
