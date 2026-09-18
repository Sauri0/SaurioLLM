// Tests de ModelManager con providers y CommandRunner mockeados (sin Ollama real, doc de reglas).
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelManager, type ModelProvider, type ModelLoadSamplesRepository, type ModelLoadSample } from './ModelManager.js';
import { HardwareProbe } from './HardwareProbe.js';
import type { ModelInfo, ModelDescription, LoadedModel } from '@saurio/shared';
import type { CommandRunner } from './CommandRunner.js';

const modelInfoFixture: ModelInfo = {
  ref: { providerId: 'ollama', name: 'qwen2.5-coder:7b', locality: 'local' },
  digest: 'sha256:deadbeef',
  sizeBytes: 4.7 * 1024 * 1024 * 1024,
  family: 'qwen2',
  parameterSize: '7B',
  quantization: 'Q4_K_M',
  capabilities: { tools: true, thinking: false, vision: false, embedding: false },
  contextMax: 32768,
};

const descriptionFixture: ModelDescription = {
  ...modelInfoFixture,
  modelInfo: {
    'general.architecture': 'qwen2',
    'qwen2.block_count': 28,
    'qwen2.attention.head_count': 28,
    'qwen2.attention.head_count_kv': 4,
    'qwen2.attention.key_length': 128,
    'qwen2.embedding_length': 3584,
  },
};

function fakeProvider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: 'ollama',
    locality: 'local',
    health: vi.fn().mockResolvedValue({ ok: true, version: '0.34.1' }),
    listModels: vi.fn().mockResolvedValue([modelInfoFixture]),
    describeModel: vi.fn().mockResolvedValue(descriptionFixture),
    listLoaded: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const noopRunner: CommandRunner = vi.fn().mockRejectedValue(new Error('no gpu in tests'));

