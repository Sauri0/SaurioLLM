// Model Hub y hardware: catálogo, fit y probe — packages/runtime/src/models/types.ts.
// Define: doc 04 §11 (HardwareProbe/MemoryEstimator) y §13 (ModelManager/catálogo/recomendaciones).
// Solo interfaces/tipos (sin implementación). MVP: HardwareProbe con CPU/RAM medidos + nvidia-smi
// bajo demanda, MemoryEstimator.fits(), catálogo instalado, capabilities, fits, carpeta detectada
// (modo attach), badge de localidad. AMD/Apple/registro de Windows, DownloadManager,
// RecommendationEngine y modo managed son v0.2/v0.3.
import type { ModelRef, Locality, ModelInfo, ModelDescription, LoadedModel, MemoryEstimate, Quality, ProviderCatalogStatus } from '@saurio/shared';

export type { ModelInfo, ModelDescription, LoadedModel, MemoryEstimate };

/** Cada dato trae su fuente y confiabilidad (condición 11.A); nunca se mezcla measured con
 *  estimated sin decirlo. Ver tabla completa de fuentes en la columna §17. */
export interface HardwareDatum<T> { value: T; unit?: string; quality: Quality; source: string; sampledAt: number }

/** Renombrado desde "hardware_inventory_json" del brief; llamado HardwareProfile en doc 04 porque
 *  agrupa el snapshot completo con el que se calcula fitClass y recomendaciones — ver doc 04,
 *  Nomenclatura agregada. */
export interface HardwareProfile {
  cpu: { name: HardwareDatum<string>; threads: HardwareDatum<number>; physicalCores?: HardwareDatum<number> };
  ram: { totalBytes: HardwareDatum<number>; freeBytes: HardwareDatum<number> };
  gpu?: {
    vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';
    vramTotalBytes: HardwareDatum<number>; vramUsedBytes?: HardwareDatum<number>;
    utilizationPct?: HardwareDatum<number>; temperatureC?: HardwareDatum<number>; powerW?: HardwareDatum<number>;
    /** `true` para iGPU/memoria unificada (Intel Arc iGPU, Apple Silicon, APU de AMD): la VRAM
     *  reportada es un techo compartido con la RAM del sistema, no memoria dedicada — la escala de
     *  seis niveles (`TierClassifier`) y `MemoryEstimator` lo usan para ser más conservadores (margen
     *  mayor, ancho de banda menor) en vez de tratarlo como una GPU dedicada. Sesión de hardware real
     *  (equipo #2, Intel Core Ultra 9 288V + Arc 140V): Ollama reporta `type=iGPU`, total 18.0 GiB
     *  sobre 32 GB de RAM total (`[COMPROBADO EN EQUIPO]`, ver `parseOllamaInferenceComputeLog`). */
    integrated?: boolean;
  };
  fingerprint: string;      // hash(gpu_uuid, vram_total, cpu_model, ram_total); invalida ModelCompat si cambia
  sampledAt: number;
}

export interface HardwareProbe {
  sample(): Promise<HardwareProfile>;
  supportsGpuSampling(): boolean;      // false: nvidia-smi ausente y no hay contador Windows disponible
  /** Invalida la detección cacheada de GPU antes de una medición manual. Opcional para conservar
   * adaptadores de prueba/implementaciones externas que sólo exponen la lectura base. */
  refreshGpu?(): void;
}

export interface MemoryEstimator {
  /** Evalúa GPU y RAM al contexto solicitado. `partial_offload` también representa CPU-only
   * viable; `no_fit` significa que ni la memoria combinada alcanza. */
  fits(ref: ModelRef, numCtx: number, hardware: HardwareProfile): Promise<MemoryEstimate>;
}

/** Avisos de modo attach (doc 13 §6): contexto 256K por defecto de la app de bandeja / posible
 *  exposición a la red — nunca cambian configuración, solo informan. */
export interface AttachWarning { code: 'context_256k_default' | 'network_exposed'; message: string }
export interface AttachWarningInput { baseUrl: string; observedContextLength?: number; ollamaHostEnv?: string }

