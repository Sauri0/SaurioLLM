// Tests de DownloadManager con fixtures (sin red/disco real) — packages/runtime/src/models/DownloadManager.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { DownloadManager } from './DownloadManager.js';
import type { DownloadJob } from './types.js';
import type {
  BlobStoreProbe, DiskSpaceProbe, DownloadProvider, DownloadRecord, DownloadsRepositoryPort,
  ManifestFetcher, RegistryManifest,
} from './types.js';

const GIB = 1024 * 1024 * 1024;

function manifest(totalBytes: number): RegistryManifest {
  return { layers: [{ digest: 'sha256:layer1', size: totalBytes }] };
}

function makeDeps(overrides: {
  manifestBytes?: number;
  blobPresent?: boolean;
  freeBytes?: number;
  pullChunks?: { status: string; digest?: string; total?: number; completed?: number }[];
} = {}) {
  const manifestBytes = overrides.manifestBytes ?? 1000;
  const fetchManifest = vi.fn<ManifestFetcher['fetchManifest']>(async () => manifest(manifestBytes));
  const hasBlob = vi.fn<BlobStoreProbe['hasBlob']>(async () => overrides.blobPresent ?? false);
  const freeBytes = vi.fn<DiskSpaceProbe['freeBytes']>(async () => overrides.freeBytes ?? 10 * GIB);

  async function* pullGen(): AsyncIterable<{ status: string; digest?: string; total?: number; completed?: number }> {
    for (const chunk of overrides.pullChunks ?? [
      { status: 'downloading', digest: 'sha256:layer1', total: manifestBytes, completed: Math.floor(manifestBytes / 2) },
      { status: 'downloading', digest: 'sha256:layer1', total: manifestBytes, completed: manifestBytes },
      { status: 'success' },
    ]) {
      yield chunk;
      await Promise.resolve();
    }
  }

  const provider: DownloadProvider = {
    id: 'ollama',
    pull: vi.fn(() => pullGen()),
    delete: vi.fn(async () => undefined),
    unload: vi.fn(async () => undefined),
  };

  return {
    provider,
    manifestFetcher: { fetchManifest },
    blobStore: { hasBlob },
    diskSpace: { freeBytes },
  };
}

describe('DownloadManager.checkSpace', () => {
  it('resta las capas ya presentes en blobs/ del tamaño faltante', async () => {
    const deps = makeDeps({ manifestBytes: 1000, blobPresent: true, freeBytes: 10 * GIB });
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
    });
    const result = await dm.checkSpace('qwen3:8b');
    expect(result.neededBytes).toBe(0); // la única capa ya está presente
    expect(result.ok).toBe(true);
  });

  it('bloquea si libre < faltante + margen de 2 GiB (doc 13 §5 punto 1)', async () => {
    const manifestBytes = 5 * GIB;
    const deps = makeDeps({ manifestBytes, blobPresent: false, freeBytes: 6 * GIB });
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
    });
    const result = await dm.checkSpace('qwen3:8b');
    expect(result.neededBytes).toBe(manifestBytes);
    expect(result.ok).toBe(false); // 6 GiB libres < 5 GiB + 2 GiB de margen
  });
});

