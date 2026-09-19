// ModelManager: catálogo instalado, capabilities, único poller de /api/ps — packages/runtime/src/models/ModelManager.ts.
// Define: doc 08 §1-6 y doc 13 (MVP). Implementa la interfaz `ModelManager` de ./types.ts (contrato,
// no se modifica). Única capa que habla con /api/tags, /api/show y /api/ps (a través de los
// `Provider` que el host/Gateway le inyecta — doc 08 §1: "el ModelManager recibe la lista de
// providers() DEL GATEWAY, nunca instancia OllamaProvider por su cuenta").
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';
import type { ModelRef, ModelInfo, ModelDescription, LoadedModel, MemoryEstimate } from '@saurio/shared';
import type { HardwareProbe, ModelManager as ModelManagerContract } from './types.js';
import {
  DEFAULT_MEMORY_OVERHEAD_BYTES, MemoryEstimator, type ModelDescriber, type OverheadCalibrator,
} from './MemoryEstimator.js';
import type { CommandRunner } from './CommandRunner.js';
import { realCommandRunner, POWERSHELL_EXE } from './CommandRunner.js';
import { ProviderCatalog, type CatalogStorage } from './ProviderCatalog.js';

/** Subconjunto de `Provider` (packages/runtime/src/gateway/Provider.ts) que ModelManager necesita;
 *  se declara localmente en vez de importar el tipo completo para no acoplar este módulo a la
 *  forma exacta de `chat()`/`load()`/etc. que no usa — el objeto real que el host inyecta sigue
 *  siendo un `Provider` completo, esta es solo la vista que ModelManager consume. */
export interface ModelProvider {
  readonly id: string;
  readonly locality: ModelRef['locality'];
  health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string; error?: string }>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  describeModel(name: string): Promise<ModelDescription>;
  listLoaded?(signal?: AbortSignal): Promise<LoadedModel[]>;
}

/** Fila de `model_load_samples` (doc 08 §5.1). El repositorio SQLite real vive en
 *  packages/runtime/src/persistence (fuera de los directorios asignados a este módulo); acá se
 *  declara la interfaz que ModelManager necesita para escribir, inyectada por el host. */
export interface ModelLoadSample {
  id: string;
  providerId: string;
  modelName: string;
  modelDigest: string | null;
  numCtx: number;
  size: number | null;
  sizeVram: number | null;
  contextLength: number | null;
  loadMs: number | null;
  estimatedVram: number | null;
  hardwareFingerprint: string | null;
  sampledAt: number;
}

export interface ModelLoadSamplesRepository {
  insert(sample: ModelLoadSample): Promise<void>;
  /** Últimas N muestras de un modelo, más recientes primero; usadas para calibrar el overhead
   *  de MemoryEstimator con una media móvil exponencial (doc 08 §5.2). */
  recent(
    providerId: string, modelName: string, modelDigest: string, numCtx: number,
    hardwareFingerprint: string, limit: number,
  ): Promise<ModelLoadSample[]>;
}

export interface DetectedModelsFolder {
  path: string;
  source: 'env:user' | 'env:machine' | 'default' | 'managed';
  validated: boolean;
  /** Espacio libre/total del filesystem que contiene `path` (doc 13 §5 punto 1, `fs.statfsSync`
   *  verificado en esta máquina: N: 480.359.034.880 bytes libres). `undefined` si `statfs` no pudo
   *  leer ni `path` ni ningún ancestro existente (permisos, unidad desconectada). */
  freeBytes?: number;
  totalBytes?: number;
  spaceQuality: 'measured' | 'unavailable';
}

/** Advertencias "attach" (doc 08 §2, doc 13 §6): ModelManager NUNCA lee la base de datos de la app
 *  de bandeja de Ollama ni el entorno del proceso servidor por su cuenta — eso violaría "modo
 *  lectura" fuera de lo que la API expone. El host (apps/desktop) es quien tiene esos datos
 *  (server.log, db.sqlite de la app de bandeja, OLLAMA_HOST) y se los pasa acá; ModelManager solo
 *  aplica la heurística de qué mostrar. */
