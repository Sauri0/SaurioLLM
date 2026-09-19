// DownloadManager: pull/delete con progreso real — packages/runtime/src/models/DownloadManager.ts.
// Define: doc 13 §5 (flujo completo de descarga v0.2). Implementa la interfaz `DownloadManager` de
// ./types.ts (contrato, no se modifica) más API adicional (progreso agregado, ETA, cancelación,
// reanudación best-effort). No estima VRAM/tok-s (eso es MemoryEstimator/Benchmark, doc 13 §2) y no
// cambia configuración de Ollama: solo pull/delete vía el `Provider` que el host inyecta.
import { EventEmitter } from 'node:events';
import type {
  DownloadManager as DownloadManagerContract, DownloadJob, DownloadManagerOptions, DownloadProvider,
  DownloadRecord, RegistryManifest,
} from './types.js';

const GIB = 1024 * 1024 * 1024;
const DEFAULT_FREE_SPACE_MARGIN_BYTES = 2 * GIB;
/** Ventana de la media móvil de velocidad (doc 13 §5.2: "el servidor emite progreso cada ~60 ms en
 *  16 partes paralelas, completed avanza a saltos"); demasiado corta hace temblar el ETA. */
const SPEED_SAMPLE_WINDOW = 8;

interface LayerState { digest: string; total: number; completed: number; alreadyPresent: boolean }

interface ActiveJob {
  id: string;
  modelName: string;
  providerId: string;
  controller: AbortController;
  startedAt: number;
  totalBytes: number;
  baselineCompletedBytes: number; // bytes de capas ya presentes al arrancar (doc 13 §3)
  layers: Map<string, LayerState>;
  speedSamples: { t: number; completed: number }[];
  status: DownloadJob['status'];
  phase?: DownloadJob['phase'];
  error?: string;
  /** Todas las capas del manifest que todavía no estaban en `blobs/` al arrancar (doc 13 §5.2); se
   *  usa para "cerrar" a 100% las capas chiquitas (config/template/license) que Ollama escribe sin
   *  emitir una línea `status: 'downloading'` con progreso — de lo contrario `completedBytes` se
   *  queda unos bytes por debajo de `totalBytes` aunque el pull ya haya terminado con éxito. */
  pendingLayers: { digest: string; size: number }[];
}

function defaultId(): string {
  return crypto.randomUUID();
}

function toJob(job: ActiveJob): DownloadJob {
  const layerCompleted = [...job.layers.values()].reduce((sum, l) => sum + l.completed, 0);
  const completedBytes = job.baselineCompletedBytes + layerCompleted;
  const elapsedS = Math.max((Date.now() - (job.speedSamples[0]?.t ?? job.startedAt)) / 1000, 0.001);
  const firstSample = job.speedSamples[0];
  const lastSample = job.speedSamples[job.speedSamples.length - 1];
  const bytesPerSec = firstSample && lastSample && lastSample.t > firstSample.t
    ? Math.max((lastSample.completed - firstSample.completed) / ((lastSample.t - firstSample.t) / 1000), 0)
    : 0;
  const remaining = Math.max(job.totalBytes - completedBytes, 0);
  const etaMs = bytesPerSec > 0 ? Math.round((remaining / bytesPerSec) * 1000) : Number.POSITIVE_INFINITY;
  void elapsedS;
  return {
    id: job.id,
    providerId: job.providerId,
    modelName: job.modelName,
    status: job.status,
    phase: job.phase,
    totalBytes: job.totalBytes,
    completedBytes,
    bytesPerSec,
    etaMs: Number.isFinite(etaMs) ? etaMs : undefined,
    layers: [...job.layers.values()].map((l) => ({ digest: l.digest, total: l.total, completed: l.completed })),
    startedAt: job.startedAt,
    error: job.error,
  };
}

/** Suma de `layers[].size` + `config.size` (también es un blob que se descarga, doc 13 §3 no lo
 *  excluye explícitamente pero el registry lo trata igual que una capa más). */
function manifestTotalBytes(manifest: RegistryManifest): number {
  const layersTotal = manifest.layers.reduce((sum, l) => sum + l.size, 0);
  return layersTotal + (manifest.config?.size ?? 0);
}