describe('ModelManager', () => {
  it('listInstalled agrega el catálogo de todos los providers y cachea salvo refresh', async () => {
    const provider = fakeProvider();
    const probe = new HardwareProbe({ runner: noopRunner });
    const manager = new ModelManager([provider], probe);
    const first = await manager.listInstalled();
    const second = await manager.listInstalled();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(provider.listModels).toHaveBeenCalledTimes(1);
    await manager.listInstalled(true);
    expect(provider.listModels).toHaveBeenCalledTimes(2);
  });

  it('listLoaded delega en cada provider y emite models:loaded', async () => {
    const loaded: LoadedModel[] = [{ name: 'qwen2.5-coder:7b', digest: 'sha256:deadbeef', size: 5000, sizeVram: 5000, contextLength: 8192, expiresAt: '2026-01-01T00:00:00Z' }];
    const provider = fakeProvider({ listLoaded: vi.fn().mockResolvedValue(loaded) });
    const probe = new HardwareProbe({ runner: noopRunner });
    const manager = new ModelManager([provider], probe);
    const events: unknown[] = [];
    manager.on('models:loaded', (payload) => events.push(payload));
    const result = await manager.listLoaded();
    expect(result).toEqual(loaded);
    expect(events).toEqual([{ providerId: 'ollama', loaded }]);
  });

  it('describeModel cachea por ModelRef', async () => {
    const provider = fakeProvider();
    const probe = new HardwareProbe({ runner: noopRunner });
    const manager = new ModelManager([provider], probe);
    const ref = modelInfoFixture.ref;
    await manager.describeModel(ref);
    await manager.describeModel(ref);
    expect(provider.describeModel).toHaveBeenCalledTimes(1);
  });

  it('fits delega en MemoryEstimator con el hardware sampleado', async () => {
    const provider = fakeProvider();
    const runner: CommandRunner = vi.fn().mockResolvedValue({ stdout: 'RTX 3060 Ti, 8192, 900, 30, 45, 20, uuid\n', stderr: '' });
    const probe = new HardwareProbe({ runner });
    const manager = new ModelManager([provider], probe);
    const estimate = await manager.fits(modelInfoFixture.ref, 8192);
    expect(estimate.quality).toBe('estimated');
    expect(['fits_gpu', 'tight', 'partial_offload', 'no_fit']).toContain(estimate.fitClass);
  });

  it('recordLoadSample escribe en el repositorio inyectado', async () => {
    const provider = fakeProvider();
    const probe = new HardwareProbe({ runner: noopRunner });
    const repo: ModelLoadSamplesRepository = { insert: vi.fn().mockResolvedValue(undefined), recent: vi.fn().mockResolvedValue([]) };
    const manager = new ModelManager([provider], probe, { modelLoadSamplesRepository: repo });
    const sample: ModelLoadSample = {
      id: 's1', providerId: 'ollama', modelName: 'qwen2.5-coder:7b', modelDigest: 'sha256:deadbeef',
      numCtx: 8192, size: 5_000_000_000, sizeVram: 5_000_000_000, contextLength: 8192, loadMs: 1200,
      estimatedVram: null, sampledAt: 1,
    };
    await manager.recordLoadSample(sample);
    expect(repo.insert).toHaveBeenCalledWith(sample);
  });

  it('calibra el overhead con la EMA de model_load_samples recientes', async () => {
    const provider = fakeProvider();
    const runner: CommandRunner = vi.fn().mockResolvedValue({ stdout: 'RTX 3060 Ti, 8192, 900, 30, 45, 20, uuid\n', stderr: '' });
    const probe = new HardwareProbe({ runner });
    const samples: ModelLoadSample[] = [
      { id: '1', providerId: 'ollama', modelName: 'qwen2.5-coder:7b', modelDigest: 'd', numCtx: 8192, size: 5_000_000_000, sizeVram: 5_000_000_000, contextLength: 8192, loadMs: 900, estimatedVram: 4_500_000_000, sampledAt: 2 },
    ];
    const repo: ModelLoadSamplesRepository = { insert: vi.fn(), recent: vi.fn().mockResolvedValue(samples) };
    const manager = new ModelManager([provider], probe, { modelLoadSamplesRepository: repo });
    const estimate = await manager.fits(modelInfoFixture.ref, 8192);
    expect(repo.recent).toHaveBeenCalledWith('ollama', 'qwen2.5-coder:7b', expect.any(Number));
    expect(estimate.quality).toBe('estimated');
  });

  it('detectedModelsFolder usa el default cuando ninguna variable de entorno responde', async () => {
    const provider = fakeProvider();
    const probe = new HardwareProbe({ runner: noopRunner });
    const envRunner: CommandRunner = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const manager = new ModelManager([provider], probe, { runner: envRunner, platformOverride: 'win32' });
    const detected = await manager.detectedModelsFolder();
    expect(detected.source).toBe('default');
    expect(typeof detected.path).toBe('string');
  });

  it('detectedModelsFolder valida true si encuentra el manifest esperado', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'saurio-models-'));
    const manifestDir = join(tmp, 'manifests', 'registry.ollama.ai', 'library', 'qwen2.5-coder', '7b');
    mkdirSync(manifestDir, { recursive: true });
    try {
      const provider = fakeProvider();
      const probe = new HardwareProbe({ runner: noopRunner });
      const envRunner: CommandRunner = vi.fn().mockResolvedValue({ stdout: tmp, stderr: '' });
      const manager = new ModelManager([provider], probe, { runner: envRunner, platformOverride: 'win32' });
      const detected = await manager.detectedModelsFolder();
      expect(detected.source).toBe('env:user');
      expect(detected.validated).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('attachWarnings avisa contexto 256K y exposición de red sin tocar configuración', () => {
    const provider = fakeProvider();
    const probe = new HardwareProbe({ runner: noopRunner });
    const manager = new ModelManager([provider], probe);
    const warnings = manager.attachWarnings({ baseUrl: 'http://127.0.0.1:11434', observedContextLength: 262144, ollamaHostEnv: 'http://0.0.0.0:11434' });
    expect(warnings.map((w) => w.code).sort()).toEqual(['context_256k_default', 'network_exposed']);
  });

  it('attachWarnings no avisa nada cuando todo es local y sin señales de exposición', () => {
    const provider = fakeProvider();
    const probe = new HardwareProbe({ runner: noopRunner });
    const manager = new ModelManager([provider], probe);
    const warnings = manager.attachWarnings({ baseUrl: 'http://127.0.0.1:11434' });
    expect(warnings).toEqual([]);
  });
});
