// Cableado real de @saurio/runtime para el proceso main — apps/desktop/src/main/host/createRuntime.ts.
// Define: doc 02 §1 (RuntimeHost "instancia @saurio/runtime"), doc 01 §4 (mapa de módulos) y la fase
// de integración del MVP. Este archivo es el ÚNICO lugar donde se construyen instancias concretas:
// persistence (migraciones + repositorios), gateway con OllamaProvider/OpenAICompatProvider/
// AnthropicProvider (punto 2 del encargo: providers reales configurados por el usuario, no solo
// Ollama), Scheduler de 1 slot, ToolRegistry con las 10 builtins, PermissionEngine, CheckpointService,
// ContextBuilder con el repo map de @saurio/repomap y un Compactor real, ModelManager, HardwareProbe
// y Telemetry.
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  openPersistence, type ModelCompatRecord, type PersistenceHandle,
} from '@saurio/runtime/persistence/index';
import { ModelGatewayImpl, OllamaProvider, OpenAICompatProvider, AnthropicProvider } from '@saurio/runtime/gateway/index';
import type { Provider } from '@saurio/runtime/gateway/Provider';
import {
  HardwareProbe, ModelManager, DownloadManager, RegistryClient, FsBlobStoreProbe, FsDiskSpaceProbe,
  RecommendationEngine, loadModelCatalog, OllamaLibraryClient, HuggingFaceClient, loadOllamaLibrarySnapshot,
} from '@saurio/runtime/models/index';
import type { HardwareProbeOptions } from '@saurio/runtime/models/index';
import type { ModelCatalogEntry, DownloadProvider } from '@saurio/runtime/models/index';
import { withHuggingFaceImports } from '@saurio/runtime/models/HuggingFaceDownloadProvider';
import type { LocalChatOptions } from '@saurio/runtime/gateway/types';
import { Diagnostics, MetricsAggregator } from '@saurio/runtime/telemetry/index';
import { SqlDownloadsRepository, seedOllamaProviderRow } from '../services/downloads/SqlDownloadsRepository.js';
import { FileLibraryCache } from '../services/models/LibraryCache.js';
import {
  SqlProvidersRepository, toProviderConfig, OLLAMA_PROVIDER_ID, type StoredProvider,
} from '../services/providers/SqlProvidersRepository.js';
import { SecureKeyStore, type SafeStorageLike } from '../services/providers/SecureKeyStore.js';
import { SqlAuditLogRepository } from '../services/audit/SqlAuditLogRepository.js';
import { readResourceFile, resolveRepoMapResourceDirs } from '../services/resources.js';
import { createWorkspaceFs, createToolRegistry, createBuiltinTools, createNativeToolProtocol, createTextToolProtocol, PathLock, ReadTracker } from '@saurio/runtime/tools/index';
import type { WorkspaceFs } from '@saurio/runtime/tools/types';
import { DefaultPermissionEngine } from '@saurio/runtime/permissions/engine';
import { PermissionMemory } from '@saurio/runtime/permissions/memory';
import { FileBlobStore, FsCheckpointService, createGitHeadReader } from '@saurio/runtime/checkpoint/index';
import {
  createContextBuilder, createTokenEstimator, createCompactor, EngineRepoMapClient,
  configureRepoMapResources, COMPACTION_SUMMARY_SCHEMA, type Summarizer, type CompactionSummary,
} from '@saurio/runtime/context/index';
import { DefaultTaskManager } from '@saurio/runtime/tasks/TaskManager';
import { RunController } from '@saurio/runtime/agent/RunController';
import {
  createDefaultAgentConfig, DEFAULT_AGENT_ID, DEFAULT_MODEL_REF, DEFAULT_TOOL_TRANSPORT_OVERRIDES,
  defaultIdGenerator, systemClock, resolveModelSelection,
} from '@saurio/runtime/agent/index';
import type { RunControllerDeps } from '@saurio/runtime/agent/RunController';
import type { AgentMemoryPort, LastReadHashes, ModelContextProbe, ModelLayerCountProbe, ModelParameterSizeProbe, ModelVisionProbe } from '@saurio/runtime/agent/ports';
import type { DefaultNumCtxFor } from '@saurio/runtime/agent/defaults';
import { recover as recoverRuns, type RecoverResult } from '@saurio/runtime/agent/recover';
import { ensurePersonalProject } from '@saurio/runtime/agent/personalProject';
import type { AgentMemory, AgentProfile, ModelRef, Project, ProviderConfig, ProviderPreset } from '@saurio/shared';
import { LOCAL_ONLY_SETTINGS_KEY, NUM_CTX_SETTINGS_KEY, isNumCtxDefaults, maximumContextOrFallback } from '@saurio/shared';
import type { HostAdapter } from './RuntimeHost.js';
import { BroadcastEventStore } from './BroadcastEventStore.js';

/** URL de Ollama en modo attach (doc 13 §6): el servidor ya corre en la máquina del usuario.
 *  `SAURIO_OLLAMA_URL` (tarea "carga de modelo/oom_load" punto 5, solo para pruebas): apunta la app
 *  a un puerto vacío (p. ej. `http://127.0.0.1:11999`) para simular "Ollama apagado" de verdad sin
 *  tocar una instancia real que pueda estar corriendo en esta máquina (útil cuando esta sesión de
 *  trabajo comparte el equipo con otro proceso que sí depende de Ollama real en 11434). */
