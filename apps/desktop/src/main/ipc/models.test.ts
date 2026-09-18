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
    hardwareProbe: { sample: vi.fn(async () => fakeHardware(8, 1, 24)) },
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
      const result = await invoke('models:resolveByName', { name: 'hf.co/bartowski/x-GGUF:Q4_K_M' }) as { source: string; sizeBytes: number; fullName: string };
      expect(result.source).toBe('huggingface');
      expect(result.sizeBytes).toBe(4 * GIB);
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

  it('models:pullExternal delega en DownloadManager.pullKnownSize', async () => {
    const host = makeFakeHost();
    registerModelsHandlers(host as unknown as RuntimeHost);
    const result = await invoke('models:pullExternal', { ref: 'hf.co/bartowski/x-GGUF:Q4_K_M', sizeBytes: 4 * GIB }) as { downloadId: string };
    expect(host.downloadManager.pullKnownSize).toHaveBeenCalledWith('hf.co/bartowski/x-GGUF:Q4_K_M', 4 * GIB);
    expect(result.downloadId).toBeTruthy();
  });
});
