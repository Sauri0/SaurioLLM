// Cableado real de @saurio/runtime para el proceso main — apps/desktop/src/main/host/createRuntime.ts.
// Define: doc 02 §1 (RuntimeHost "instancia @saurio/runtime"), doc 01 §4 (mapa de módulos) y la fase
// de integración del MVP. Este archivo es el ÚNICO lugar donde se construyen instancias concretas:
// persistence (migraciones + repositorios), gateway con OllamaProvider/OpenAICompatProvider/
// AnthropicProvider (punto 2 del encargo: providers reales configurados por el usuario, no solo
// Ollama), Scheduler de 1 slot, ToolRegistry con las 10 builtins, PermissionEngine, CheckpointService,
// ContextBuilder con el repo map de @saurio/repomap y un Compactor real, ModelManager, HardwareProbe
// y Telemetry.
import path from 'node:path';
import { openPersistence, type PersistenceHandle } from '@saurio/runtime/persistence/index';
import { ModelGatewayImpl, OllamaProvider, OpenAICompatProvider, AnthropicProvider } from '@saurio/runtime/gateway/index';
import type { Provider } from '@saurio/runtime/gateway/Provider';
import {
  HardwareProbe, ModelManager, DownloadManager, RegistryClient, FsBlobStoreProbe, FsDiskSpaceProbe,
  RecommendationEngine, loadModelCatalog,
} from '@saurio/runtime/models/index';
import type { ModelCatalogEntry, DownloadProvider } from '@saurio/runtime/models/index';
import { Diagnostics, MetricsAggregator } from '@saurio/runtime/telemetry/index';
import { SqlDownloadsRepository, seedOllamaProviderRow } from '../services/downloads/SqlDownloadsRepository.js';
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
  defaultIdGenerator, systemClock,
} from '@saurio/runtime/agent/index';
import type { RunControllerDeps } from '@saurio/runtime/agent/RunController';
import type { ModelContextProbe, LastReadHashes } from '@saurio/runtime/agent/ports';
import type { DefaultNumCtxFor } from '@saurio/runtime/agent/defaults';
import { recover as recoverRuns, type RecoverResult } from '@saurio/runtime/agent/recover';
import type { ModelRef, Project, ProviderConfig, ProviderPreset } from '@saurio/shared';
import { NUM_CTX_SETTINGS_KEY, isNumCtxDefaults } from '@saurio/shared';
import type { HostAdapter } from './RuntimeHost.js';
import { BroadcastEventStore } from './BroadcastEventStore.js';

/** URL de Ollama en modo attach (doc 13 §6): el servidor ya corre en la máquina del usuario. */
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

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
  deps: { readResourceFile?: typeof readResourceFile; secureKeyStore?: SecureKeyStore } = {},
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
  const ollama = new OllamaProvider({ id: OLLAMA_PROVIDER_ID, baseUrl: OLLAMA_BASE_URL });
  seedOllamaProviderRow(persistence.driver, ollama.id, OLLAMA_BASE_URL);

  const auditLog = new SqlAuditLogRepository(persistence.driver);

  let currentProviders: Provider[] = buildEnabledProviders(providersRepository, secureKeyStore, ollama);

  // MEDIDO 2026-09-18 (RTX 3060 Ti, 8 GiB): un solo modelo de 7-8B con num_ctx 8192 ya ocupa
  // ~5-6 GiB de VRAM, así que el scheduler tiene UN slot (doc 08 §7.1, VRAM < 24 GiB).
  const gateway = new ModelGatewayImpl(currentProviders, { slots: 1, groupByModel: true }, {
    // Punto 4 del encargo ("registrar en audit_log cada llamada no local"): único punto por el que
    // pasa TODA llamada de inferencia no local, sin importar quién la haya iniciado (chat normal,
    // compactación nivel 2, etc.) — hook aditivo agregado a ModelGatewayImpl en esta misma tarea.
    onNonLocalCall: (ref, ctx) => {
      auditLog.recordNonLocalCall({ providerId: ref.providerId, modelName: ref.name, locality: ref.locality, runId: ctx.runId, ts: Date.now() });
    },
  });

  const hardwareProbe = new HardwareProbe();
  const modelManager = new ModelManager(currentProviders, hardwareProbe);

  function refreshProviders(): void {
    currentProviders = buildEnabledProviders(providersRepository, secureKeyStore, ollama);
    gateway.setProviders(currentProviders);
    modelManager.setProviders(currentProviders);
  }

  async function testProvider(id: string) {
    const row = providersRepository.get(id);
    if (!row) return { providerId: id, ok: false, error: `no existe ningún provider con id "${id}"` };
    try {
      const provider = instantiateProvider(row, secureKeyStore, ollama);
      const health = await provider.health();
      if (!health.ok) return { providerId: id, ok: false, error: health.error ?? 'health() devolvió ok: false', version: health.version };
      const models = await provider.listModels().catch(() => []);
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
  const downloadManager = new DownloadManager(ollama as unknown as DownloadProvider, {
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
  const recommendationEngine = new RecommendationEngine(modelCatalog);

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
export async function initGlobalRuntime(runtime: GlobalRuntime, defaultWorkingDir: string): Promise<RecoverResult> {
  const { repositories } = runtime.persistence;
  const existing = await repositories.agents.get(DEFAULT_AGENT_ID);
  if (!existing) {
    const numCtxDefaults = await loadNumCtxDefaults(runtime);
    const defaultNumCtxFor: DefaultNumCtxFor = (ref) => {
      const value = numCtxDefaults?.[ref.name];
      return typeof value === 'number' && value > 0 ? value : undefined;
    };
    await repositories.agents.save(createDefaultAgentConfig(defaultWorkingDir, DEFAULT_MODEL_REF, defaultNumCtxFor), true);
  }
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

/** Punto 5 del encargo ("el numCtx por defecto por modelo de Ajustes debe llegar al runtime"): lee
 *  `models.numCtxDefaults` (settings, scope global — misma clave que
 *  apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx) cada vez que arranca un run,
 *  para que un cambio en Ajustes aplique en el próximo run sin reiniciar la app. Usa
 *  `RunControllerDeps.numCtxForModel` (cambio aditivo mínimo en packages/runtime/src/agent/RunController.ts
 *  de esta misma tarea — packages/runtime no es zona de este encargo, documentado ahí y en doc 16). */
function makeNumCtxForModel(runtime: GlobalRuntime): (ref: ModelRef) => Promise<number | undefined> {
  return async (ref) => {
    const numCtxDefaults = await loadNumCtxDefaults(runtime);
    const value = numCtxDefaults?.[ref.name];
    return typeof value === 'number' && value > 0 ? value : undefined;
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
    workspaceFs,
    clock: systemClock,
    ids: defaultIdGenerator,
    projectRoot,
    repoMap,
    toolTransportOverrides: DEFAULT_TOOL_TRANSPORT_OVERRIDES,
    permissionMemory,
    projectId: project.id,
    modelContextProbe,
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