export const OLLAMA_BASE_URL = process.env['SAURIO_OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
const LOCAL_INFERENCE_SETTING_KEY = 'resources.localInference';
const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

type AgentProfileReader = Pick<{ getProfile(id: string): Promise<AgentProfile | undefined> }, 'getProfile'>;
type AgentMemoryReader = {
  list(agentId: string, projectId?: string, options?: { includeGlobal?: boolean }): Promise<AgentMemory[]>;
};

/** Aplica la política persistida del perfil antes de que el runtime arme el prompt. El controlador
 * recibe solamente memorias ya autorizadas y por eso no puede mezclar proyectos por error. */
export function createAgentMemoryPort(
  profiles: AgentProfileReader,
  memories: AgentMemoryReader,
): AgentMemoryPort {
  return {
    async listForRun(agentId, projectId) {
      const profile = await profiles.getProfile(agentId);
      if (profile?.memoryScope === 'project') {
        if (!profile.projectId || profile.projectId !== projectId) return [];
        return memories.list(agentId, projectId, { includeGlobal: false });
      }
      // Legacy sin policy explícita conserva el filtro histórico del repositorio: global + proyecto actual.
      return memories.list(agentId, projectId);
    },
  };
}

/** Defensa del lado main: la UI valida sliders/radios, pero el valor persistido sigue siendo
 * `unknown`. Sólo enteros positivos llegan a Ollama; CPU fuerza num_gpu=0 y auto lo omite. */
export function parseLocalInferenceOptions(value: unknown): LocalChatOptions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const numThreads = typeof record['numThreads'] === 'number'
    && Number.isInteger(record['numThreads']) && record['numThreads'] > 0
    ? record['numThreads'] : undefined;
  const numGpu = record['computeMode'] === 'cpu' ? 0 : undefined;
  return numThreads === undefined && numGpu === undefined ? undefined : { numThreads, numGpu };
}

/** La caché del catálogo cambia junto con la configuración y la credencial del proveedor. Sólo se
 * persiste el hash; la clave real no entra en SQLite ni en el nombre legible del ajuste. */
export function providerCatalogStorageKey(provider: StoredProvider | undefined, apiKey: string | undefined): string {
  const providerId = provider?.id ?? 'missing';
  const identity = JSON.stringify({
    kind: provider?.kind, baseUrl: provider?.baseUrl, headers: provider?.headers, mode: provider?.mode,
  });
  const digest = createHash('sha256').update(identity).update('\0').update(apiKey ?? '').digest('hex').slice(0, 24);
  return `models.providerCatalog.${providerId}.${digest}`;
}

export function measuredFitClass(
  evidence: Pick<ModelCompatRecord, 'status' | 'offloadRatio' | 'size' | 'sizeVram' | 'error'>,
) {
  if (evidence.status === 'partial') return 'partial_offload' as const;
  if (evidence.status === 'failed') {
    return evidence.error && /out of memory|cudaMalloc|model is too large|insufficient memory|not enough memory|cannot allocate memory/i.test(evidence.error)
      ? 'no_fit' as const
      : undefined;
  }
  if (evidence.offloadRatio !== null && Number.isFinite(evidence.offloadRatio)
    && evidence.offloadRatio >= 0 && evidence.offloadRatio <= 1) {
    return evidence.offloadRatio < 1 ? 'partial_offload' as const : 'fits_gpu' as const;
  }
  if (evidence.size !== null && evidence.sizeVram !== null
    && Number.isFinite(evidence.size) && Number.isFinite(evidence.sizeVram)
    && evidence.size > 0 && evidence.sizeVram > 0) {
    return evidence.sizeVram < evidence.size ? 'partial_offload' as const : 'fits_gpu' as const;
  }
  return undefined;
}

export function testedSpeedFromCompat(evidence: ModelCompatRecord | undefined) {
  if (evidence?.status !== 'fits' || evidence.genTps === null
    || !Number.isFinite(evidence.genTps) || evidence.genTps <= 0) return undefined;
  return { tokPerSec: evidence.genTps, testedAt: evidence.testedAt };
}

