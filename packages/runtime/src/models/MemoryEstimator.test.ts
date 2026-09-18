// Tests de MemoryEstimator con fixtures de ModelDescription (sin Ollama real).
import { describe, it, expect } from 'vitest';
import { MemoryEstimator, type ModelDescriber, type OverheadCalibrator } from './MemoryEstimator.js';
import type { ModelRef, ModelDescription } from '@saurio/shared';
import type { HardwareProfile } from './types.js';

const GIB = 1024 * 1024 * 1024;

function hardware(vramTotalGiB: number, vramUsedGiB = 0): HardwareProfile {
  return {
    cpu: { name: { value: 'CPU', quality: 'measured', source: 'os.cpus', sampledAt: 1 }, threads: { value: 8, quality: 'measured', source: 'os.cpus', sampledAt: 1 } },
    ram: {
      totalBytes: { value: 32 * GIB, quality: 'measured', source: 'os.totalmem', sampledAt: 1 },
      freeBytes: { value: 16 * GIB, quality: 'measured', source: 'os.freemem', sampledAt: 1 },
    },
    gpu: {
      vendor: 'nvidia',
      vramTotalBytes: { value: vramTotalGiB * GIB, quality: 'measured', source: 'nvidia-smi', sampledAt: 1 },
      vramUsedBytes: { value: vramUsedGiB * GIB, quality: 'measured', source: 'nvidia-smi', sampledAt: 1 },
    },
    fingerprint: 'fp-test',
    sampledAt: 1,
  };
}

const ref: ModelRef = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' };

function denseDescription(sizeBytes: number): ModelDescription {
  return {
    ref,
    digest: 'sha256:abc',
    sizeBytes,
    family: 'qwen3',
    parameterSize: '8B',
    quantization: 'Q4_K_M',
    capabilities: { tools: true, thinking: true, vision: false, embedding: false },
    contextMax: 32768,
    modelInfo: {
      'general.architecture': 'qwen3',
      'qwen3.block_count': 32,
      'qwen3.attention.head_count': 32,
      'qwen3.attention.head_count_kv': 8,
      'qwen3.attention.key_length': 128,
      'qwen3.embedding_length': 4096,
    },
  };
}

function hybridDescription(sizeBytes: number): ModelDescription {
  return {
    ...denseDescription(sizeBytes),
    modelInfo: {
      'general.architecture': 'gemma4',
      'gemma4.block_count': 32,
      'gemma4.attention.head_count': 16,
      'gemma4.attention.head_count_kv': 8,
      'gemma4.attention.key_length': 128,
      'gemma4.embedding_length': 4096,
      'gemma4.attention.sliding_window': 4096,
    },
  };
}

describe('MemoryEstimator', () => {
  it('quality es SIEMPRE estimated (nunca measured)', async () => {
    const describer: ModelDescriber = { describeModel: async () => denseDescription(5 * GIB) };
    const estimator = new MemoryEstimator(describer);
    const estimate = await estimator.fits(ref, 8192, hardware(8));
    expect(estimate.quality).toBe('estimated');
    expect(estimate.source).toBe('formula');
  });

  it('fits_gpu cuando vramNeeded <= vramAvailable', async () => {
    const describer: ModelDescriber = { describeModel: async () => denseDescription(1 * GIB) };
    const estimator = new MemoryEstimator(describer);
    const estimate = await estimator.fits(ref, 2048, hardware(24));
    expect(estimate.fitClass).toBe('fits_gpu');
  });

  it('no_fit cuando los pesos solos ya superan la VRAM disponible', async () => {
    const describer: ModelDescriber = { describeModel: async () => denseDescription(20 * GIB) };
    const estimator = new MemoryEstimator(describer);
    const estimate = await estimator.fits(ref, 8192, hardware(8));
    expect(estimate.fitClass).toBe('no_fit');
  });

  it('partial_offload cuando los pesos entran pero pesos+KV+overhead no', async () => {
    const describer: ModelDescriber = { describeModel: async () => denseDescription(6.5 * GIB) };
    const estimator = new MemoryEstimator(describer);
    const estimate = await estimator.fits(ref, 32768, hardware(8));
    expect(estimate.fitClass).toBe('partial_offload');
  });

  it('sube linealmente con numCtx (más contexto = más KV)', async () => {
    const describer: ModelDescriber = { describeModel: async () => denseDescription(4 * GIB) };
    const estimator = new MemoryEstimator(describer);
    const small = await estimator.fits(ref, 4096, hardware(24));
    const large = await estimator.fits(ref, 16384, hardware(24));
    expect(large.vramNeededBytes).toBeGreaterThan(small.vramNeededBytes);
  });

  it('arquitecturas con sliding_window no sobreestiman el KV (regresión del bug de ~40-60x)', async () => {
    const describer: ModelDescriber = { describeModel: async () => hybridDescription(19 * GIB) };
    const estimator = new MemoryEstimator(describer);
    const estimate = await estimator.fits(ref, 8192, hardware(24));
    // Cota superior generosa: si el bug reapareciera, vramNeededBytes explotaría muy por encima
    // de pesos + un puñado de GiB de KV/overhead.
    expect(estimate.vramNeededBytes).toBeLessThan(19 * GIB + 8 * GIB);
  });

  it('usa el overhead calibrado del OverheadCalibrator cuando existe', async () => {
    const describer: ModelDescriber = { describeModel: async () => denseDescription(1 * GIB) };
    const calibrator: OverheadCalibrator = { getCalibratedOverheadBytes: async () => 3 * GIB };
    const withDefault = await new MemoryEstimator(describer).fits(ref, 2048, hardware(24));
    const withCalibration = await new MemoryEstimator(describer, calibrator).fits(ref, 2048, hardware(24));
    expect(withCalibration.vramNeededBytes).toBeGreaterThan(withDefault.vramNeededBytes);
  });

  it('sin GPU (vramTotal 0): vramAvailable es 0 y modelos con peso > 0 son no_fit', async () => {
    const describer: ModelDescriber = { describeModel: async () => denseDescription(1 * GIB) };
    const estimator = new MemoryEstimator(describer);
    const cpuOnly: HardwareProfile = { ...hardware(0), gpu: undefined };
    const estimate = await estimator.fits(ref, 2048, cpuOnly);
    expect(estimate.vramAvailableBytes).toBe(0);
    expect(estimate.fitClass).toBe('no_fit');
  });
});