export interface ModelManager {
  listInstalled(refresh?: boolean, providerId?: string): Promise<ModelInfo[]>;
  catalogStatus?(): ProviderCatalogStatus[];
  updateManualModel?(providerId: string, name: string, remove?: boolean): Promise<void>;
  listLoaded(): Promise<LoadedModel[]>;                 // único poller de /api/ps del sistema
  describeModel(ref: ModelRef): Promise<ModelDescription>;
  fits(ref: ModelRef, numCtx: number): Promise<MemoryEstimate>;
  detectedModelsFolder(): Promise<{
    path: string; source: 'env:user' | 'env:machine' | 'default' | 'managed'; validated: boolean;
    freeBytes?: number; totalBytes?: number; spaceQuality: 'measured' | 'unavailable';
  }>;
  attachWarnings(input: AttachWarningInput): AttachWarning[];
}

export interface DownloadJob {                          // v0.2
  id: string; providerId: string; modelName: string;
  phase?: 'downloading' | 'verifying' | 'importing';
  // 'insufficient_space' (doc 13 §5 punto 1 / doc 16 §8 punto 1 / punto 2 del encargo): la migración
  // 0002 ya amplió el CHECK de `downloads.status`; este valor se persiste desde `DownloadManager.pull()`
  // cuando `checkSpace()` rechaza la descarga, para que la pestaña Descargas lo pueda mostrar.
  status: 'queued' | 'running' | 'paused' | 'cancelled' | 'done' | 'failed' | 'insufficient_space';
  totalBytes: number; completedBytes: number;
  bytesPerSec?: number; etaMs?: number;
  layers: { digest: string; total: number; completed: number }[];
  startedAt?: number; finishedAt?: number; error?: string;
}

export interface DownloadManager {                      // v0.2
  checkSpace(modelName: string): Promise<{ neededBytes: number; freeBytes: number; ok: boolean }>;
  pull(modelName: string): Promise<{ downloadId: string }>;
  cancel(downloadId: string): Promise<void>;
  delete(modelName: string): Promise<void>;              // hace unload previo si está cargado
}

// ── Puertos de apoyo de DownloadManager (v0.2, doc 13 §5) ────────────────────
// Todos inyectados por el host (apps/desktop), igual que ModelLoadSamplesRepository en
// ModelManager.ts: DownloadManager no importa `fetch` de un registry concreto ni SQLite
// directamente, así se puede testear con fixtures y sin red/disco real.

/** Una capa del manifest Docker v2 del registry de Ollama (doc 13 §3): `GET
 *  https://registry.ollama.ai/v2/library/<modelo>/manifests/<tag>`. */
export interface RegistryLayer { digest: string; size: number; mediaType?: string }
export interface RegistryManifest { layers: RegistryLayer[]; config?: RegistryLayer }

export interface ManifestFetcher {
  fetchManifest(modelName: string): Promise<RegistryManifest>;
}

/** `true` si el blob de ese digest ya existe en `<modelsFolder>/blobs/` (doc 13 §3: "restando las
 *  capas ya presentes" — instalar un tag después de otro puede pesar menos porque comparten capas). */
export interface BlobStoreProbe {
  hasBlob(modelsFolder: string, digest: string): Promise<boolean>;
}

export interface DiskSpaceProbe {
  freeBytes(path: string): Promise<number | undefined>;
}

export interface DownloadRecord {
  id: string; providerId: string; modelName: string;
  status: 'queued' | 'running' | 'paused' | 'cancelled' | 'done' | 'failed' | 'insufficient_space';
  total?: number; completed?: number; layersJson?: string;
  startedAt?: number; finishedAt?: number; error?: string;
}

/** Puerto mínimo hacia la tabla `downloads` (spine §4, ya migrada en persistence/migrations/0001).
 *  `packages/runtime/src/persistence` no es zona de este módulo (otro agente la mantiene en
 *  paralelo): el host (apps/desktop) implementa este puerto con SQL directo sobre el `driver` ya
 *  expuesto por `openPersistence()`, sin que DownloadManager conozca better-sqlite3. */