export interface AttachWarningInput {
  baseUrl: string;
  /** `/api/ps.context_length` del último modelo cargado, si hay uno. */
  observedContextLength?: number;
  /** Valor de OLLAMA_HOST leído por el host, si es legible. */
  ollamaHostEnv?: string;
}

export interface AttachWarning {
  code: 'context_256k_default' | 'network_exposed';
  message: string;
}

const DEFAULT_WARN_CONTEXT_LENGTH = 262144; // OLLAMA_CONTEXT_LENGTH por defecto de la app de bandeja (doc 08 §3)

export interface ModelManagerOptions {
  runner?: CommandRunner;
  now?: () => number;
  platformOverride?: NodeJS.Platform;
  /** ms de reposo entre polls de /api/ps sin actividad (doc 08 §4: 30 s en reposo). */
  idlePollMs?: number;
  /** ms entre polls con actividad (modelo cargado y panel abierto o run activo; doc 08 §4: 5 s). */
  activePollMs?: number;
  /** Plazo por proveedor para `/api/ps`; evita que uno caído bloquee los demás. */
  loadedTimeoutMs?: number;
  modelLoadSamplesRepository?: ModelLoadSamplesRepository;
  catalogStorage?: CatalogStorage;
  catalogStorageKey?: (providerId: string) => string;
  idGenerator?: () => string;
  /** Cuántas muestras recientes promediar en la EMA de calibración del overhead. */
  overheadCalibrationSamples?: number;
}

interface ModelsLoadedEvent { providerId: string; loaded: LoadedModel[] }
interface ModelsChangedEvent { providerId: string }

// Idioma estándar de TS para tipar los eventos de un `EventEmitter` (mismo patrón que
// `DownloadManager.ts`, ver el comentario ahí): la fusión interfaz+clase es intencional y segura
// (solo sobrecarga `on`/`emit`, no agrega miembros nuevos) — se deshabilita puntualmente la regla
// que no distingue este caso del genuinamente riesgoso (punto 6 del encargo: sin cambiar comportamiento).
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface ModelManager {
  on(event: 'models:loaded', listener: (payload: ModelsLoadedEvent) => void): this;
  on(event: 'models:changed', listener: (payload: ModelsChangedEvent) => void): this;
  emit(event: 'models:loaded', payload: ModelsLoadedEvent): boolean;
  emit(event: 'models:changed', payload: ModelsChangedEvent): boolean;
}