export async function withProviderDeadline<T>(
  label: string, operation: (signal: AbortSignal) => Promise<T>, timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} tardó demasiado en responder.`));
      }, timeoutMs);
    });
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Presets con baseUrl por defecto (punto 2 del encargo: "Presets con baseUrl por defecto"). Doc 18
 *  §1/§2: OpenAI/OpenRouter hablan el dialecto `/v1/chat/completions` (`OpenAICompatProvider`, mismo
 *  provider que LM Studio/llama.cpp/vLLM/Groq con baseUrl libre); Anthropic es `kind: 'cloud'` puro. */
export const PROVIDER_PRESET_DEFAULTS: Record<Exclude<ProviderPreset, 'custom'>, { kind: Provider['kind']; baseUrl: string; label: string }> = {
  ollama: { kind: 'ollama', baseUrl: OLLAMA_BASE_URL, label: 'Ollama (local)' },
  openai: { kind: 'openai-compat', baseUrl: 'https://api.openai.com', label: 'OpenAI' },
  openrouter: { kind: 'openai-compat', baseUrl: 'https://openrouter.ai/api', label: 'OpenRouter' },
  anthropic: { kind: 'cloud', baseUrl: 'https://api.anthropic.com', label: 'Anthropic' },
};

/** Sin `SecureKeyStore` real inyectado (tests, o un SO sin backend de cifrado): nunca guarda nada y
 *  siempre reporta "no disponible" — nunca cae a guardar en claro (punto 1 del encargo). */
export function createUnavailableSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('safeStorage no disponible'); },
    decryptString: () => { throw new Error('safeStorage no disponible'); },
  };
}

function instantiateProvider(row: StoredProvider, secureKeyStore: SecureKeyStore, ollama: OllamaProvider): Provider {
  if (row.id === OLLAMA_PROVIDER_ID) return ollama;
  const getApiKey = async (): Promise<string | undefined> => secureKeyStore.get(row.id);
  if (row.kind === 'ollama') return new OllamaProvider({ id: row.id, baseUrl: row.baseUrl });
  if (row.kind === 'cloud') return new AnthropicProvider({ id: row.id, baseUrl: row.baseUrl, getApiKey });
  return new OpenAICompatProvider({ id: row.id, baseUrl: row.baseUrl, getApiKey, headers: row.headers });
}

/** Reconstruye la lista de `Provider` activos a partir de lo persistido en `providers` (punto 2 del
 *  encargo: "cableá ModelGatewayImpl con la lista real de providers configurados"). Providers
 *  deshabilitados quedan afuera de `chat()`/`models:list`, pero siguen listados por `providers:list`
 *  (con `enabled: false`) para que la UI los pueda reactivar sin volver a pegar la clave. */
function buildEnabledProviders(repo: SqlProvidersRepository, keyStore: SecureKeyStore, ollama: OllamaProvider): Provider[] {
  return repo.list().filter((row) => row.enabled).map((row) => instantiateProvider(row, keyStore, ollama));
}

/** Piezas compartidas por toda la app, independientes del proyecto abierto. */
export interface GlobalRuntime {
  persistence: PersistenceHandle;
  events: BroadcastEventStore;
  readonly providers: Provider[];
  gateway: ModelGatewayImpl;
  modelManager: ModelManager;
  hardwareProbe: HardwareProbe;
  metrics: MetricsAggregator;
  diagnostics: Diagnostics;
  downloadManager: DownloadManager;
  /** [] si `resources/model-catalog.json` no se pudo resolver/leer (dev roto o empaquetado sin
   *  `extraResources`, ver services/resources.ts); el Centro de modelos lo trata como catálogo vacío,
   *  nunca como error fatal de arranque. */
  modelCatalog: ModelCatalogEntry[];
  recommendationEngine: RecommendationEngine;
  /** Cobertura máxima del catálogo (doc 16 §12.6, puntos 1-3 del encargo): biblioteca completa de
   *  Ollama (caché en userData con TTL 24h, fallback al snapshot empaquetado sin red) y búsqueda de
   *  Hugging Face GGUF. Cambio aditivo mínimo en este archivo compartido (zona de models: ipc/models.ts
   *  y packages/runtime/src/models/**, documentado acá igual que el resto de las piezas de `models`
   *  ya cableadas más abajo). */
  ollamaLibraryClient: OllamaLibraryClient;
  huggingFaceClient: HuggingFaceClient;
  /** Ajustes > Proveedores (punto 3 del encargo): CRUD real sobre `providers` + almacén seguro de
   *  claves + auditoría de llamadas no locales (punto 4). Expuestos acá para que
   *  apps/desktop/src/main/ipc/providers.ts no tenga que reconstruir nada. */
  providersRepository: SqlProvidersRepository;
  secureKeyStore: SecureKeyStore;
  auditLog: SqlAuditLogRepository;
  downloadsRepository: SqlDownloadsRepository;
  /** Reconstruye `providers`/`gateway`/`modelManager` desde `providersRepository` tras un
   *  agregar/editar/quitar/habilitar-deshabilitar (`providers:add|update|remove`). En caliente, sin
   *  reiniciar la app (`ModelGatewayImpl.setProviders`/`ModelManager.setProviders`, cambios aditivos
   *  de esta misma tarea en packages/runtime). */
  refreshProviders(): void;
  /** `ProviderConfig[]` listo para cruzar IPC (`providers:list`): une `providersRepository` (datos)
   *  con `secureKeyStore` (hasApiKey/last4, nunca la clave real) y la `locality` real que cada
   *  `Provider` ya calculó (evita reimplementar `classifyLocality`, doc 18 §1). */
  listProviderConfigs(): ProviderConfig[];
  /** "Probar conexión" (punto 3 del encargo): `health()` + `listModels()` reales contra el provider
   *  YA GUARDADO (por eso toma un id, no una config suelta — se prueba lo que quedó persistido,
   *  incluida la clave real recién guardada). No cambia `enabled` ni nada persistido. */
  testProvider(id: string): Promise<import('@saurio/shared').ProviderTestResult>;
}

/** Piezas ligadas a la raíz del proyecto abierto (workspace, checkpoints, tools, run loop). */
export interface ProjectRuntime {
  projectId: string;
  projectRoot: string;
  runController: RunController;
  checkpointService: FsCheckpointService;
  repoMap: EngineRepoMapClient;
  /** Expuesto para `files:tree`/`files:read` (punto 1 del encargo): mismo `WorkspaceFs` confinado
   *  y con la misma resolución de .gitignore/.saurioignore que usan las tools del agente, para que
   *  el árbol de archivos de la UI nunca vea nada que las tools tampoco verían. */
  workspaceFs: WorkspaceFs;
}

/** Callbacks reales de DownloadManager (doc 13 §5.6, punto 1 del encargo): "cargado" viene del único
 *  poller de /api/ps (ModelManager, nunca un poll propio); "ocupado" viene de la cola del
 *  InferenceScheduler (ModelGateway.status()) — es la única intervención del Scheduler en el Centro
 *  de modelos, tal como fija doc 13 §5 punto 6. */
function makeDownloadCallbacks(modelManager: ModelManager, gateway: ModelGatewayImpl) {
  return {
    isLoaded: async (modelName: string): Promise<boolean> => {
      const loaded = await modelManager.listLoaded().catch(() => []);
      return loaded.some((m) => m.name === modelName);
    },
    isBusy: async (modelName: string): Promise<boolean> => {
      const { slots, queue } = gateway.status();
      const queued = queue.some((job) => job.ref.name === modelName);
      const busySlot = slots.some((slot) => slot.state === 'busy' && slot.currentModel?.name === modelName);
      return queued || busySlot;
    },
  };
}

export function createGlobalRuntime(
  hostAdapter: HostAdapter,
  deps: {
    ollamaBaseUrl?: string;
    managedModelsFolder?: string;
    readResourceFile?: typeof readResourceFile;
    secureKeyStore?: SecureKeyStore;
    /** Tarea "carga de modelo/oom_load" punto 4: fuente real de la línea `msg="inference compute"`
     *  que `ollama serve` loguea por dispositivo — `main/index.ts` la arma envolviendo
     *  `OllamaProcessManager.readInferenceComputeLine()` (log propio en `userData/logs/` o, en modo
     *  attach, `%LOCALAPPDATA%\Ollama\server.log` en solo lectura). Opcional: sin esto, `HardwareProbe`
     *  sigue el comportamiento previo (nvidia-smi -> registro de Windows, sin esta fuente adicional).
     */
    inferenceComputeSource?: HardwareProbeOptions['inferenceComputeSource'];
  } = {},
): GlobalRuntime {
  const readResource = deps.readResourceFile ?? readResourceFile;

  // Punto 5 del encargo (doc 16): inyecta las carpetas reales de grammars .wasm / queries .scm en
  // @saurio/repomap ANTES de que cualquier ProjectRuntime indexe un proyecto — reemplaza la
  // derivación vía `import.meta.url` que se rompía en el build empaquetado (electron-vite bundlea
  // todo `apps/desktop/src/main/**`, incluido @saurio/repomap, en un único `out/main/index.js`).
  configureRepoMapResources(resolveRepoMapResourceDirs({
    appPath: hostAdapter.paths.appPath, resourcesPath: hostAdapter.paths.resourcesPath,
  }));

  const persistence = openPersistence(hostAdapter.paths.dbPath);
  const events = new BroadcastEventStore(persistence.eventStore);

  const providersRepository = new SqlProvidersRepository(persistence.driver);
  const secureKeyStore = deps.secureKeyStore
    ?? new SecureKeyStore(path.join(hostAdapter.paths.userDataDir, 'provider-keys.enc.json'), createUnavailableSafeStorage());

  // ADR-2: se habla el HTTP de Ollama directamente (fetch + NDJSON propio), nunca el cliente npm.
  seedOllamaProviderRow(persistence.driver, OLLAMA_PROVIDER_ID, deps.ollamaBaseUrl ?? OLLAMA_BASE_URL);
  const ollama = new OllamaProvider({ id: OLLAMA_PROVIDER_ID,
    baseUrl: deps.ollamaBaseUrl ?? providersRepository.get(OLLAMA_PROVIDER_ID)?.baseUrl ?? OLLAMA_BASE_URL });
  if (deps.ollamaBaseUrl) providersRepository.update(OLLAMA_PROVIDER_ID, { baseUrl: deps.ollamaBaseUrl });

  const auditLog = new SqlAuditLogRepository(persistence.driver);

  let currentProviders: Provider[] = buildEnabledProviders(providersRepository, secureKeyStore, ollama);

  // MEDIDO 2026-09-18 (RTX 3060 Ti, 8 GiB): un solo modelo de 7-8B con num_ctx 8192 ya ocupa
  // ~5-6 GiB de VRAM, así que el scheduler tiene UN slot (doc 08 §7.1, VRAM < 24 GiB).
  const gateway = new ModelGatewayImpl(currentProviders, { slots: 1, groupByModel: true }, {
    // Punto 4 del encargo ("registrar en audit_log cada llamada no local"): único punto por el que
    // pasa TODA llamada de inferencia no local, sin importar quién la haya iniciado (chat normal,
    // compactación nivel 2, etc.) — el hook de resultado conserva costo reportado/estimado y marca
    // como desconocidas las llamadas cortadas, sin inventar cero.
    onNonLocalResult: (ref, result) => {
      auditLog.recordNonLocalResult({
        providerId: ref.providerId,
        modelName: ref.name,
        locality: ref.locality,
        runId: result.runId,
        callId: result.callId,
        ts: Date.now(),
        metrics: result.metrics,
        error: result.error,
        interrupted: result.interrupted,
      });
    },
    resolveLocalChatOptions: async () => parseLocalInferenceOptions(
      await persistence.repositories.settings.get(LOCAL_INFERENCE_SETTING_KEY),
    ),
    // Se evalúa por llamada, no al crear el chat/runtime: activar "Solo local" debe cortar también
    // chats cloud existentes, continuaciones, regeneraciones, delegaciones y compactaciones.
    isLocalOnlyEnabled: async () =>
      await persistence.repositories.settings.get(LOCAL_ONLY_SETTINGS_KEY) === true,
  });

  const hardwareProbe = new HardwareProbe({ inferenceComputeSource: deps.inferenceComputeSource });
  const modelManager = new ModelManager(currentProviders, hardwareProbe, {
    modelLoadSamplesRepository: persistence.repositories.modelLoadSamples,
    catalogStorage: persistence.repositories.settings,
    catalogStorageKey: (providerId) => providerCatalogStorageKey(
      providersRepository.get(providerId), secureKeyStore.get(providerId),
    ),
  });
  modelManager.setManagedModelsFolder(deps.managedModelsFolder);

  function refreshProviders(): void {
    ollama.setBaseUrl(providersRepository.get(OLLAMA_PROVIDER_ID)?.baseUrl ?? OLLAMA_BASE_URL);
    currentProviders = buildEnabledProviders(providersRepository, secureKeyStore, ollama);
    gateway.setProviders(currentProviders);
    modelManager.setProviders(currentProviders);
  }

  async function testProvider(id: string) {
    const row = providersRepository.get(id);
    if (!row) return { providerId: id, ok: false, error: `no existe ningún provider con id "${id}"` };
    try {
      const provider = instantiateProvider(row, secureKeyStore, ollama);
      const health = await withProviderDeadline(`El proveedor "${id}"`, (signal) => provider.health(signal));
      if (!health.ok) return { providerId: id, ok: false, error: health.error ?? 'health() devolvió ok: false', version: health.version };
      const models = await withProviderDeadline(
        `El catálogo del proveedor "${id}"`, (signal) => provider.listModels(signal),
      ).catch(() => []);
      return { providerId: id, ok: true, version: health.version, modelNames: models.map((m) => m.ref.name) };
    } catch (error) {
      return { providerId: id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function listProviderConfigs(): ProviderConfig[] {
    return providersRepository.list().map((row) => {
      const live = currentProviders.find((p) => p.id === row.id);
      // Provider deshabilitado -> no está instanciado en `currentProviders`; se instancia uno de paso
      // solo para leer `.locality` (no se usa para chatear, no se guarda) — evita reimplementar
      // `classifyLocality` (doc 18 §1) acá para el caso "deshabilitado".
      const locality = live?.locality ?? instantiateProvider(row, secureKeyStore, ollama).locality;
      return toProviderConfig(row, locality, secureKeyStore.has(row.id), secureKeyStore.last4(row.id));
    });
  }

  const downloadCallbacks = makeDownloadCallbacks(modelManager, gateway);
  const downloadsRepository = new SqlDownloadsRepository(persistence.driver);
  const downloadProvider = withHuggingFaceImports(ollama as unknown as DownloadProvider, {
    ollamaBaseUrl: () => providersRepository.get(OLLAMA_PROVIDER_ID)?.baseUrl ?? deps.ollamaBaseUrl ?? OLLAMA_BASE_URL,
    stagingRoot: path.join(hostAdapter.paths.userDataDir, 'downloads', 'hf-staging'),
  });
  const downloadManager = new DownloadManager(downloadProvider, {
    manifestFetcher: new RegistryClient(),
    blobStore: new FsBlobStoreProbe(),
    diskSpace: new FsDiskSpaceProbe(),
    modelsFolder: async () => (await modelManager.detectedModelsFolder()).path,
    repository: downloadsRepository,
    isLoaded: downloadCallbacks.isLoaded,
    isBusy: downloadCallbacks.isBusy,
  });

  const catalogJson = readResource('model-catalog.json', {
    appPath: hostAdapter.paths.appPath,
    resourcesPath: hostAdapter.paths.resourcesPath,
  });
  const modelCatalog: ModelCatalogEntry[] = catalogJson ? loadModelCatalog(catalogJson) : [];
  if (!catalogJson) {
    console.warn('[createRuntime] no se pudo leer resources/model-catalog.json; catálogo vacío (ver services/resources.ts)');
  }
  function isOllamaHttpError(error: unknown): error is Error & { code: string; status: number } {
    if (!(error instanceof Error) || error.name !== 'OllamaHttpError') return false;
    const candidate = error as Error & { code?: unknown; status?: unknown };
    return typeof candidate.code === 'string' && typeof candidate.status === 'number';
  }
  async function optionalOllamaEnrichment<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (isOllamaHttpError(error)) {
        const unavailable = new Error('El inventario local no está disponible para enriquecer recomendaciones.', { cause: error });
        Object.defineProperty(unavailable, Symbol.for('saurio.recommendation-enrichment-unavailable'), { value: true });
        throw unavailable;
      }
      throw error;
    }
  }
  async function compatibilityFor(entry: ModelCatalogEntry, hardwareFingerprint: string) {
    if (!hardwareFingerprint) return undefined;
    const expectedName = `${entry.name}:${entry.tag}`;
    const installed = (await optionalOllamaEnrichment(() => modelManager.listInstalled())).find((model) =>
      model.ref.locality === 'local' && model.ref.name === expectedName && model.digest);
    if (!installed?.digest) return undefined;
    const description = await optionalOllamaEnrichment(() => modelManager.describeModel(installed.ref));
    const contextUsed = description.contextMax;
    if (!contextUsed || contextUsed <= 0) return undefined;
    const evidence = await persistence.repositories.modelCompat.latest({
      providerId: installed.ref.providerId, modelName: installed.ref.name, modelDigest: installed.digest,
      hardwareFingerprint, numCtx: contextUsed,
    });
    return { installed, contextUsed, evidence };
  }

  const recommendationEngine = new RecommendationEngine(modelCatalog, {
    async lookup(entry, hardwareFingerprint) {
      const resolved = await compatibilityFor(entry, hardwareFingerprint);
      const evidence = resolved?.evidence;
      // Una carga o un resultado sin throughput no se convierte en badge "probado". El último
      // resultado exacto debe ser exitoso y tener velocidad realmente medida.
      return testedSpeedFromCompat(evidence);
    },
  }, {
    async fitClassFor(entry, _catalogContextMax, hardwareFingerprint) {
      const resolved = await compatibilityFor(entry, hardwareFingerprint);
      if (resolved?.evidence) {
        const fitClass = measuredFitClass(resolved.evidence);
        if (fitClass) return { fitClass, fitQuality: 'measured' as const, contextUsed: resolved.contextUsed };
      }
      const expectedName = `${entry.name}:${entry.tag}`;
      const installed = (await optionalOllamaEnrichment(() => modelManager.listInstalled())).find((model) =>
        model.ref.locality === 'local' && model.ref.name === expectedName);
      if (!installed) return undefined;
      const description = await optionalOllamaEnrichment(() => modelManager.describeModel(installed.ref));
      const contextUsed = description.contextMax;
      if (!contextUsed || contextUsed <= 0) return undefined;
      const estimate = await optionalOllamaEnrichment(() => modelManager.fits(installed.ref, contextUsed));
      return { fitClass: estimate.fitClass, fitQuality: 'estimated', contextUsed };
    },
  });

  // Punto 2 del encargo (doc 16 §12.6): snapshot empaquetado como último fallback sin red y sin
  // ninguna caché en userData todavía (primera vez que se abre la app sin conexión) — best-effort,
  // nunca fatal si falta o no parsea (empaquetado sin `extraResources`, o un `resources/` de dev roto,
  // mismo criterio que `modelCatalog` arriba).
  const snapshotJson = readResource('model-catalog.snapshot.json', {
    appPath: hostAdapter.paths.appPath,
    resourcesPath: hostAdapter.paths.resourcesPath,
  });
  let bundledSnapshot;
  try {
    bundledSnapshot = snapshotJson ? loadOllamaLibrarySnapshot(snapshotJson) : undefined;
  } catch (error) {
    console.warn('[createRuntime] resources/model-catalog.snapshot.json no parsea; sin fallback empaquetado', error);
  }
  const ollamaLibraryClient = new OllamaLibraryClient({
    cache: new FileLibraryCache(path.join(hostAdapter.paths.userDataDir, 'model-library-cache.json')),
    bundledSnapshot,
  });
  const huggingFaceClient = new HuggingFaceClient();

  return {
    persistence,
    events,
    get providers() { return currentProviders; },
    gateway,
    modelManager,
    hardwareProbe,
    metrics: new MetricsAggregator(),
    diagnostics: new Diagnostics(),
    downloadManager,
    modelCatalog,
    recommendationEngine,
    ollamaLibraryClient,
    huggingFaceClient,
    providersRepository,
    secureKeyStore,
    auditLog,
    downloadsRepository,
    refreshProviders,
    listProviderConfigs,
    testProvider,
  };
}

/** Lee `models.numCtxDefaults` (settings, scope global) una sola vez y arma un lookup síncrono
 *  por nombre de modelo — compartido por `makeNumCtxForModel` (override en vivo, por run) y por el
 *  `defaultNumCtxFor` que se le pasa a `createDefaultAgentConfig` al sembrar el agente builtin
 *  (§9.6/§10.5 de doc 16: mismo dato, dos consumidores distintos). */