function allManifestLayers(manifest: RegistryManifest): { digest: string; size: number }[] {
  const list = manifest.layers.map((l) => ({ digest: l.digest, size: l.size }));
  if (manifest.config) list.push({ digest: manifest.config.digest, size: manifest.config.size });
  return list;
}

// Idioma estándar de TS para tipar los eventos de un `EventEmitter` (doc de Node/@types/node): la
// interfaz se fusiona con la clase de abajo para sobrecargar `on`/`emit` con la forma real de los
// eventos que emite, sin reimplementar `EventEmitter`. La fusión es intencional y segura (no agrega
// miembros nuevos, solo sobrecarga los que la clase ya hereda) — `@typescript-eslint/no-
// unsafe-declaration-merging` no distingue ese caso del genuinamente riesgoso, así que se
// deshabilita puntualmente acá (punto 6 del encargo: sin cambiar comportamiento).
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface DownloadManager {
  on(event: 'progress' | 'done', listener: (job: DownloadJob) => void): this;
  on(event: 'failed', listener: (job: DownloadJob, error: string) => void): this;
  emit(event: 'progress' | 'done', job: DownloadJob): boolean;
  emit(event: 'failed', job: DownloadJob, error: string): boolean;
}

/** Implementación real del contrato `DownloadManager` (doc 13 §5). Guarda una `Map` de descargas
 *  activas por `downloadId` (no por `modelName`: dos tags del mismo modelo podrían, en teoría,
 *  descargarse a la vez, aunque la UI del Centro de modelos en la práctica dispara una por vez).
 *  Extiende `EventEmitter` (mismo patrón que `ModelManager`) ADEMÁS de los callbacks opcionales de
 *  `DownloadManagerOptions`, para que el host pueda suscribirse después de construirlo (p. ej. recién
 *  cuando existe la `BrowserWindow` a la que reenviar `download:progress`) sin forzar el callback en
 *  el constructor. */
