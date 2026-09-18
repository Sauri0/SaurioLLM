// ModelManager: catálogo instalado, capabilities, único poller de /api/ps — packages/runtime/src/models/ModelManager.ts.
// Define: doc 08 §1-6 y doc 13 (MVP). Implementa la interfaz `ModelManager` de ./types.ts (contrato,
// no se modifica). Única capa que habla con /api/tags, /api/show y /api/ps (a través de los
// `Provider` que el host/Gateway le inyecta — doc 08 §1: "el ModelManager recibe la lista de
// providers() DEL GATEWAY, nunca instancia OllamaProvider por su cuenta").
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';
import type { ModelRef, ModelInfo, ModelDescription, LoadedModel, MemoryEstimate } from '@saurio/shared';
import type { HardwareProbe, ModelManager as ModelManagerContract } from './types.js';
import { MemoryEstimator, type ModelDescriber, type OverheadCalibrator } from './MemoryEstimator.js';
import type { CommandRunner } from './CommandRunner.js';
import { realCommandRunner, POWERSHELL_EXE } from './CommandRunner.js';

/** Subconjunto de `Provider` (packages/runtime/src/gateway/Provider.ts) que ModelManager necesita;
 *  se declara localmente en vez de importar el tipo completo para no acoplar este módulo a la
 *  forma exacta de `chat()`/`load()`/etc. que no usa — el objeto real que el host inyecta sigue
 *  siendo un `Provider` completo, esta es solo la vista que ModelManager consume. */
export interface ModelProvider {
  readonly id: string;
  readonly locality: ModelRef['locality'];
  health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string; error?: string }>;
  listModels(): Promise<ModelInfo[]>;
  describeModel(name: string): Promise<ModelDescription>;
  listLoaded?(): Promise<LoadedModel[]>;
}

/** Fila de `model_load_samples` (doc 08 §5.1). El repositorio SQLite real vive en
 *  packages/runtime/src/persistence (fuera de los directorios asignados a este módulo); acá se
 *  declara la interfaz que ModelManager necesita para escribir, inyectada por el host. */
export interface ModelLoadSample {
  id: string;
  providerId: string;
  modelName: string;
  modelDigest: string;
  numCtx: number;
  size: number;
  sizeVram: number;
  contextLength: number;
  loadMs: number;
  estimatedVram: number | null;
  sampledAt: number;
}

export interface ModelLoadSamplesRepository {
  insert(sample: ModelLoadSample): Promise<void>;
  /** Últimas N muestras de un modelo, más recientes primero; usadas para calibrar el overhead
   *  de MemoryEstimator con una media móvil exponencial (doc 08 §5.2). */
  recent(providerId: string, modelName: string, limit: number): Promise<ModelLoadSample[]>;
}

export interface DetectedModelsFolder {
  path: string;
  source: 'env:user' | 'env:machine' | 'default';
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
  modelLoadSamplesRepository?: ModelLoadSamplesRepository;
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
  private providers: ModelProvider[];
  private readonly probe: HardwareProbe;
  private readonly estimator: MemoryEstimator;
  private readonly runner: CommandRunner;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly idlePollMs: number;
  private readonly activePollMs: number;
  private readonly loadSamplesRepo?: ModelLoadSamplesRepository;
  private readonly overheadCalibrationSamples: number;

  private installedCache = new Map<string, ModelInfo[]>();
  private descriptionCache = new Map<string, ModelDescription>();
  private lastLoaded: LoadedModel[] = [];
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
    this.loadSamplesRepo = options.modelLoadSamplesRepository;
    this.overheadCalibrationSamples = options.overheadCalibrationSamples ?? 5;

    const describer: ModelDescriber = { describeModel: (ref) => this.describeModel(ref) };
    const calibrator: OverheadCalibrator | undefined = this.loadSamplesRepo
      ? { getCalibratedOverheadBytes: (ref) => this.calibrateOverhead(ref) }
      : undefined;
    this.estimator = new MemoryEstimator(describer, calibrator);
  }

  /** Cambio aditivo mínimo (encargo de apps/desktop, punto 2: "models:list debe unir los modelos de
   *  todos los providers habilitados"; packages/runtime no es zona de ese encargo — documentado acá y
   *  en docs/architecture/16-estado-de-implementacion.md). Reemplaza la lista completa cuando el
   *  usuario agrega/edita/quita un provider en Ajustes > Proveedores, sin reconstruir ModelManager
   *  (perdería el poller de `/api/ps` y la caché de `descriptionCache`). */
  setProviders(providers: ModelProvider[]): void {
    this.providers = providers;
  }

  private key(ref: ModelRef): string {
    return `${ref.providerId}::${ref.name}`;
  }

  private resolveProvider(providerId: string): ModelProvider {
    const provider = this.providers.find((p) => p.id === providerId);
    if (!provider) throw new Error(`Provider desconocido: ${providerId}`);
    return provider;
  }

  async listInstalled(refresh = false): Promise<ModelInfo[]> {
    const all: ModelInfo[] = [];
    for (const provider of this.providers) {
      if (!refresh && this.installedCache.has(provider.id)) {
        all.push(...(this.installedCache.get(provider.id) ?? []));
        continue;
      }
      const models = await provider.listModels();
      this.installedCache.set(provider.id, models);
      all.push(...models);
    }
    return all;
  }

  async listLoaded(): Promise<LoadedModel[]> {
    const all: LoadedModel[] = [];
    for (const provider of this.providers) {
      if (!provider.listLoaded) continue;
      const loaded = await provider.listLoaded();
      all.push(...loaded);
      this.emit('models:loaded', { providerId: provider.id, loaded });
    }
    this.lastLoaded = all;
    return all;
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

  private async calibrateOverhead(ref: ModelRef): Promise<number | undefined> {
    if (!this.loadSamplesRepo) return undefined;
    const samples = await this.loadSamplesRepo.recent(ref.providerId, ref.name, this.overheadCalibrationSamples);
    const withEstimate = samples.filter((s) => s.estimatedVram !== null);
    if (withEstimate.length === 0) return undefined;
    // EMA simple (peso decreciente por antigüedad); `samples` viene ordenado más-reciente-primero.
    const alpha = 0.5;
    let ema: number | undefined;
    for (let i = withEstimate.length - 1; i >= 0; i -= 1) {
      const sample = withEstimate[i];
      if (!sample) continue;
      const overheadSample = sample.sizeVram - (sample.estimatedVram ?? 0);
      ema = ema === undefined ? overheadSample : alpha * overheadSample + (1 - alpha) * ema;
    }
    return ema;
  }

  /** Registra `model_load_samples` tras cada carga real (doc 08 §5.1); lo llama el host/Gateway
   *  después de un `/api/chat` real o un `ensureLoaded` de precalentamiento, nunca ModelManager por
   *  su cuenta (ModelManager no llama a /api/chat). No forma parte de la interfaz `ModelManager` de
   *  ./types.ts (que no declara escritura); es API adicional que expone esta implementación. */
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
    const userValue = await this.readEnvVar('OLLAMA_MODELS', 'User');
    const machineValue = userValue ? undefined : await this.readEnvVar('OLLAMA_MODELS', 'Machine');
    const path = userValue ?? machineValue ?? this.defaultModelsFolder();
    const source: DetectedModelsFolder['source'] = userValue ? 'env:user' : machineValue ? 'env:machine' : 'default';
    const validated = await this.validateModelsFolder(path);
    const space = await this.diskSpaceOf(path);
    return { path, source, validated, ...space };
  }

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