async function loadNumCtxDefaults(runtime: GlobalRuntime): Promise<Record<string, number> | undefined> {
  const repo = runtime.persistence.repositories.settings;
  if (!repo) return undefined;
  const raw = await repo.get(NUM_CTX_SETTINGS_KEY, undefined).catch(() => undefined);
  return isNumCtxDefaults(raw) ? raw : undefined;
}

/** Migraciones ya corrieron en `openPersistence`; acá se siembra el agente builtin y se recuperan
 *  los runs que quedaron abiertos por un cierre inesperado (doc 10 §5.1-§5.4). El `defaultNumCtxFor`
 *  (doc 16 §9.6/§10.5, punto 1 del encargo) deriva el `ContextPolicy` de SEED del agente builtin desde
 *  `models.numCtxDefaults` en vez del literal fijo 8192 — sin preferencia guardada para
 *  `DEFAULT_MODEL_REF`, el comportamiento es exactamente el previo. */
/** PRIORIDAD CERO punto 6 (bloqueo real reportado en OTRO equipo del usuario, sin qwen3:8b instalado
 *  — solo gemma3:26b/31b, demasiado grandes para esa notebook): antes se sembraba el agente builtin
 *  SIEMPRE con `DEFAULT_MODEL_REF` (`qwen3:8b`, medido en el equipo de referencia de este repo, doc
 *  16), sin importar qué haya instalado el usuario real. `qwen3:8b` sigue existiendo como ÚLTIMO
 *  recurso (si Ollama no responde todavía en este boot, o no hay ningún modelo instalado) para que la
 *  fila del agente builtin tenga algún `model` con el que satisfacer la FK — no es una promesa de que
 *  ese modelo esté instalado ni se usa para decidir qué mostrarle al usuario como modelo del próximo
 *  chat (eso lo resuelve la UI consultando `models:list` directamente, `layout/Sidebar.tsx`). Best
 *  effort real: si `ModelManager.listInstalled()` responde con algo, se usa el primero. */
