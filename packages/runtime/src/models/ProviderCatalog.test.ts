import { describe, expect, it, vi } from 'vitest';
import { ProviderCatalog } from './ProviderCatalog.js';
import type { ModelInfo } from '@saurio/shared';

const model: ModelInfo = {
  ref: { providerId: 'api', name: 'model', locality: 'cloud' }, digest: '', sizeBytes: 0,
  family: '', parameterSize: '', quantization: '',
  capabilities: { tools: true, thinking: false, vision: false, embedding: false },
};

describe('ProviderCatalog', () => {
  it('guarda IDs manuales concurrentes sin inferir capacidades, precio ni contexto', async () => {
    const saved = new Map<string, unknown>();
    const storage = { get: async (key: string) => saved.get(key), set: async (key: string, value: unknown) => { saved.set(key, value); } };
    const catalog = new ProviderCatalog({ storage });
    await Promise.all([
      catalog.updateManual({ providerId: 'api', name: 'org/one', locality: 'cloud' }),
      catalog.updateManual({ providerId: 'api', name: 'org/two', locality: 'cloud' }),
    ]);
    const restored = await new ProviderCatalog({ storage }).manualModels('api', 'cloud');
    expect(restored.map((entry) => entry.ref.name)).toEqual(['org/one', 'org/two']);
    expect(restored[0]).toMatchObject({ metadataSource: 'manual', capabilities: { tools: false } });
    expect(restored[0]?.contextMax).toBeUndefined();
    expect(restored[0]?.pricing).toBeUndefined();
    await catalog.updateManual({ providerId: 'api', name: 'org/one', locality: 'cloud' }, true);
    expect((await catalog.manualModels('api', 'cloud')).map((entry) => entry.ref.name)).toEqual(['org/two']);
    expect(await catalog.manualModels('other', 'cloud')).toEqual([]);
  });

  it('rechaza ID inválido y falla explícitamente si no puede persistir el manual', async () => {
    const catalog = new ProviderCatalog({ storage: { get: async () => [], set: async () => { throw new Error('disk'); } } });
    await expect(catalog.updateManual({ providerId: 'api', name: 'bad\nname', locality: 'cloud' })).rejects.toThrow('válido');
    await expect(catalog.updateManual({ providerId: 'api', name: 'valid', locality: 'cloud' })).rejects.toThrow('disk');
    expect(await catalog.manualModels('api', 'cloud')).toEqual([]);
  });

  it('no traslada IDs manuales a otra configuración del mismo proveedor', async () => {
    const saved = new Map<string, unknown>();
    const storage = { get: async (key: string) => saved.get(key), set: async (key: string, value: unknown) => { saved.set(key, value); } };
    let configuration = 'account-a';
    const catalog = new ProviderCatalog({ storage, storageKey: () => configuration });
    const first = catalog.updateManual({ providerId: 'api', name: 'private-a', locality: 'cloud' });
    configuration = 'account-b';
    await first;
    expect(await catalog.manualModels('api', 'cloud')).toEqual([]);
    configuration = 'account-a';
    expect((await catalog.manualModels('api', 'cloud'))[0]?.ref.name).toBe('private-a');
  });

  it('lectura cache-only conserva fecha vencida sin consultar red', async () => {
    const catalog = new ProviderCatalog({ now: () => 400_000, storage: {
      get: async () => ({ models: [model], updatedAt: 1 }), set: async () => {},
    } });
    expect(await catalog.cachedOnly('api')).toEqual([model]);
    expect(catalog.status('api')).toMatchObject({ state: 'stale', updatedAt: 1 });
  });

  it('deduplica consultas y conserva catálogo fechado ante fallo de actualización', async () => {
    let resolve!: (value: ModelInfo[]) => void;
    const provider = { id: 'api', listModels: vi.fn(() => new Promise<ModelInfo[]>((r) => { resolve = r; })) };
    const catalog = new ProviderCatalog({ now: () => 100 });
    const first = catalog.read(provider);
    const second = catalog.read(provider);
    await Promise.resolve();
    resolve([model]);
    expect(await first).toEqual([model]);
    expect(await second).toEqual([model]);
    expect(provider.listModels).toHaveBeenCalledTimes(1);
    provider.listModels.mockRejectedValue(new Error('offline'));
    expect(await catalog.read(provider, true)).toEqual([model]);
    expect(catalog.status('api')).toEqual({ providerId: 'api', state: 'stale', updatedAt: 100, count: 1, error: 'offline' });
    await catalog.read(provider);
    expect(catalog.status('api').state).toBe('stale');
  });

  it('corta proveedor colgado y permite otros catálogos', async () => {
    const catalog = new ProviderCatalog({ timeoutMs: 5 });
    let signal: AbortSignal | undefined;
    const stuck = catalog.read({ id: 'stuck', listModels: (s) => { signal = s; return new Promise(() => {}); } });
    const ready = catalog.read({ id: 'api', listModels: async () => [model] });
    const result = await Promise.allSettled([stuck, ready]);
    expect(result[0]?.status).toBe('rejected');
    expect(result[1]).toEqual({ status: 'fulfilled', value: [model] });
    expect(signal?.aborted).toBe(true);
    expect(catalog.status('stuck').state).toBe('error');
  });

  it('recupera caché persistida, refresca vencida y separa identidades de configuración', async () => {
    const stored = new Map<string, unknown>();
    const storage = { get: async (key: string) => stored.get(key), set: async (key: string, value: unknown) => { stored.set(key, value); } };
    const provider = { id: 'api', listModels: vi.fn(async () => [model]) };
    await new ProviderCatalog({ storage, now: () => 100, storageKey: () => 'config-a' }).read(provider);
    await new ProviderCatalog({ storage, now: () => 101, storageKey: () => 'config-a' }).read(provider);
    expect(provider.listModels).toHaveBeenCalledTimes(1);
    await new ProviderCatalog({ storage, now: () => 102, storageKey: () => 'config-b' }).read(provider);
    expect(provider.listModels).toHaveBeenCalledTimes(2);
    await new ProviderCatalog({ storage, now: () => 400_000, storageKey: () => 'config-a' }).read(provider);
    expect(provider.listModels).toHaveBeenCalledTimes(3);
  });

  it('descarta respuesta antigua después de cambiar proveedores', async () => {
    let resolve!: (value: ModelInfo[]) => void;
    const catalog = new ProviderCatalog();
    const old = catalog.read({ id: 'api', listModels: () => new Promise((r) => { resolve = r; }) });
    await Promise.resolve();
    catalog.reset();
    resolve([model]);
    expect(await old).toEqual([]);
    expect(catalog.status('api').state).toBe('unknown');
  });

  it('rechaza caché de otro proveedor y conserva lectura cuando falla persistencia', async () => {
    const catalog = new ProviderCatalog({ storage: {
      get: async () => ({ models: [model], updatedAt: Date.now() }),
      set: async () => { throw new Error('disk'); },
    } });
    const provider = { id: 'other', listModels: vi.fn(async () => []) };
    expect(await catalog.read(provider)).toEqual([]);
    expect(provider.listModels).toHaveBeenCalledTimes(1);
    expect(catalog.status('other')).toMatchObject({ state: 'ready', count: 0, error: expect.stringContaining('guardar') });
  });
});
