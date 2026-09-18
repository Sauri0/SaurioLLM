import { describe, it, expect } from 'vitest';
import { Diagnostics } from './Diagnostics.js';
import type { MetricsSnapshot, ProviderHealth } from '@saurio/shared';

function snapshot(loaded: MetricsSnapshot['loaded']): MetricsSnapshot {
  return {
    slots: [],
    queue: [],
    loaded,
    system: {
      cpuPct: { value: 10, quality: 'measured', source: 'os', sampledAt: 1 },
      ramUsedBytes: { value: 1, quality: 'measured', source: 'os', sampledAt: 1 },
      appRssBytes: { value: 1, quality: 'measured', source: 'app.getAppMetrics', sampledAt: 1 },
    },
    diagnostics: [],
  };
}

describe('Diagnostics', () => {
  it('detecta offload cuando size_vram < size (medido)', () => {
    const diagnostics = new Diagnostics();
    const result = diagnostics.evaluate(
      snapshot([{ name: 'gemma4:26b', digest: 'd', size: 19_000_000_000, sizeVram: 1_300_000_000, contextLength: 8192, expiresAt: '2026-01-01T00:00:00Z' }]),
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe('offload');
  });

  it('no reporta nada si size_vram === size (100% GPU)', () => {
    const diagnostics = new Diagnostics();
    const result = diagnostics.evaluate(
      snapshot([{ name: 'qwen3:8b', digest: 'd', size: 5_000_000_000, sizeVram: 5_000_000_000, contextLength: 8192, expiresAt: '2026-01-01T00:00:00Z' }]),
      [],
    );
    expect(result).toHaveLength(0);
  });

  it('evaluateProviderHealth reporta provider_down cuando ok=false', () => {
    const diagnostics = new Diagnostics();
    const health: ProviderHealth[] = [{ providerId: 'ollama', ok: false, error: 'ECONNREFUSED' }];
    const result = diagnostics.evaluateProviderHealth(health);
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe('provider_down');
  });

  it('evaluateProviderHealth no reporta nada cuando ok=true', () => {
    const diagnostics = new Diagnostics();
    const result = diagnostics.evaluateProviderHealth([{ providerId: 'ollama', ok: true, version: '0.34.1' }]);
    expect(result).toHaveLength(0);
  });

  it('evaluateContextMismatch detecta cuando el servidor asignó otro contexto', () => {
    const diagnostics = new Diagnostics();
    const loaded: MetricsSnapshot['loaded'] = [{ name: 'qwen3:8b', digest: 'd', size: 1, sizeVram: 1, contextLength: 262144, expiresAt: '2026-01-01T00:00:00Z' }];
    const result = diagnostics.evaluateContextMismatch({ modelName: 'qwen3:8b', numCtx: 8192 }, loaded);
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe('context_mismatch');
  });

  it('evaluateLowVram reporta low_vram cuando libre < 500 MiB (doc 14 §7 punto 3)', () => {
    const diagnostics = new Diagnostics();
    const system = snapshot([]).system;
    system.vramUsedBytes = { value: 7.9 * 1024 * 1024 * 1024, quality: 'measured', source: 'nvidia_smi', sampledAt: 1 };
    const result = diagnostics.evaluateLowVram(system, 8 * 1024 * 1024 * 1024);
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe('low_vram');
  });

  it('evaluateLowVram no reporta nada con VRAM libre de sobra', () => {
    const diagnostics = new Diagnostics();
    const system = snapshot([]).system;
    system.vramUsedBytes = { value: 1 * 1024 * 1024 * 1024, quality: 'measured', source: 'nvidia_smi', sampledAt: 1 };
    const result = diagnostics.evaluateLowVram(system, 8 * 1024 * 1024 * 1024);
    expect(result).toHaveLength(0);
  });

  it('evaluateQueueBacklog reporta cola larga con 3+ jobs para el mismo modelo (doc 14 §7 punto 6)', () => {
    const diagnostics = new Diagnostics();
    const now = 1_000_000;
    const queue = [0, 1, 2].map((i) => ({
      runId: `r${i}`, ref: { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' as const },
      priority: 'interactive' as const, enqueuedAt: now - 1000,
    }));
    const result = diagnostics.evaluateQueueBacklog(queue, now);
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe('queue_backlog');
  });

  it('evaluateQueueBacklog no reporta nada con 1 job esperando poco tiempo', () => {
    const diagnostics = new Diagnostics();
    const now = 1_000_000;
    const queue = [{ runId: 'r0', ref: { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' as const }, priority: 'interactive' as const, enqueuedAt: now - 1000 }];
    const result = diagnostics.evaluateQueueBacklog(queue, now);
    expect(result).toHaveLength(0);
  });
});