async function pickSeedModelRef(runtime: GlobalRuntime): Promise<ModelRef> {
  try {
    const installed = await runtime.modelManager.listInstalled();
    if (installed.length > 0) return installed[0]!.ref;
  } catch {
    // Ollama no responde todavía en este boot (doc PRIORIDAD CERO punto 1: puede estar arrancando
    // recién ahora) — se cae al último recurso de abajo; el agente builtin de todas formas no es lo
    // que decide el modelo del próximo chat (ver comentario de la función).
  }
  return DEFAULT_MODEL_REF;
}

export async function initGlobalRuntime(runtime: GlobalRuntime, defaultWorkingDir: string): Promise<RecoverResult> {
  const { repositories } = runtime.persistence;
  const existing = await repositories.agents.get(DEFAULT_AGENT_ID);
  if (!existing) {
    const numCtxDefaults = await loadNumCtxDefaults(runtime);
    const defaultNumCtxFor: DefaultNumCtxFor = (ref) => {
      const value = numCtxDefaults?.[ref.name];
      return typeof value === 'number' && value > 0 ? value : undefined;
    };
    const seedModel = await pickSeedModelRef(runtime);
    await repositories.agents.save(createDefaultAgentConfig(defaultWorkingDir, seedModel, defaultNumCtxFor), true);
  }
  // Doc 19 §0 (E2a "Mis agentes"): proyecto personal sintético, creado una sola vez, para que un chat
  // directo con un agente personal fuera de cualquier proyecto abierto tenga dónde vivir sin relajar
  // `chats.project_id NOT NULL`. Idempotente (no-op en arranques posteriores).
  await ensurePersonalProject(repositories.projects);
  return recoverRuns({
    runs: repositories.runs,
    toolCalls: repositories.toolCalls,
    messages: repositories.messages,
    checkpoints: repositories.checkpoints,
    events: runtime.events,
    clock: systemClock,
  });
}

