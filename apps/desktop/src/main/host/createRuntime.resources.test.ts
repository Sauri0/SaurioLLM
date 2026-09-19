import { describe, expect, it } from 'vitest';
import {
  measuredFitClass, parseLocalInferenceOptions, providerCatalogStorageKey, testedSpeedFromCompat,
  withProviderDeadline,
} from './createRuntime.js';
import type { ModelCompatRecord } from '@saurio/runtime/persistence/index';

describe('parseLocalInferenceOptions', () => {
  it('propaga hilos positivos y cpu fuerza numGpu 0', () => {
    expect(parseLocalInferenceOptions({ preset: 'balanced', computeMode: 'cpu', numThreads: 6 }))
      .toEqual({ numThreads: 6, numGpu: 0 });
  });

  it('auto omite numGpu y descarta hilos inválidos', () => {
    expect(parseLocalInferenceOptions({ computeMode: 'auto', numThreads: 8 })).toEqual({ numThreads: 8, numGpu: undefined });
    expect(parseLocalInferenceOptions({ computeMode: 'auto', numThreads: 0 })).toBeUndefined();
    expect(parseLocalInferenceOptions({ computeMode: 'auto', numThreads: 3.5 })).toBeUndefined();
  });
});

describe('evidencia de modelos', () => {
  const provider = {
    id: 'cloud-a', kind: 'openai-compat' as const, baseUrl: 'http://127.0.0.1:1234', isLoopback: true,
    enabled: true, mode: 'attach' as const, preset: 'custom' as const, label: 'Local',
  };
  const compat = (patch: Partial<ModelCompatRecord> = {}): ModelCompatRecord => ({
    id: 'compat-1', providerId: 'ollama', modelName: 'qwen3:8b', modelDigest: 'digest-a',
    hardwareFingerprint: 'hw-a', numCtx: 8192, kvCacheType: null, think: null,
    ollamaVersion: null, driverVersion: null, size: 5_000, sizeVram: 4_900, offloadRatio: 1,
    loadMs: 800, promptTps: 100, genTps: 50, ttftMs: 100, peakVramMib: 5000, peakRamMib: 1000,
    qualityScore: null, status: 'fits', error: null, testedAt: 123,
    ...patch,
  });

  it('invalida la caché de catálogo al cambiar configuración o credencial sin guardar la clave', () => {
    const first = providerCatalogStorageKey(provider, 'secret-one');
    expect(providerCatalogStorageKey(provider, 'secret-two')).not.toBe(first);
    expect(providerCatalogStorageKey({ ...provider, baseUrl: 'http://127.0.0.1:5678' }, 'secret-one')).not.toBe(first);
    expect(first).not.toContain('secret-one');
  });

  it('usa compatibilidad medida para fit, pero sólo muestra tested con throughput exitoso', () => {
    expect(measuredFitClass(compat())).toBe('fits_gpu');
    expect(measuredFitClass(compat({ status: 'partial', offloadRatio: 0.6 }))).toBe('partial_offload');
    expect(measuredFitClass(compat({ status: 'fits', offloadRatio: null, size: null, sizeVram: null }))).toBeUndefined();
    expect(measuredFitClass(compat({ status: 'failed', error: 'invalid api key' }))).toBeUndefined();
    expect(measuredFitClass(compat({ status: 'failed', error: 'CUDA out of memory' }))).toBe('no_fit');
    expect(testedSpeedFromCompat(compat())).toEqual({ tokPerSec: 50, testedAt: 123 });
    expect(testedSpeedFromCompat(compat({ genTps: null }))).toBeUndefined();
    expect(testedSpeedFromCompat(compat({ status: 'failed' }))).toBeUndefined();
  });

  it('corta y aborta una consulta de proveedor colgada', async () => {
    let signal: AbortSignal | undefined;
    await expect(withProviderDeadline('Proveedor de prueba', (received) => {
      signal = received;
      return new Promise<never>(() => undefined);
    }, 5)).rejects.toThrow('tardó demasiado');
    expect(signal?.aborted).toBe(true);
  });
});
