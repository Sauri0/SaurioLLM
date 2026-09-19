// Test de los handlers models:libraryCatalog/hfSearch/hfFiles/resolveByName/pullExternal (doc 16
// §12.6, puntos 1-5 del encargo) — apps/desktop/src/main/ipc/models.test.ts. `electron` se mockea
// (vitest corre fuera de Electron); `RuntimeHost` se reemplaza por un objeto falso mínimo, mismo
// patrón que providers.test.ts — así el test no depende de red real ni de Ollama real (eso ya lo
// prueban OllamaLibraryClient.test.ts/HuggingFaceClient.test.ts/DownloadManager.test.ts por separado).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HardwareProfile } from '@saurio/runtime/models/index';
import type { OllamaLibrarySnapshot } from '@saurio/runtime/models/index';

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const fakeFrame = {} as never;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

const { allowFrame } = await import('./registerHandler.js');
const { registerModelsHandlers } = await import('./models.js');
type RuntimeHost = import('../host/RuntimeHost.js').RuntimeHost;

const GIB = 1024 * 1024 * 1024;

function fakeHardware(vramTotalGiB: number, vramUsedGiB: number, ramFreeGiB: number): HardwareProfile {
  return {
    cpu: { name: { value: 'CPU', quality: 'measured', source: 'test', sampledAt: 1 }, threads: { value: 8, quality: 'measured', source: 'test', sampledAt: 1 } },
    ram: {
      totalBytes: { value: 32 * GIB, quality: 'measured', source: 'test', sampledAt: 1 },
      freeBytes: { value: ramFreeGiB * GIB, quality: 'measured', source: 'test', sampledAt: 1 },
    },
    gpu: {
      vendor: 'nvidia',
      vramTotalBytes: { value: vramTotalGiB * GIB, quality: 'measured', source: 'test', sampledAt: 1 },
      vramUsedBytes: { value: vramUsedGiB * GIB, quality: 'measured', source: 'test', sampledAt: 1 },
    },
    fingerprint: 'fp-test', sampledAt: 1,
  };
}

const SNAPSHOT: OllamaLibrarySnapshot = {
  generatedAt: '2026-09-18T00:00:00.000Z',
  source: 'https://ollama.com/library',
  familyCount: 1,
  variantCount: 1,
  families: [{
    name: 'qwen3', capabilityHints: ['tools'], sizeHints: ['8b'],
    variants: [{ tag: '8b', sizeBytes: 5_225_388_164, contextMax: 40960, vision: false }],
  }],
};

function makeFakeHost(overrides: Record<string, unknown> = {}) {
  const host = {
    modelManager: {
      listInstalled: vi.fn(async () => []),
      listLoaded: vi.fn(async () => []),
      detectedModelsFolder: vi.fn(async () => ({ path: '/models', source: 'default', validated: true, freeBytes: 100 * GIB, spaceQuality: 'measured' })),
    },
    hardwareProbe: { sample: vi.fn(async () => fakeHardware(8, 1, 24)), refreshGpu: vi.fn() },
    downloadManager: {
      isDownloading: vi.fn(() => false),
      downloadIdFor: vi.fn(() => undefined),
      pullKnownSize: vi.fn(async (ref: string, sizeBytes: number) => ({ downloadId: `dl-${ref}-${sizeBytes}` })),
    },
    modelCatalog: [],
    ollamaLibraryClient: {
      getCatalog: vi.fn(async () => ({ snapshot: SNAPSHOT, source: 'network' as const, cachedAt: 1000 })),
    },
    huggingFaceClient: {
      searchModels: vi.fn(async () => [{ id: 'bartowski/x-GGUF', likes: 1, downloads: 2, tags: ['gguf'] }]),
      listGgufFiles: vi.fn(async () => [{ filename: 'x-Q4_K_M.gguf', sizeBytes: 4 * GIB, quant: 'Q4_K_M' }]),
    },
    ...overrides,
  };
  return host;
}

async function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handle = handlers.get(channel);
  if (!handle) throw new Error(`canal no registrado: ${channel}`);
  return handle({ senderFrame: fakeFrame }, payload);
}