/** Resumen real de compactación de nivel 2 (doc 07 §7.3) contra `ModelGateway.chat` real. Mismo
 *  cableado que `eval/harness.ts` (`makeRealSummarizer`) — se replica acá en vez de importarlo porque
 *  `eval/` no es un paquete del workspace, y porque este archivo (apps/desktop) es el lugar que doc 16
 *  §7.4 ya señalaba como pendiente ("createRuntime.ts construye ContextBuilder sin Compactor"). */
function makeRealSummarizer(runtime: GlobalRuntime): Summarizer {
  return {
    async summarize({ candidates, model }): Promise<CompactionSummary> {
      const controller = new AbortController();
      let content = '';
      for await (const chunk of runtime.gateway.chat(
        model,
        {
          model: model.name,
          messages: [
            {
              id: 'sys-summarizer', role: 'system',
              content: 'Resumí la conversación en el JSON pedido por el schema. Sé breve y concreto; no agregues texto fuera del JSON.',
            },
            ...candidates.map((c) => ({ id: c.id, role: c.role, content: c.content })),
          ],
          options: { numCtx: 8192, temperature: 0.1, numPredict: 500 },
          format: COMPACTION_SUMMARY_SCHEMA as unknown as object,
          think: false,
        },
        { runId: 'desktop-summarizer', signal: controller.signal, authorizedLocality: [model.locality], priority: 'interactive' },
      )) {
        if (chunk.type === 'content') content += chunk.text;
        else if (chunk.type === 'error') throw new Error(`summarizer: ${chunk.message}`);
      }
      return JSON.parse(content) as CompactionSummary;
    },
  };
}