// Mismo idioma de EventEmitter tipado que la interfaz de arriba; ver el comentario ahí.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class DownloadManager extends EventEmitter implements DownloadManagerContract {
  private readonly provider: DownloadProvider;
  private readonly opts: DownloadManagerOptions;
  private readonly freeSpaceMarginBytes: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly active = new Map<string, ActiveJob>();
  /** downloadId por modelName, para poder reanudar (doc 13 §5 punto 4) sin crear un id nuevo por
   *  cada reintento dentro de la misma sesión de la app. */
  private readonly downloadIdByModel = new Map<string, string>();

  constructor(provider: DownloadProvider, options: DownloadManagerOptions) {
    super();
    this.provider = provider;
    this.opts = options;
    this.freeSpaceMarginBytes = options.freeSpaceMarginBytes ?? DEFAULT_FREE_SPACE_MARGIN_BYTES;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? defaultId;
  }

  /** Tamaño faltante real: `Σ layers[].size` restando las capas cuyo blob ya existe en
   *  `<modelsFolder>/blobs/` (doc 13 §3), contra el espacio libre de esa unidad menos el margen
   *  (doc 13 §5 punto 1: 2 GiB). No cachea la respuesta negativa (se recalcula en cada llamada). */
  async checkSpace(modelName: string): Promise<{ neededBytes: number; freeBytes: number; ok: boolean }> {
    const modelsFolder = await this.opts.modelsFolder();
    const manifest = await this.opts.manifestFetcher.fetchManifest(modelName);
    const layers = allManifestLayers(manifest);

    let neededBytes = 0;
    for (const layer of layers) {
      const present = await this.opts.blobStore.hasBlob(modelsFolder, layer.digest);
      if (!present) neededBytes += layer.size;
    }
    const freeBytes = (await this.opts.diskSpace.freeBytes(modelsFolder)) ?? 0;
    const ok = freeBytes >= neededBytes + this.freeSpaceMarginBytes;
    return { neededBytes, freeBytes, ok };
  }

  /** `true` si ya hay una descarga en curso (no terminal) para `modelName` — la UI usa esto para
   *  deshabilitar el botón "Descargar" en vez de disparar un segundo pull en paralelo. */
  isDownloading(modelName: string): boolean {
    const id = this.downloadIdByModel.get(modelName);
    if (!id) return false;
    const job = this.active.get(id);
    return job !== undefined && (job.status === 'queued' || job.status === 'running');
  }

  getJob(downloadId: string): DownloadJob | undefined {
    const job = this.active.get(downloadId);
    return job ? toJob(job) : undefined;
  }

  /** `downloadId` de la descarga en curso de `modelName` en esta sesión de la app, si hay una. */
  downloadIdFor(modelName: string): string | undefined {
    return this.downloadIdByModel.get(modelName);
  }

  /** Todos los jobs de esta sesión (en curso y terminados), más recientes primero. La pestaña
   *  "Descargas" del Centro de modelos (doc 13 §10) los muestra; no sobrevive a un reinicio de la
   *  app (eso requeriría leer `downloads` de SQLite, que este módulo no consulta directamente — ver
   *  `SqlDownloadsRepository.listActiveOrRecent` en apps/desktop para el historial persistido). */
  listAll(): DownloadJob[] {
    return [...this.active.values()].map(toJob).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  /** Inicia (o reanuda, doc 13 §5 punto 4: mismo modelName dentro de esta sesión) la descarga.
   *  Lanza `InsufficientSpaceError` si no hay espacio — antes de lanzar, persiste una fila `downloads`
   *  con `status: 'insufficient_space'` (migración 0002 ya amplió el CHECK, doc 16 §8 punto 1 / punto
   *  2 del encargo) para que la pestaña Descargas la muestre en vez de perder el intento en silencio. */
  async pull(modelName: string): Promise<{ downloadId: string }> {
    if (this.isDownloading(modelName)) {
      const id = this.downloadIdByModel.get(modelName);
      if (id) return { downloadId: id };
    }
    if (!this.provider.pull) {
      throw new Error(`el provider "${this.provider.id}" no soporta pull()`);
    }

    const space = await this.checkSpace(modelName);
    if (!space.ok) {
      await this.recordInsufficientSpace(modelName, space);
      const err = new Error(
        `espacio insuficiente para descargar "${modelName}": faltan ` +
        `${Math.ceil((space.neededBytes + this.freeSpaceMarginBytes - space.freeBytes) / GIB)} GB`,
      );
      err.name = 'InsufficientSpaceError';
      throw err;
    }

    const modelsFolder = await this.opts.modelsFolder();
    const manifest = await this.opts.manifestFetcher.fetchManifest(modelName);
    const layers = allManifestLayers(manifest);
    let baselineCompletedBytes = 0;
    const pendingLayers: { digest: string; size: number }[] = [];
    for (const layer of layers) {
      if (await this.opts.blobStore.hasBlob(modelsFolder, layer.digest)) {
        baselineCompletedBytes += layer.size;
      } else {
        pendingLayers.push({ digest: layer.digest, size: layer.size });
      }
    }

    return this.beginJob(modelName, manifestTotalBytes(manifest), baselineCompletedBytes, pendingLayers);
  }

  /** Punto 3/4 del encargo (doc 16 §12.6): descarga de un modelo que NO vive en el registry de Ollama
   *  (`hf.co/<usuario>/<repo>:<quant>` vía `HuggingFaceClient`, o "descargar por nombre" cuando el
   *  nombre no resuelve contra `registry.ollama.ai`) — `checkSpace()`/`pull()` no sirven acá porque
   *  ambos dependen de `ManifestFetcher.fetchManifest()`, que solo entiende el namespace `library` del
   *  registry de Ollama (`RegistryClient.ts`, doc 13 §3 MVP). El propio Ollama sí sabe descargar estas
   *  referencias (`POST /api/pull` las resuelve él mismo contra Hugging Face) — lo único que este
   *  método no puede hacer es descontar capas ya presentes en `blobs/` (no hay manifest previo para
   *  diffear, `[DECISIÓN DE DISEÑO]`: se verifica espacio contra el tamaño total conocido, más
   *  conservador que de más — nunca de menos). El progreso por capa sigue funcionando igual que en
   *  `pull()` (mismo NDJSON de `/api/pull`, `runPull` no distingue el origen del job). */
  async pullKnownSize(modelName: string, knownTotalBytes: number): Promise<{ downloadId: string }> {
    if (this.isDownloading(modelName)) {
      const id = this.downloadIdByModel.get(modelName);
      if (id) return { downloadId: id };
    }
    if (!this.provider.pull) {
      throw new Error(`el provider "${this.provider.id}" no soporta pull()`);
    }

    const modelsFolder = await this.opts.modelsFolder();
    const freeBytes = (await this.opts.diskSpace.freeBytes(modelsFolder)) ?? 0;
    const ok = freeBytes >= knownTotalBytes + this.freeSpaceMarginBytes;
    if (!ok) {
      await this.recordInsufficientSpace(modelName, { neededBytes: knownTotalBytes, freeBytes });
      const err = new Error(
        `espacio insuficiente para descargar "${modelName}": faltan ` +
        `${Math.ceil((knownTotalBytes + this.freeSpaceMarginBytes - freeBytes) / GIB)} GB`,
      );
      err.name = 'InsufficientSpaceError';
      throw err;
    }

    return this.beginJob(modelName, knownTotalBytes, 0, []);
  }

  private async beginJob(
    modelName: string, totalBytes: number, baselineCompletedBytes: number,
    pendingLayers: { digest: string; size: number }[],
  ): Promise<{ downloadId: string }> {
    const downloadId = this.downloadIdByModel.get(modelName) ?? this.idGenerator();
    this.downloadIdByModel.set(modelName, downloadId);

    const job: ActiveJob = {
      id: downloadId,
      modelName,
      providerId: this.provider.id,
      controller: new AbortController(),
      startedAt: this.now(),
      totalBytes,
      baselineCompletedBytes,
      layers: new Map(),
      speedSamples: [],
      status: 'running',
      pendingLayers,
    };
    this.active.set(downloadId, job);
    await this.persist(job);

    // Publicar el alta antes de iniciar el stream. Un pull puede fallar al resolver el manifest
    // remoto, sin emitir ningún chunk (caso real: HF/Xet rechazado por Ollama); sin este snapshot el
    // renderer sólo recibía `failed` para un id que todavía no conocía y la fila desaparecía.
    const startedJob = toJob(job);
    this.opts.onProgress?.(startedJob);
    this.emit('progress', startedJob);

    void this.runPull(job);
    return { downloadId };
  }

  /** Registra el intento rechazado por espacio insuficiente (mismo `downloadId` que reusaría un
   *  reintento posterior de este `modelName` dentro de la sesión, igual que un pull normal) como un
   *  job terminal en `this.active` (para que `listAll()`/`getJob()` lo vean de inmediato) y lo
   *  persiste (para que sobreviva un reinicio vía `models:downloads`, ver `SqlDownloadsRepository`). */
  private async recordInsufficientSpace(
    modelName: string, space: { neededBytes: number; freeBytes: number },
  ): Promise<void> {
    const downloadId = this.downloadIdByModel.get(modelName) ?? this.idGenerator();
    this.downloadIdByModel.set(modelName, downloadId);
    const job: ActiveJob = {
      id: downloadId,
      modelName,
      providerId: this.provider.id,
      controller: new AbortController(),
      startedAt: this.now(),
      totalBytes: space.neededBytes,
      baselineCompletedBytes: 0,
      layers: new Map(),
      speedSamples: [],
      status: 'insufficient_space',
      error: `espacio insuficiente: faltan ${Math.ceil((space.neededBytes + this.freeSpaceMarginBytes - space.freeBytes) / GIB)} GB`,
      pendingLayers: [],
    };
    this.active.set(downloadId, job);
    await this.persist(job, { finished: true });
  }

  private async runPull(job: ActiveJob): Promise<void> {
    try {
      for await (const chunk of this.provider.pull!(job.modelName, job.controller.signal)) {
        job.phase = chunk.status === 'verifying sha256 digest' ? 'verifying'
          : chunk.status === 'uploading blob' || chunk.status === 'creating model' ? 'importing'
            : 'downloading';
        if (chunk.digest !== undefined) {
          const total = chunk.total ?? job.layers.get(chunk.digest)?.total ?? 0;
          const completed = chunk.completed ?? job.layers.get(chunk.digest)?.completed ?? 0;
          job.layers.set(chunk.digest, { digest: chunk.digest, total, completed, alreadyPresent: false });
          job.speedSamples.push({ t: this.now(), completed: this.aggregateCompleted(job) });
          if (job.speedSamples.length > SPEED_SAMPLE_WINDOW) job.speedSamples.shift();
        }
        const snapshot = toJob(job);
        this.opts.onProgress?.(snapshot);
        this.emit('progress', snapshot);
        await this.persist(job);
        if (chunk.status === 'success') break;
      }
      // Cierre a 100% (ver comentario de `pendingLayers`): Ollama no siempre emite una línea de
      // progreso para capas muy chicas (config/template/license) antes de la línea final "success".
      for (const layer of job.pendingLayers) {
        job.layers.set(layer.digest, { digest: layer.digest, total: layer.size, completed: layer.size, alreadyPresent: false });
      }
      job.status = 'done';
      job.error = undefined;
      await this.persist(job, { finished: true });
      const doneJob = toJob(job);
      this.opts.onDone?.(doneJob);
      this.emit('done', doneJob);
    } catch (error) {
      if (job.controller.signal.aborted) {
        job.status = 'cancelled';
        await this.persist(job, { finished: true });
        const cancelledJob = toJob(job);
        this.opts.onProgress?.(cancelledJob);
        this.emit('progress', cancelledJob);
        // Sin evento onFailed: una cancelación pedida por el usuario no es un error (doc 13 §5.3).
        return;
      }
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      await this.persist(job, { finished: true });
      const failedJob = toJob(job);
      this.opts.onFailed?.(failedJob, job.error);
      this.emit('failed', failedJob, job.error);
    }
  }

  private aggregateCompleted(job: ActiveJob): number {
    return job.baselineCompletedBytes + [...job.layers.values()].reduce((s, l) => s + l.completed, 0);
  }

  private async persist(job: ActiveJob, opts: { finished?: boolean } = {}): Promise<void> {
    if (!this.opts.repository) return;
    const record: DownloadRecord = {
      id: job.id,
      providerId: job.providerId,
      modelName: job.modelName,
      status: job.status,
      total: job.totalBytes,
      completed: this.aggregateCompleted(job),
      layersJson: JSON.stringify([...job.layers.values()]),
      startedAt: job.startedAt,
      finishedAt: opts.finished ? this.now() : undefined,
      error: job.error,
    };
    await this.opts.repository.save(record);
  }

  /** Corta la request HTTP (doc 13 §5.3: `AbortSignal` propio, `context.WithCancel` del lado
   *  servidor). No lanza si `downloadId` ya no está activo (idempotente). */
  async cancel(downloadId: string): Promise<void> {
    const job = this.active.get(downloadId);
    if (!job) return;
    job.controller.abort();
  }

  /** Elimina el modelo (doc 13 §5.6): `unload` previo si está cargado, rechazo si el scheduler tiene
   *  trabajo encolado para ese modelo, y recién entonces `DELETE /api/delete`. */
  async delete(modelName: string): Promise<void> {
    if (!this.provider.delete) {
      throw new Error(`el provider "${this.provider.id}" no soporta delete()`);
    }
    if (this.isDownloading(modelName)) {
      throw new Error(`"${modelName}" se está descargando: cancelá la descarga antes de borrarlo`);
    }
    const busy = (await this.opts.isBusy?.(modelName)) ?? false;
    if (busy) {
      const err = new Error(`el modelo "${modelName}" está en uso (cola del scheduler)`);
      err.name = 'ModelBusyError';
      throw err;
    }
    const loaded = (await this.opts.isLoaded?.(modelName)) ?? false;
    if (loaded && this.provider.unload) {
      await this.provider.unload(modelName);
    }
    await this.provider.delete(modelName);
  }
}
