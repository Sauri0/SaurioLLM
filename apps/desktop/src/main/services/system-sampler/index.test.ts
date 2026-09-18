// Tests de SystemSampler (doc 01 §4.17) con os.cpus/execFile inyectados: deterministas, sin
// depender de la CPU/GPU real de la máquina que corre vitest.
import { describe, expect, it, vi } from 'vitest';
import type os from 'node:os';
import { SystemSampler, sampleCpuPct, sampleNvidiaSmi } from './index.js';

function cpuInfo(user: number, sys: number, idle: number): os.CpuInfo {
  return { model: 'fake', speed: 1000, times: { user, nice: 0, sys, idle, irq: 0 } };
}

describe('sampleCpuPct', () => {
  it('calcula el % de uso a partir de dos snapshots de os.cpus()', async () => {
    let call = 0;
    const cpus = vi.fn(() =>
      call++ === 0
        ? [cpuInfo(0, 0, 0)]
        : [cpuInfo(50, 0, 50)], // 50 user, 50 idle -> 50%
    );
    const pct = await sampleCpuPct(1, cpus);
    expect(pct).toBeCloseTo(50, 5);
  });

  it('devuelve 0 si no hay delta (sin actividad de medición)', async () => {
    const cpus = vi.fn(() => [cpuInfo(0, 0, 0)]);
    const pct = await sampleCpuPct(1, cpus);
    expect(pct).toBe(0);
  });
});

describe('sampleNvidiaSmi', () => {
  it('parsea la salida CSV de nvidia-smi', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '15, 5904, 61, 132.50\n', stderr: '' });
    const gpu = await sampleNvidiaSmi(exec as never);
    expect(gpu).toEqual({ utilPct: 15, vramUsedBytes: 5904 * 1024 * 1024, tempC: 61, powerW: 132.5 });
  });

  it('devuelve null si nvidia-smi no está disponible (execFile tira)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const gpu = await sampleNvidiaSmi(exec as never);
    expect(gpu).toBeNull();
  });

  it('devuelve null si la salida no tiene el formato esperado', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'no soportado\n', stderr: '' });
    const gpu = await sampleNvidiaSmi(exec as never);
    expect(gpu).toBeNull();
  });
});

describe('SystemSampler', () => {
  it('sample() etiqueta cpu/ram/appRss como measured, sin GPU si nvidia-smi falla', async () => {
    const sampler = new SystemSampler({
      cpus: () => [cpuInfo(0, 0, 100)],
      totalmem: () => 16_000_000_000,
      freemem: () => 8_000_000_000,
      execNvidiaSmi: vi.fn().mockRejectedValue(new Error('no gpu')) as never,
      appRssBytes: () => 123,
    });

    const sample = await sampler.sample();

    expect(sample.cpuPct.quality).toBe('measured');
    expect(sample.ramUsedBytes.value).toBe(8_000_000_000);
    expect(sample.appRssBytes.value).toBe(123);
    expect(sample.gpuUtilPct).toBeUndefined();
    expect(sampler.supportsGpuSampling()).toBe(false);
  });

  it('sample() incluye datos de GPU measured cuando nvidia-smi responde', async () => {
    const sampler = new SystemSampler({
      cpus: () => [cpuInfo(0, 0, 100)],
      totalmem: () => 16_000_000_000,
      freemem: () => 8_000_000_000,
      execNvidiaSmi: vi.fn().mockResolvedValue({ stdout: '20, 4096, 55, 100\n', stderr: '' }) as never,
      appRssBytes: () => 123,
    });

    const sample = await sampler.sample();

    expect(sample.gpuUtilPct?.value).toBe(20);
    expect(sample.gpuUtilPct?.quality).toBe('measured');
    expect(sample.vramUsedBytes?.value).toBe(4096 * 1024 * 1024);
    expect(sampler.supportsGpuSampling()).toBe(true);
  });
});