/** Tarea "carga de modelo/oom_load": busca `<arch>.block_count` en el bag crudo de `/api/show`
 *  (`ModelDescription.modelInfo`) — mismo dato que `mapModelDescription`/`extractContextMax` de
 *  `gateway/providers/ollama/mappers.ts` ya leen para `contextMax`, pero esa utilidad no está
 *  exportada y ese módulo no es zona de esta tarea para agregarle una exportación nueva; se
 *  reimplementa acá, chica y sola. `undefined` si no está presente (versión vieja de Ollama, modelo
 *  sin esa clave) — nunca inventa un valor. */
function extractBlockCount(modelInfo: Record<string, unknown> | undefined): number | undefined {
  if (!modelInfo) return undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.block_count') && typeof value === 'number') return value;
  }
  return undefined;
}

/** Política de contexto: el máximo declarado se consulta para cada modelo al iniciar el run.
 *  Ante metadatos ausentes se usa un presupuesto provisional, visible como tal en Ajustes.
 *  Las preferencias manuales antiguas se conservan en la base pero ya no limitan el run. */
function makeNumCtxForModel(runtime: GlobalRuntime): (ref: ModelRef) => Promise<number | undefined> {
  return async (ref) => {
    const description = await runtime.modelManager.describeModel(ref).catch(() => undefined);
    return maximumContextOrFallback(description?.contextMax);
  };
}

/** Construye todo lo que depende de la raíz del proyecto: WorkspaceFs, las 10 builtins, el motor de
 *  permisos, checkpoints sobre `appData/blobs`, el ContextBuilder con el repo map real (+ Compactor,
 *  doc 16 §7.4) y el RunController que los orquesta (doc 05 §2), con `permissionMemory`/
 *  `modelContextProbe`/`numCtxForModel` cableados (punto 5 del encargo — doc 16 §5 los marcaba
 *  "pendiente de wireo en apps/desktop"; la lógica en sí ya estaba implementada y probada contra
 *  Ollama real vía eval/harness.ts, este archivo reproduce ese mismo cableado para la app real). */