describe('DownloadManager.pull', () => {
  it('agrega progreso por capa hasta completar y llama onDone', async () => {
    const deps = makeDeps({ manifestBytes: 1000, blobPresent: false });
    const progressEvents: number[] = [];
    let doneJob: { completedBytes: number; totalBytes: number; status: string } | undefined;
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
      onProgress: (job) => progressEvents.push(job.completedBytes),
      onDone: (job) => { doneJob = job; },
    });

    const { downloadId } = await dm.pull('tiny:latest');
    expect(downloadId).toBeTruthy();
    // el pull corre en una tarea async separada (void this.runPull(job)); esperar un tick.
    await new Promise((r) => setTimeout(r, 10));

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(doneJob?.status).toBe('done');
    expect(doneJob?.completedBytes).toBe(1000);
    expect(doneJob?.totalBytes).toBe(1000);
  });

  it('rechaza sin llamar a provider.pull() si no hay espacio suficiente', async () => {
    const deps = makeDeps({ manifestBytes: 5 * GIB, blobPresent: false, freeBytes: 1 * GIB });
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
    });
    await expect(dm.pull('big:latest')).rejects.toThrow(/espacio insuficiente/);
    expect(deps.provider.pull).not.toHaveBeenCalled();
  });

  it('persiste una fila insufficient_space (punto 2 del encargo, doc 16 §8 punto 1) sin crear el job en `listAll()` como si fuera una descarga activa', async () => {
    const deps = makeDeps({ manifestBytes: 5 * GIB, blobPresent: false, freeBytes: 1 * GIB });
    const saved: DownloadRecord[] = [];
    const repository: DownloadsRepositoryPort = {
      save: vi.fn(async (record: DownloadRecord) => { saved.push(record); }),
      get: vi.fn(async () => undefined),
    };
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
      repository,
    });

    await expect(dm.pull('big:latest')).rejects.toMatchObject({ name: 'InsufficientSpaceError' });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe('insufficient_space');
    expect(saved[0]?.modelName).toBe('big:latest');
    expect(saved[0]?.finishedAt).toBeDefined();

    // También visible de inmediato en `listAll()` (mismo proceso, sin esperar un reinicio) — la
    // pestaña Descargas la muestra sin depender de un evento `download:progress` que nunca llega.
    const jobs = dm.listAll();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('insufficient_space');
    expect(dm.isDownloading('big:latest')).toBe(false); // no bloquea un reintento futuro
  });

  it('cancel() aborta el AbortSignal y el job termina en cancelled', async () => {
    let capturedSignal: AbortSignal | undefined;
    const deps = makeDeps({ manifestBytes: 1000, blobPresent: false });
    async function* neverEndingPull(): AsyncIterable<{ status: string; digest?: string; total?: number; completed?: number }> {
      yield { status: 'downloading', digest: 'sha256:layer1', total: 1000, completed: 1 };
      await new Promise((resolve) => {
        capturedSignal?.addEventListener('abort', () => resolve(undefined));
      });
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    deps.provider.pull = vi.fn((_name: string, signal: AbortSignal) => {
      capturedSignal = signal;
      return neverEndingPull();
    });

    let failedCalled = false;
    const emitted: DownloadJob[] = [];
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
      onFailed: () => { failedCalled = true; },
    });
    dm.on('progress', (job) => emitted.push(job));

    const { downloadId } = await dm.pull('tiny:latest');
    await new Promise((r) => setTimeout(r, 5));
    await dm.cancel(downloadId);
    await new Promise((r) => setTimeout(r, 5));

    expect(dm.getJob(downloadId)?.status).toBe('cancelled');
    expect(emitted.at(-1)).toMatchObject({ id: downloadId, status: 'cancelled' });
    expect(failedCalled).toBe(false); // cancelar no es un error (doc 13 §5.3)
  });
});

describe('DownloadManager.delete', () => {
  it('hace unload previo si el modelo está cargado', async () => {
    const deps = makeDeps();
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
      isLoaded: async () => true,
    });
    await dm.delete('qwen3:8b');
    expect(deps.provider.unload).toHaveBeenCalledWith('qwen3:8b');
    expect(deps.provider.delete).toHaveBeenCalledWith('qwen3:8b');
  });

  it('rechaza con ModelBusyError si el scheduler tiene trabajo encolado (doc 13 §5 punto 6)', async () => {
    const deps = makeDeps();
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
      isBusy: async () => true,
    });
    await expect(dm.delete('qwen3:8b')).rejects.toThrow(/en uso/);
    expect(deps.provider.delete).not.toHaveBeenCalled();
  });
});