/** Único poller de /api/ps del sistema (doc 08 §1 y §4): nadie más —Centro de modelos, Telemetry—
 *  abre su propio intervalo; todos escuchan los eventos `models:loaded`/`models:changed` de esta
 *  instancia (single instance en todo el proceso, inyectada donde haga falta). */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ModelManager extends EventEmitter implements ModelManagerContract {
  private managedModelsFolder?: string;
  private providers: ModelProvider[];
  private readonly probe: HardwareProbe;
  private readonly estimator: MemoryEstimator;
  private readonly baselineEstimator: MemoryEstimator;
  private readonly runner: CommandRunner;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly idlePollMs: number;
  private readonly activePollMs: number;
  private readonly loadedTimeoutMs: number;
  private readonly loadSamplesRepo?: ModelLoadSamplesRepository;
  private readonly overheadCalibrationSamples: number;
  private readonly idGenerator: () => string;
  private readonly providerCatalog: ProviderCatalog;

  private descriptionCache = new Map<string, ModelDescription>();
  private lastLoaded: LoadedModel[] = [];
  private observedLoadedKeys = new Set<string>();
  private pollTimer: NodeJS.Timeout | undefined;
  private activityHint = false; // panel abierto o run activo (lo fija el host con setActivityHint)

  constructor(providers: ModelProvider[], probe: HardwareProbe, options: ModelManagerOptions = {}) {
    super();
    this.providers = providers;
    this.probe = probe;
    this.runner = options.runner ?? realCommandRunner;
    this.now = options.now ?? Date.now;
    this.platform = options.platformOverride ?? osPlatform();
    this.idlePollMs = options.idlePollMs ?? 30_000;
    this.activePollMs = options.activePollMs ?? 5_000;
    this.loadedTimeoutMs = options.loadedTimeoutMs ?? 15_000;
    this.loadSamplesRepo = options.modelLoadSamplesRepository;
    this.overheadCalibrationSamples = options.overheadCalibrationSamples ?? 5;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.providerCatalog = new ProviderCatalog({
      storage: options.catalogStorage,
      storageKey: options.catalogStorageKey,
      now: this.now,
    });

    const describer: ModelDescriber = { describeModel: (ref) => this.describeModel(ref) };
    const calibrator: OverheadCalibrator | undefined = this.loadSamplesRepo
      ? { getCalibratedOverheadBytes: (ref, numCtx, fingerprint) =>
        this.calibrateOverhead(ref, numCtx, fingerprint) }
      : undefined;
    this.estimator = new MemoryEstimator(describer, calibrator);
    // Las muestras guardan la predicción base comparable entre fechas. Si se midiera con el mismo
    // calibrador que luego consume la muestra, el feedback mezclaría corrección previa y nueva.
    this.baselineEstimator = new MemoryEstimator(describer);
  }

  /** Cambio aditivo mínimo (encargo de apps/desktop, punto 2: "models:list debe unir los modelos de
   *  todos los providers habilitados"; packages/runtime no es zona de ese encargo — documentado acá y
   *  en docs/architecture/16-estado-de-implementacion.md). Reemplaza la lista completa cuando el
   *  usuario agrega/edita/quita un provider en Ajustes > Proveedores, sin reconstruir ModelManager
   *  (perdería el poller de `/api/ps` y la caché de `descriptionCache`). */
  setProviders(providers: ModelProvider[]): void {
    this.providers = providers;
    this.providerCatalog.reset();
    this.descriptionCache.clear();
  }

  private key(ref: ModelRef): string {
    return `${ref.providerId}::${ref.name}`;
  }

  private resolveProvider(providerId: string): ModelProvider {
    const provider = this.providers.find((p) => p.id === providerId);
    if (!provider) throw new Error(`Provider desconocido: ${providerId}`);
    return provider;
  }

  catalogStatus() {
    return this.providers.map((provider) => this.providerCatalog.status(provider.id));
  }

  async updateManualModel(providerId: string, name: string, remove = false): Promise<void> {
    const provider = this.resolveProvider(providerId);
    await this.providerCatalog.updateManual({ providerId, name, locality: provider.locality }, remove);
  }

  async listInstalled(refresh = false, providerId?: string): Promise<ModelInfo[]> {
    if (providerId !== undefined) this.resolveProvider(providerId);
    const all: ModelInfo[] = [];
    const failures: unknown[] = [];
    let responding = 0;
    const providers = this.providers;
    const results = await Promise.allSettled(providers.map((provider) =>
      providerId !== undefined && provider.id !== providerId
        ? this.providerCatalog.cachedOnly(provider.id)
        : this.providerCatalog.read(provider, refresh)));
    if (providers !== this.providers) return this.listInstalled();
    for (const result of results) {
      if (result.status === 'fulfilled') {
        all.push(...result.value);
        responding += 1;
      } else failures.push(result.reason);
    }
    const manualResults = await Promise.allSettled(providers.map((provider) => this.providerCatalog.manualModels(provider.id, provider.locality)));
    const keys = new Set(all.map((model) => this.key(model.ref)));
    for (const result of manualResults) {
      if (result.status === 'rejected') { failures.push(result.reason); continue; }
      if (result.value.length > 0) responding++;
      for (const model of result.value) {
        if (!keys.has(this.key(model.ref))) { all.push(model); keys.add(this.key(model.ref)); }
        else {
          const index = all.findIndex((entry) => this.key(entry.ref) === this.key(model.ref));
          const remote = all[index];
          if (remote) all[index] = { ...remote, manualDefinition: true };
        }
      }
    }
    if (providers !== this.providers) return this.listInstalled();
    if (responding === 0 && failures.length > 0) throw failures[0];
    return all;
  }

  async listLoaded(): Promise<LoadedModel[]> {
    const all: LoadedModel[] = [];
    const currentKeys = new Set<string>();
    const candidates = this.providers.filter((provider) => provider.listLoaded !== undefined);
    const results = await Promise.allSettled(candidates.map(async (provider) => ({
      provider,
      loaded: await this.listLoadedFromProvider(provider),
    })));
    let responding = 0;
    let firstFailure: unknown;
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const provider = candidates[index];
      if (!result || !provider) continue;
      if (result.status === 'rejected') {
        firstFailure ??= result.reason;
        // No asumir que un timeout descargó modelos: conservar el estado de deduplicación de ese
        // proveedor hasta que vuelva a responder evita registrar la misma carga como nueva.
        const prefix = `${provider.id}::`;
        for (const key of this.observedLoadedKeys) if (key.startsWith(prefix)) currentKeys.add(key);
        continue;
      }
      responding += 1;
      const loaded = result.value.loaded;
      all.push(...loaded);
      for (const model of loaded) {
        const observationKey = this.loadedObservationKey(provider.id, model);
        currentKeys.add(observationKey);
        if (!this.loadSamplesRepo || this.observedLoadedKeys.has(observationKey)) continue;
        // Se marca antes de esperar para que dos consumidores concurrentes del único poller no
        // dupliquen la misma observación. Si SQLite falla, el próximo poll vuelve a intentarlo.
        this.observedLoadedKeys.add(observationKey);
        const observation = { id: this.idGenerator(), sampledAt: this.now() };
        void this.recordObservedLoad(provider, model, observation).catch(() => {
          this.observedLoadedKeys.delete(observationKey);
        });
      }
      this.emit('models:loaded', { providerId: provider.id, loaded });
    }
    if (responding === 0 && firstFailure !== undefined) throw firstFailure;
    this.observedLoadedKeys = currentKeys;
    this.lastLoaded = all;
    return all;
  }

  private async listLoadedFromProvider(provider: ModelProvider): Promise<LoadedModel[]> {
    if (!provider.listLoaded) return [];
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`El proveedor "${provider.id}" tardó demasiado en informar los modelos cargados.`));
        }, this.loadedTimeoutMs);
      });
      return await Promise.race([provider.listLoaded(controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private loadedObservationKey(providerId: string, model: LoadedModel): string {
    return `${providerId}::${model.name}::${model.digest}::${model.contextLength}::${model.sizeVram}`;
  }

  /** `/api/ps` confirma tamaño residente y contexto, pero no informa latencia de carga ni tok/s.
   * Esos campos quedan desconocidos en vez de atribuirle una velocidad inventada a la observación. */
  private async recordObservedLoad(
    provider: ModelProvider, model: LoadedModel, observation: { id: string; sampledAt: number },
  ): Promise<void> {
    if (!this.loadSamplesRepo) return;
    const ref: ModelRef = { providerId: provider.id, name: model.name, locality: provider.locality };
    let estimatedVram: number | null = null;
    let hardwareFingerprint: string | null = null;
    try {
      const hardware = await this.probe.sample();
      hardwareFingerprint = hardware.fingerprint;
      estimatedVram = (await this.baselineEstimator.fits(ref, model.contextLength, hardware)).vramNeededBytes;
    } catch {
      // La medición de /api/ps sigue siendo válida aunque /api/show o el sondeo de hardware fallen.
    }
    await this.loadSamplesRepo.insert({
      id: observation.id, providerId: provider.id, modelName: model.name,
      modelDigest: model.digest || null, numCtx: model.contextLength, size: model.size,
      sizeVram: model.sizeVram, contextLength: model.contextLength, loadMs: null,
      estimatedVram, hardwareFingerprint, sampledAt: observation.sampledAt,
    });
  }

  async describeModel(ref: ModelRef): Promise<ModelDescription> {
    const key = this.key(ref);
    const cached = this.descriptionCache.get(key);
    if (cached) return cached;
    const provider = this.resolveProvider(ref.providerId);
    const description = await provider.describeModel(ref.name);
    this.descriptionCache.set(key, description);
    return description;
  }

  async fits(ref: ModelRef, numCtx: number): Promise<MemoryEstimate> {
    const hardware = await this.probe.sample();
    return this.estimator.fits(ref, numCtx, hardware);
  }

  private async calibrateOverhead(
    ref: ModelRef, numCtx: number, hardwareFingerprint: string,
  ): Promise<number | undefined> {
    if (!this.loadSamplesRepo) return undefined;
    const description = await this.describeModel(ref);
    if (!description.digest) return undefined;
    const samples = await this.loadSamplesRepo.recent(
      ref.providerId, ref.name, description.digest, numCtx, hardwareFingerprint, this.overheadCalibrationSamples,
    );
    const withEstimate = samples.filter((s): s is ModelLoadSample & { estimatedVram: number; sizeVram: number } =>
      s.estimatedVram !== null && s.sizeVram !== null);
    if (withEstimate.length === 0) return undefined;
    // EMA simple (peso decreciente por antigüedad); `samples` viene ordenado más-reciente-primero.
    const alpha = 0.5;
    let ema: number | undefined;
    for (let i = withEstimate.length - 1; i >= 0; i -= 1) {
      const sample = withEstimate[i];
      if (!sample) continue;
      // estimated_vram contiene la fórmula base completa (incluido el overhead inicial). La
      // diferencia contra /api/ps es la corrección, no el overhead total.
      const overheadSample = DEFAULT_MEMORY_OVERHEAD_BYTES + sample.sizeVram - sample.estimatedVram;
      ema = ema === undefined ? overheadSample : alpha * overheadSample + (1 - alpha) * ema;
    }
    return ema === undefined ? undefined : Math.max(ema, 0);
  }

  /** Registra una muestra provista por el host/Gateway. Además, `listLoaded()` registra por sí mismo
   * las observaciones reales de `/api/ps`, dejando desconocida la latencia que ese endpoint no da. */
  async recordLoadSample(sample: ModelLoadSample): Promise<void> {
    if (!this.loadSamplesRepo) return;
    await this.loadSamplesRepo.insert(sample);
  }

  /** El panel de rendimiento (o un run activo) sube la frecuencia del único poller (doc 08 §4). */
  setActivityHint(active: boolean): void {
    this.activityHint = active;
  }

  startPolling(): void {
    if (this.pollTimer) return;
    const tick = async (): Promise<void> => {
      const hasLoadedModel = this.lastLoaded.length > 0;
      try {
        await this.listLoaded();
      } catch {
        // Ollama no responde: se deja que Telemetry.Diagnostics lo detecte vía health(); el poller
        // no lanza ni loguea acá para no duplicar el diagnóstico (doc 08 §1: "el ModelManager mide
        // y cataloga; nadie estima lo que otro ya midió").
      }
      const interval = hasLoadedModel && this.activityHint ? this.activePollMs : this.idlePollMs;
      this.pollTimer = setTimeout(() => void tick(), interval);
    };
    this.pollTimer = setTimeout(() => void tick(), 0);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** Carpeta OLLAMA_MODELS en modo attach (doc 13 §6): variable de usuario, luego de máquina, con
   *  fallback al default de Windows, y validación de solo lectura contra los manifests instalados. */
  async detectedModelsFolder(): Promise<DetectedModelsFolder> {
    if (this.managedModelsFolder) {
      return { path: this.managedModelsFolder, source: 'managed', validated: existsSync(this.managedModelsFolder),
        ...await this.diskSpaceOf(this.managedModelsFolder) };
    }
    const userValue = await this.readEnvVar('OLLAMA_MODELS', 'User');
    const machineValue = userValue ? undefined : await this.readEnvVar('OLLAMA_MODELS', 'Machine');
    const path = userValue ?? machineValue ?? this.defaultModelsFolder();
    const source: DetectedModelsFolder['source'] = userValue ? 'env:user' : machineValue ? 'env:machine' : 'default';
    const validated = await this.validateModelsFolder(path);
    const space = await this.diskSpaceOf(path);
    return { path, source, validated, ...space };
  }

  setManagedModelsFolder(folder: string | undefined): void { this.managedModelsFolder = folder; }

  /** `fs.statfs` sobre `path` (doc 13 §5 punto 1); si `path` todavía no existe (carpeta detectada
   *  por convención pero nunca creada) sube por los ancestros hasta encontrar uno que exista, para
   *  igual reportar el espacio libre de esa unidad/punto de montaje. Solo lectura. */
  private async diskSpaceOf(path: string): Promise<Pick<DetectedModelsFolder, 'freeBytes' | 'totalBytes' | 'spaceQuality'>> {
    let probe = path;
    for (let i = 0; i < 8; i += 1) {
      try {
        const stats = await statfs(probe);
        const freeBytes = stats.bfree * stats.bsize;
        const totalBytes = stats.blocks * stats.bsize;
        return { freeBytes, totalBytes, spaceQuality: 'measured' };
      } catch {
        const parent = join(probe, '..');
        if (parent === probe) break;
        probe = parent;
      }
    }
    return { spaceQuality: 'unavailable' };
  }

  private defaultModelsFolder(): string {
    if (this.platform === 'win32') return join(homedir(), '.ollama', 'models');
    return join(homedir(), '.ollama', 'models');
  }

  private async readEnvVar(name: string, scope: 'User' | 'Machine'): Promise<string | undefined> {
    if (this.platform !== 'win32') return process.env[name];
    try {
      const script = `[Environment]::GetEnvironmentVariable('${name}', '${scope}')`;
      const { stdout } = await this.runner(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', script]);
      const value = stdout.trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** Valida contra manifests: existe `manifests/registry.ollama.ai/library/<nombre>/<tag>` para al
   *  menos un modelo de los que devuelve /api/tags (doc 13 §6). Solo lectura (fs.existsSync). */
  private async validateModelsFolder(path: string): Promise<boolean> {
    try {
      const installed = await this.listInstalled(false);
      if (installed.length === 0) return existsSync(path);
      for (const model of installed) {
        const [name, tag = 'latest'] = model.ref.name.split(':');
        const manifestPath = join(path, 'manifests', 'registry.ollama.ai', 'library', name ?? model.ref.name, tag);
        if (existsSync(manifestPath)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Advertencias attach (doc 08 §2/§3, doc 13 §6): puramente a partir de datos que el host le pasa;
   *  ModelManager nunca lee la config de Ollama por su cuenta. */
  attachWarnings(input: AttachWarningInput): AttachWarning[] {
    const warnings: AttachWarning[] = [];
    if (input.observedContextLength !== undefined && input.observedContextLength >= DEFAULT_WARN_CONTEXT_LENGTH) {
      warnings.push({
        code: 'context_256k_default',
        message: 'El servidor de Ollama tiene un contexto por defecto de 256K (app de bandeja); SaurioLLM siempre manda options.numCtx explícito, pero si algo lo omitiera heredaría este valor.',
      });
    }
    const isLoopback = /^(https?:\/\/)?(127\.0\.0\.1|localhost)([:/]|$)/i.test(input.baseUrl);
    const hostLooksExposed = input.ollamaHostEnv !== undefined && /0\.0\.0\.0/.test(input.ollamaHostEnv);
    if (!isLoopback || hostLooksExposed) {
      warnings.push({
        code: 'network_exposed',
        message: 'SaurioLLM no puede confirmar a qué red escucha Ollama; esto es una estimación basada en tu configuración, no una detección certera.',
      });
    }
    return warnings;
  }
}