export function createProjectRuntime(
  runtime: GlobalRuntime,
  hostAdapter: HostAdapter,
  project: Project,
): ProjectRuntime {
  const { repositories } = runtime.persistence;
  const projectRoot = project.path;

  const workspaceFs = createWorkspaceFs(projectRoot);

  // ToolRegistry con las 10 builtins (doc 04 §4). ReadTracker y PathLock se comparten entre todas
  // para que edit_file/write_file/delete_file se serialicen por path (doc 09 §3.3). `readTracker`
  // también se pasa como `RunControllerDeps.readHashes` (mismo patrón que eval/harness.ts,
  // `buildEnhancedRunController`): así `RunController.executeOneToolCall` completa
  // `tool_calls.expected_pre_hash` con el último hash que ESTE proceso vio, y `expectedPreHash`
  // (abajo) lo relee de SQLite (no de este mismo `ReadTracker`) para que el chequeo de conflicto
  // sobreviva a un reinicio real (doc 16 §4 ítem 16 / doc 10 §3, §5.2 — punto 1 del encargo).
  const readTracker = new ReadTracker();
  const tools = createToolRegistry();
  const builtins = createBuiltinTools({
    toolOutputsDir: hostAdapter.paths.toolOutputsDir,
    readTracker,
    pathLock: new PathLock(),
    expectedPreHash: { async get(toolCallId) { return (await repositories.toolCalls.get(toolCallId))?.expectedPreHash; } },
  });
  for (const tool of builtins) tools.register(tool);

  const blobStore = new FileBlobStore(hostAdapter.paths.blobsDir, repositories.blobRefs);
  const checkpointService = new FsCheckpointService({
    projectRoot,
    blobStore,
    store: repositories.checkpointStore,
    resolveChatId: async (runId) => {
      const run = await repositories.runs.get(runId);
      if (!run) throw new Error(`saurio: no se puede checkpointear un run inexistente ("${runId}")`);
      return run.chatId;
    },
    // Doc 09 §2.2/§5.3 (RevertPlan.branchChanged/uncoveredEffects, punto 1 del encargo): `gitHead`
    // detecta si la rama/HEAD cambiaron desde el checkpoint (o queda `undefined` sin `.git`, nunca
    // lanza — `createGitHeadReader`); `toolCalls` alimenta `uncoveredEffects` con los `run_command`
    // reales del run revertido. Mismo cableado que `eval/harness.ts` ya probaba contra Ollama real.
    gitHead: createGitHeadReader(),
    toolCalls: repositories.toolCalls,
  });

  const repoMap = new EngineRepoMapClient();
  const tokenEstimator = createTokenEstimator(DEFAULT_MODEL_REF);
  const compactor = createCompactor(tokenEstimator, makeRealSummarizer(runtime));
  const context = createContextBuilder(tokenEstimator, compactor);

  const permissionMemory = new PermissionMemory(
    repositories.permissionRules, repositories.permissionDecisions,
    () => defaultIdGenerator.next(), systemClock,
  );
  const modelContextProbe: ModelContextProbe = {
    async getContextMax(ref) {
      const desc = await runtime.modelManager.describeModel(ref);
      return desc.contextMax;
    },
  };
  // Tarea "carga de modelo/oom_load": `RunController.handleOomLoad` necesita `block_count` real
  // para poder reintentar con ~75%/~50% de las capas en GPU en vez de saltar directo a CPU. Mismo
  // criterio que `modelContextProbe` de arriba: envuelve `ModelManager.describeModel` (público, ya
  // usado) en vez de tocar packages/runtime/src/models (fuera de esta zona).
  const modelLayerCountProbe: ModelLayerCountProbe = {
    async getBlockCount(ref) {
      const desc = await runtime.modelManager.describeModel(ref);
      return extractBlockCount(desc.modelInfo as Record<string, unknown> | undefined);
    },
  };
  // Punto 10 del encargo (feedback real v0.2.1: aviso de "modelo chico" en modo agente). Mismo
  // criterio que los dos probes de arriba.
  const modelParameterSizeProbe: ModelParameterSizeProbe = {
    async getParameterSize(ref) {
      const desc = await runtime.modelManager.describeModel(ref);
      return desc.parameterSize;
    },
  };
  // Punto 1c/9 del encargo (adjuntos de imagen): "SOLO si el modelo tiene capability vision".
  const modelVisionProbe: ModelVisionProbe = {
    async hasVision(ref) {
      const desc = await runtime.modelManager.describeModel(ref);
      return desc.capabilities.vision;
    },
  };

  const deps: RunControllerDeps = {
    gateway: runtime.gateway,
    tools,
    toolProtocols: { native: createNativeToolProtocol(), text: createTextToolProtocol() },
    permissions: new DefaultPermissionEngine(),
    checkpoints: checkpointService,
    context,
    taskManager: new DefaultTaskManager({ tasks: repositories.tasks, events: runtime.events, clock: systemClock }),
    events: runtime.events,
    runs: repositories.runs,
    chats: repositories.chats,
    messages: repositories.messages,
    toolCalls: repositories.toolCalls,
    checkpointRepo: repositories.checkpoints,
    agents: repositories.agents,
    agentMemories: createAgentMemoryPort(repositories.agents, repositories.agentMemories),
    chatCollaborators: {
      async listEnabled(chatId) {
        const chat = await repositories.chats.get(chatId);
        if (!chat || chat.projectId !== project.id) throw new Error('El chat no pertenece al proyecto activo.');
        const saved = await repositories.settings.get(`chat.collaborators.${chatId}`, project.id);
        const ids = Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === 'string'))].slice(0, 12) : [];
        const active = new Set((await repositories.agents.listProfiles()).map((profile) => profile.id));
        return Promise.all(ids.filter((id) => id !== chat.agentId && active.has(id)).map((id) => repositories.agents.resolve(id)));
      },
    },
    resolveModelRef: (agent, chatModelRef) => resolveModelSelection(agent, chatModelRef, {
      async listRecommendedRefs(candidateAgent) {
        const use = candidateAgent.role === 'coder' ? 'coding'
          : candidateAgent.role === 'lead' || candidateAgent.role === 'reviewer' || candidateAgent.role === 'explorer'
            || (candidateAgent.role === 'custom' && candidateAgent.systemPrompt?.startsWith('Sos Tester'))
            ? 'analysis' : 'chat';
        const [hardware, installed] = await Promise.all([
          runtime.hardwareProbe.sample(),
          runtime.modelManager.listInstalled(),
        ]);
        const installedByName = new Map(installed
          .filter((model) => model.ref.locality === 'local')
          .map((model) => [model.ref.name, model.ref]));
        const recommendations = await runtime.recommendationEngine.recommend(hardware, use, 'quality');
        return recommendations
          .filter((item) => item.locality === 'local' && item.catalogEntry.capabilities.tools)
          .flatMap((item) => {
            const ref = installedByName.get(`${item.catalogEntry.name}:${item.catalogEntry.tag}`);
            return ref ? [{ ref, contextMax: item.contextUsed ?? item.catalogEntry.contextMax }] : [];
          });
      },
      async listLoadedRefs() {
        const local = runtime.providers.filter((provider) => provider.locality === 'local' && provider.listLoaded);
        const results = await Promise.allSettled(local.map(async (provider) =>
          (await provider.listLoaded!()).map((loaded) => ({ providerId: provider.id, name: loaded.name, locality: provider.locality }))));
        return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
      },
      contextMaxForRef: async (ref) => (await runtime.modelManager.describeModel(ref)).contextMax,
      fits: (ref, numCtx) => runtime.modelManager.fits(ref, numCtx),
    }),
    // Doc 19 §2.5 (E3a delegación): `AgentRepository` ya implementa `AgentProfilePort.createProfile`
    // (packages/runtime/src/persistence/repositories/agent.ts) — se pasa el mismo repositorio, sin
    // adaptarlo, para que `delegate` sin `targetAgentId` pueda crear un worker efímero real.
    agentProfiles: repositories.agents,
    workspaceFs,
    clock: systemClock,
    ids: defaultIdGenerator,
    projectRoot,
    repoMap,
    toolTransportOverrides: DEFAULT_TOOL_TRANSPORT_OVERRIDES,
    permissionMemory,
    projectId: project.id,
    modelContextProbe,
    modelLayerCountProbe,
    modelParameterSizeProbe,
    modelVisionProbe,
    numCtxForModel: makeNumCtxForModel(runtime),
    readHashes: readTracker satisfies LastReadHashes,
  };

  return {
    projectId: project.id,
    projectRoot,
    runController: new RunController(deps),
    checkpointService,
    repoMap,
    workspaceFs,
  };
}