describe('DownloadManager.pullKnownSize (hf.co/<user>/<repo>:<quant>, punto 3/4 del encargo)', () => {
  it('conserva y notifica un fallo que ocurre antes del primer chunk de progreso', async () => {
    const deps = makeDeps({ freeBytes: 10 * GIB });
    async function* rejectedBeforeProgress(): AsyncIterable<never> {
      yield* [] as never[];
      throw new Error('blocked redirect to a different host');
    }
    deps.provider.pull = vi.fn(() => rejectedBeforeProgress());
    const saved: DownloadRecord[] = [];
    const repository: DownloadsRepositoryPort = {
      save: vi.fn(async (record) => { saved.push(structuredClone(record)); }),
      get: vi.fn(async () => undefined),
    };
    const progressStatuses: string[] = [];
    const failedJobs: Array<{ status: string; error?: string }> = [];
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
      repository,
      onProgress: (job) => progressStatuses.push(job.status),
      onFailed: (job) => failedJobs.push(job),
    });

    const { downloadId } = await dm.pullKnownSize('hf.co/Qwen/repo:q8_0', 2 * GIB);
    await vi.waitFor(() => expect(dm.getJob(downloadId)?.status).toBe('failed'));

    expect(progressStatuses).toEqual(['running']);
    expect(failedJobs).toEqual([expect.objectContaining({ status: 'failed', error: 'blocked redirect to a different host' })]);
    expect(dm.listAll()).toEqual([expect.objectContaining({ id: downloadId, modelName: 'hf.co/Qwen/repo:q8_0', status: 'failed' })]);
    expect(saved.at(-1)).toMatchObject({ id: downloadId, status: 'failed', error: 'blocked redirect to a different host' });
  });

  it('descarga sin consultar el manifest del registry de Ollama (nombre hf.co no resuelve ahí)', async () => {
    const deps = makeDeps({ freeBytes: 10 * GIB });
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
    });
    const { downloadId } = await dm.pullKnownSize('hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M', 4 * GIB);
    expect(downloadId).toBeTruthy();
    expect(deps.manifestFetcher.fetchManifest).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 10));
    expect(deps.provider.pull).toHaveBeenCalledWith('hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M', expect.anything());
  });

  it('bloquea por espacio insuficiente contra el tamaño conocido + margen de 2 GiB', async () => {
    const deps = makeDeps({ freeBytes: 3 * GIB });
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
    });
    await expect(dm.pullKnownSize('hf.co/user/repo:Q4_K_M', 4 * GIB)).rejects.toThrow(/espacio insuficiente/);
    expect(deps.provider.pull).not.toHaveBeenCalled();
  });

  it('registra insufficient_space en el repositorio igual que pull() (doc 16 §8 punto 1)', async () => {
    const deps = makeDeps({ freeBytes: 1 * GIB });
    const saved: DownloadRecord[] = [];
    const repository: DownloadsRepositoryPort = {
      save: vi.fn(async (record) => { saved.push(record); }),
      get: vi.fn(async () => undefined),
    };
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
      repository,
    });
    await expect(dm.pullKnownSize('hf.co/user/repo:Q4_K_M', 4 * GIB)).rejects.toThrow();
    expect(saved.some((r) => r.status === 'insufficient_space')).toBe(true);
  });

  it('reusa el mismo downloadId si ya está en curso (mismo criterio que pull())', async () => {
    const deps = makeDeps({ freeBytes: 10 * GIB });
    const dm = new DownloadManager(deps.provider, {
      manifestFetcher: deps.manifestFetcher,
      blobStore: deps.blobStore,
      diskSpace: deps.diskSpace,
      modelsFolder: async () => '/models',
    });
    const first = await dm.pullKnownSize('hf.co/user/repo:Q4_K_M', 4 * GIB);
    const second = await dm.pullKnownSize('hf.co/user/repo:Q4_K_M', 4 * GIB);
    expect(second.downloadId).toBe(first.downloadId);
  });
});