describe('ipc/models — cobertura máxima del catálogo (doc 16 §12.6)', () => {
  beforeEach(() => {
    handlers.clear();
    allowFrame(fakeFrame);
  });

  it('hardware:profile aplana el perfil medido y refresh invalida solamente la caché de GPU', async () => {
    const hardware = fakeHardware(8, 1, 24);
    hardware.gpu = { ...hardware.gpu!, integrated: false };
    const host = makeFakeHost({ hardwareProbe: { sample: vi.fn(async () => hardware), refreshGpu: vi.fn() } });
    registerModelsHandlers(host as unknown as RuntimeHost);

    const result = await invoke('hardware:profile', { refresh: true }) as {
      cpu: { name: string; threads: number }; gpu?: { vramTotalBytes: number; integrated?: boolean; quality: string; source: string };
    };
    expect(host.hardwareProbe.refreshGpu).toHaveBeenCalledOnce();
    expect(host.hardwareProbe.sample).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      cpu: { name: 'CPU', threads: 8 },
      gpu: { vramTotalBytes: 8 * GIB, integrated: false, quality: 'measured', source: 'test' },
    });
  });

  it('models:libraryCatalog fusiona el snapshot con el catálogo curado y expone la fuente', async () => {
    const host = makeFakeHost();
    registerModelsHandlers(host as unknown as RuntimeHost);

    const result = await invoke('models:libraryCatalog', {}) as { items: unknown[]; source: string; familyCount: number; variantCount: number };
    expect(result.source).toBe('network');
    expect(result.familyCount).toBe(1);
    expect(result.variantCount).toBe(1);
    expect(result.items).toHaveLength(1);
  });

  it('models:libraryCatalog propaga forceRefresh a OllamaLibraryClient.getCatalog', async () => {
    const host = makeFakeHost();
    registerModelsHandlers(host as unknown as RuntimeHost);
    await invoke('models:libraryCatalog', { forceRefresh: true });
    expect(host.ollamaLibraryClient.getCatalog).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('el catálogo evalúa memoria al máximo anunciado, sin reducir una ventana grande a 8K', async () => {
    const snapshot = structuredClone(SNAPSHOT);
    snapshot.families[0]!.variants[0]!.contextMax = 262_144;
    const host = makeFakeHost({ ollamaLibraryClient: {
      getCatalog: vi.fn(async () => ({ snapshot, source: 'network' as const, cachedAt: 1000 })),
    } });
    registerModelsHandlers(host as unknown as RuntimeHost);
    const result = await invoke('models:libraryCatalog', {}) as { items: { tier?: { level: number } }[] };
    // Pesos de 5 GB con KV de 262K no entran cómodamente en esta GPU de 8 GB.
    expect(result.items[0]?.tier?.level).toBeGreaterThan(2);
  });

  it('models:hfSearch delega en HuggingFaceClient.searchModels', async () => {
    const host = makeFakeHost();
    registerModelsHandlers(host as unknown as RuntimeHost);
    const result = await invoke('models:hfSearch', { query: 'qwen' });
    expect(host.huggingFaceClient.searchModels).toHaveBeenCalledWith('qwen');
    expect(result).toEqual([{ id: 'bartowski/x-GGUF', likes: 1, downloads: 2, tags: ['gguf'] }]);
  });

  it('models:hfFiles delega en HuggingFaceClient.listGgufFiles', async () => {
    const host = makeFakeHost();
    registerModelsHandlers(host as unknown as RuntimeHost);
    await invoke('models:hfFiles', { modelId: 'bartowski/x-GGUF' });
    expect(host.huggingFaceClient.listGgufFiles).toHaveBeenCalledWith('bartowski/x-GGUF');
  });

  describe('models:resolveByName', () => {
    it('rechaza un nombre vacío', async () => {
      const host = makeFakeHost();
      registerModelsHandlers(host as unknown as RuntimeHost);
      await expect(invoke('models:resolveByName', { name: '  ' })).rejects.toThrow(/nombre/);
    });

    it('un nombre hf.co/<repo>:<quant> resuelve vía HuggingFaceClient (source: huggingface)', async () => {
      const host = makeFakeHost();
      registerModelsHandlers(host as unknown as RuntimeHost);
      const result = await invoke('models:resolveByName', { name: 'hf.co/bartowski/x-GGUF:Q4_K_M' }) as { source: string; sizeBytes: number; fullName: string; tier?: unknown };
      expect(result.source).toBe('huggingface');
      expect(result.sizeBytes).toBe(4 * GIB);
      expect(result.tier).toBeUndefined(); // Sin metadatos de contexto, no prometer compatibilidad.
      expect(host.huggingFaceClient.listGgufFiles).toHaveBeenCalledWith('bartowski/x-GGUF');
    });

    it('una cuantización inexistente en el repo de HF rechaza con mensaje claro', async () => {
      const host = makeFakeHost();
      registerModelsHandlers(host as unknown as RuntimeHost);
      await expect(invoke('models:resolveByName', { name: 'hf.co/bartowski/x-GGUF:Q9_ZZZ' }))
        .rejects.toThrow(/no se encontró/);
    });

    it('un nombre sin hf.co/ resuelve contra el registry de Ollama (source: ollama)', async () => {
      const host = makeFakeHost();
      registerModelsHandlers(host as unknown as RuntimeHost);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
        schemaVersion: 2,
        layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:a', size: 1000 }],
      }), { status: 200 })) as unknown as typeof fetch;
      try {
        const result = await invoke('models:resolveByName', { name: 'all-minilm:latest' }) as { source: string; sizeBytes: number };
        expect(result.source).toBe('ollama');
        expect(result.sizeBytes).toBe(1000);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('sin dato de espacio medido, spaceOk es true (nunca bloquea sin poder confirmar)', async () => {
      const host = makeFakeHost({
        modelManager: {
          listInstalled: vi.fn(async () => []),
          listLoaded: vi.fn(async () => []),
          detectedModelsFolder: vi.fn(async () => ({ path: '/models', source: 'default', validated: false, spaceQuality: 'unavailable' })),
        },
      });
      registerModelsHandlers(host as unknown as RuntimeHost);
      const result = await invoke('models:resolveByName', { name: 'hf.co/bartowski/x-GGUF:Q4_K_M' }) as { spaceOk: boolean; freeBytes?: number };
      expect(result.spaceOk).toBe(true);
      expect(result.freeBytes).toBeUndefined();
    });
  });

  it('models:tierForSize recalcula el nivel para un tamaño ya conocido con el numCtx elegido', async () => {
    const host = makeFakeHost();
    registerModelsHandlers(host as unknown as RuntimeHost);
    const tier = await invoke('models:tierForSize', { sizeBytes: 5 * GIB, numCtx: 32768 }) as { level: number; quality: string };
    expect(host.hardwareProbe.sample).toHaveBeenCalled();
    expect(tier.quality).toBe('estimated');
    expect(typeof tier.level).toBe('number');
  });

  it('models:list pasa refresco individual y expone estado fechado del catálogo', async () => {
    const host = makeFakeHost();
    const statuses = [{ providerId: 'api', state: 'stale', count: 6, updatedAt: 100, error: 'offline' }];
    Object.assign(host.modelManager, { catalogStatus: () => statuses });
    registerModelsHandlers(host as unknown as RuntimeHost);
    await invoke('models:list', { refresh: true, providerId: 'api' });
    expect(host.modelManager.listInstalled).toHaveBeenCalledWith(true, 'api');
    expect(await invoke('models:catalogStatus', undefined)).toEqual(statuses);
  });

  it('ID manual valida proveedor API habilitado sin llamar inferencia', async () => {
    const update = vi.fn(async () => {});
    const host = makeFakeHost({ providers: [{ id: 'api', kind: 'cloud' }, { id: 'ollama', kind: 'ollama' }] });
    Object.assign(host.modelManager, { updateManualModel: update });
    registerModelsHandlers(host as unknown as RuntimeHost);
    await invoke('models:updateManual', { providerId: 'api', name: 'org/model' });
    expect(update).toHaveBeenCalledWith('api', 'org/model', undefined);
    await expect(invoke('models:updateManual', { providerId: 'ollama', name: 'model' })).rejects.toThrow('API habilitado');
    await expect(invoke('models:updateManual', { providerId: 'missing', name: 'model' })).rejects.toThrow('API habilitado');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('biblioteca conserva snapshot cuando el inventario local falla, sin fingir no instalado', async () => {
    const host = makeFakeHost();
    host.modelManager.listInstalled.mockRejectedValue(new Error('Ollama offline'));
    registerModelsHandlers(host as unknown as RuntimeHost);
    const result = await invoke('models:libraryCatalog', {}) as { items: Array<{ status: string }> };
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.status).toBe('unknown');
  });

  it('un catálogo cloud disponible no confirma el inventario Ollama caído', async () => {
    const host = makeFakeHost();
    Object.assign(host.modelManager, { catalogStatus: () => [
      { providerId: 'ollama', state: 'error', count: 0 },
      { providerId: 'api', state: 'ready', count: 0 },
    ] });
    registerModelsHandlers(host as unknown as RuntimeHost);
    const result = await invoke('models:libraryCatalog', {}) as { items: Array<{ status: string }> };
    expect(result.items[0]?.status).toBe('unknown');
  });

  it('models:pullExternal delega en DownloadManager.pullKnownSize', async () => {
    const host = makeFakeHost();
    registerModelsHandlers(host as unknown as RuntimeHost);
    const result = await invoke('models:pullExternal', { ref: 'hf.co/bartowski/x-GGUF:Q4_K_M', sizeBytes: 4 * GIB }) as { downloadId: string };
    expect(host.downloadManager.pullKnownSize).toHaveBeenCalledWith('hf.co/bartowski/x-GGUF:Q4_K_M', 4 * GIB);
    expect(result.downloadId).toBeTruthy();
  });

  it('models:downloads rehidrata un fallo persistido con modelo, tamaño y motivo', async () => {
    const host = makeFakeHost({
      downloadManager: {
        isDownloading: vi.fn(() => false), downloadIdFor: vi.fn(() => undefined),
        pullKnownSize: vi.fn(), listAll: vi.fn(() => []),
      },
      downloadsRepository: { listActiveOrRecent: vi.fn(async () => [{
        id: 'hf-failed', providerId: 'ollama', modelName: 'hf.co/Qwen/repo:q8_0',
        status: 'failed', total: 1_894_532_160, completed: 0, startedAt: 10, finishedAt: 11,
        error: 'blocked redirect to a different host',
      }]) },
    });
    registerModelsHandlers(host as unknown as RuntimeHost);

    await expect(invoke('models:downloads', undefined)).resolves.toEqual([
      expect.objectContaining({
        id: 'hf-failed', modelName: 'hf.co/Qwen/repo:q8_0', status: 'failed',
        totalBytes: 1_894_532_160, error: 'blocked redirect to a different host',
      }),
    ]);
  });
});