export interface DownloadsRepositoryPort {
  save(record: DownloadRecord): Promise<void>;
  get(id: string): Promise<DownloadRecord | undefined>;
}

/** Subconjunto de `Provider` que DownloadManager necesita para pull/delete/unload (mismo patrón que
 *  `ModelProvider` en ModelManager.ts: vista local, no el `Provider` completo del Gateway). */
export interface DownloadProvider {
  readonly id: string;
  pull?(name: string, signal: AbortSignal): AsyncIterable<{ status: string; digest?: string; total?: number; completed?: number }>;
  delete?(name: string): Promise<void>;
  unload?(name: string): Promise<void>;
}

export interface DownloadManagerOptions {
  manifestFetcher: ManifestFetcher;
  blobStore: BlobStoreProbe;
  diskSpace: DiskSpaceProbe;
  modelsFolder: () => Promise<string>;
  /** `true` si el modelo está cargado ahora mismo (último `/api/ps` de ModelManager); DownloadManager
   *  nunca hace su propio poll (doc 13 §2: "único poller de /api/ps" es ModelManager). */
  isLoaded?: (modelName: string) => Promise<boolean>;
  /** `true` si el InferenceScheduler tiene trabajo encolado para este modelo (doc 13 §5 punto 6). */
  isBusy?: (modelName: string) => Promise<boolean>;
  repository?: DownloadsRepositoryPort;
  onProgress?: (job: DownloadJob) => void;
  onDone?: (job: DownloadJob) => void;
  onFailed?: (job: DownloadJob, error: string) => void;
  now?: () => number;
  idGenerator?: () => string;
  /** Margen de seguridad antes de bloquear una descarga por espacio (doc 13 §5 punto 1: 2 GiB). */
  freeSpaceMarginBytes?: number;
}


export interface ModelCatalogEntry {                     // resources/model-catalog.json, v0.2
  name: string; tag: string; sizeBytes: number; capabilities: ModelInfo['capabilities'];
  contextMax: number; suggestedUse: ('coding' | 'chat' | 'analysis' | 'vision')[]; notes?: string;
  // Campo aditivo (ya existía en el zod schema de ./catalog.ts y en packages/shared/src/domain.ts,
  // faltaba acá): cuantización curada a mano ("Q4_K_M", etc.) — doc 13 §3, esquema por entrada del
  // catálogo curado. `loadModelCatalog` ya lo devolvía en la práctica (zod-inferido), esta interfaz
  // solo estaba desactualizada respecto de su propio schema.
  quantization?: string;
  /** Punto 4 del encargo (doc 16, "modelos con X / sin compatibilidad para descargar") — ver el
   *  comentario del mismo campo en packages/shared/src/domain.ts (espejo zod de esta interfaz). */
  cloud?: boolean;
  sizeUnresolved?: boolean;
}

/** Salida del RecommendationEngine (v0.3); función pura sobre inventario x catálogo x ModelCompat.
 *  "tested" solo aparece si existe una fila ModelCompat con status 'fits' para este fingerprint. */
export interface Recommendation {
  catalogEntry: ModelCatalogEntry; fitClass: MemoryEstimate['fitClass'];
  locality: Locality;
  speedHint: 'fast' | 'medium' | 'slow'; usesCpuOffload: boolean;
  fitQuality?: 'measured' | 'estimated';
  contextUsed?: number;
  reason?: string;
  tested?: { tokPerSec: number; testedAt: number; hardwareFingerprint: string };  // ausente: sin ModelCompat
}

export interface RecommendationEngine {                  // v0.3
  recommend(hardware: HardwareProfile, use: ModelCatalogEntry['suggestedUse'][number], goal: 'speed' | 'quality'): Promise<Recommendation[]>;
}

/** FitEstimate: alias del nombre que usa el canal IPC 'models:fits' (doc 04 §16) para
 *  `MemoryEstimate`; se documenta acá para que quede claro que no es un tipo nuevo. */
export type FitEstimate = MemoryEstimate;
