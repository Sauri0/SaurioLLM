// Instancia @saurio/runtime y le inyecta el HostAdapter (diálogos nativos, notificaciones del SO,
// resolución de paths); único punto donde el runtime "toca" Electron (doc 02 §1, ADR-002, doc 01
// §4.2). Tras la fase de integración, las instancias reales se construyen en ./createRuntime.ts:
// RuntimeHost las guarda, corre migraciones + recover() al iniciar y expone getters tipados para los
// handlers IPC. Las piezas ligadas a la raíz del proyecto (RunController, CheckpointService, repo
// map) viven en un `ProjectRuntime` que se crea recién cuando el usuario abre un proyecto, porque
// `RunControllerDeps.projectRoot` y `WorkspaceFs` se fijan al construirse.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { PermissionAnswer, Project, RunEvent, ToolCallRecord } from '@saurio/shared';
import type { RunController } from '@saurio/runtime/agent/types';
import type { EventStore } from '@saurio/runtime/persistence/types';
import type {
  ChatRepository, ProjectRepository, MessageRepository, ToolCallRepository, CheckpointRepository,
  TaskRepository, SettingsRepository, ProfileRepository,
} from '@saurio/runtime/persistence/types';
import type { ModelManager, HardwareProbe } from '@saurio/runtime/models/types';
import type { DownloadManager, ModelCatalogEntry, RecommendationEngine, DownloadJob } from '@saurio/runtime/models/index';
import type { ModelGateway } from '@saurio/runtime/gateway/types';
import type { Provider } from '@saurio/runtime/gateway/Provider';
import type { CheckpointService } from '@saurio/runtime/checkpoint/types';
import type { RunRecord } from '@saurio/runtime/agent/ports';
import { LocalSettingsStore } from '../services/settings/LocalSettingsStore.js';
import {
  createProjectRuntime, initGlobalRuntime, type GlobalRuntime, type ProjectRuntime,
} from './createRuntime.js';

/**
 * Deviation (doc 02 §3 / regla "si necesitás un tipo nuevo, definilo local a tu módulo"):
 * ningún documento de arquitectura tipa `HostAdapter` como interfaz — solo lo nombra en prosa
 * ("diálogos nativos, notificaciones del SO, resolución de paths"). Se define acá, local a
 * desktop-main, con exactamente esas tres responsabilidades.
 */
export interface HostAdapter {
  readonly paths: {
    readonly userDataDir: string;
    readonly dbPath: string;
    readonly blobsDir: string;
    readonly toolOutputsDir: string;
    readonly logsDir: string;
    readonly cacheDir: string;
    readonly repoMapCacheDir: string;
    /** `app.getAppPath()` (services/resources.ts, doc 13 §3: resolución de `resources/model-catalog.json`
     *  sin importar `electron` fuera de index.ts, para no romper `createRuntime.test.ts`). */
    readonly appPath: string;
    /** `process.resourcesPath`; `undefined` fuera de un proceso Electron real (tests). */
    readonly resourcesPath?: string;
  };
  showOpenDirectoryDialog(options?: { title?: string; defaultPath?: string }): Promise<{ canceled: boolean; path?: string }>;
  notify(options: { title: string; body: string }): void;
}

/** Deviation: `RuntimeHostDeps` tampoco está nombrado en los documentos; agrupa lo que la app le
 *  inyecta al host. Todo opcional: los tests de IPC construyen un RuntimeHost vacío. */
export interface RuntimeHostDeps {
  /** Runtime real (persistence + gateway + models + telemetry), creado con `createGlobalRuntime`. */
  runtime?: GlobalRuntime;
  /** Directorio de trabajo por defecto del agente builtin mientras no haya proyecto abierto. */
  defaultWorkingDir?: string;
  profileRepository?: ProfileRepository;
}

export class RuntimeNotWiredError extends Error {
  constructor(dep: string) {
    super(
      `saurio: "${dep}" todavía no está conectado en RuntimeHost (no hay runtime real inyectado en ` +
        'este proceso; es un error de arranque de la app, no un canal sin implementar).',
    );
    this.name = 'RuntimeNotWiredError';
  }
}

export class NoProjectOpenError extends Error {
  constructor(what: string) {
    super(`saurio: "${what}" necesita un proyecto abierto; usá "project:open" antes.`);
    this.name = 'NoProjectOpenError';
  }
}

export class NotImplementedYetError extends Error {
  constructor(channel: string, version: 'v0.2' | 'v0.3') {
    super(`saurio: el canal "${channel}" está tipado pero sin handler real (${version}, principio 8 de la columna vertebral).`);
    this.name = 'NotImplementedYetError';
  }
}

/** Crea las subcarpetas activas del MVP (doc 02 §6.3): blobs/, tool-outputs/, logs/, cache/repo-map/.
 *  `shadow/` no se crea (v0.3, doc 02 §6.3: "no se crea vacía de antemano"). */
export function ensureHostDataDirs(paths: HostAdapter['paths']): void {
  mkdirSync(paths.userDataDir, { recursive: true });
  mkdirSync(paths.blobsDir, { recursive: true });
  mkdirSync(paths.toolOutputsDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.repoMapCacheDir, { recursive: true });
}

export interface RecoverResult { orphaned: ToolCallRecord[]; abandoned: ToolCallRecord[] }

/**
 * RuntimeHost: instancia @saurio/runtime con userData: saurio.db, blobs/, tool-outputs/; corre
 * migraciones y recover() al iniciar (doc 02 §1).
 */
export class RuntimeHost {
  readonly hostAdapter: HostAdapter;
  readonly settings: LocalSettingsStore;
  private readonly deps: RuntimeHostDeps;
  private projectRuntime: ProjectRuntime | undefined;

  constructor(hostAdapter: HostAdapter, deps: RuntimeHostDeps = {}) {
    this.hostAdapter = hostAdapter;
    this.deps = deps;
    // `settings:get`/`settings:set` usan el SettingsRepository de saurio.db cuando hay runtime real;
    // este store JSON sigue existiendo para ajustes que la app necesita ANTES de abrir la base
    // (p. ej. `app.gpuMitigationDisabled`, que se lee antes de app.whenReady()).
    this.settings = new LocalSettingsStore(path.join(hostAdapter.paths.userDataDir, 'settings.local.json'));
  }

  /** Crea las carpetas de datos, siembra el agente builtin y llama recover() (doc 10 §5). */
  async init(): Promise<RecoverResult | undefined> {
    ensureHostDataDirs(this.hostAdapter.paths);
    this.settings.load();
    if (!this.deps.runtime) return undefined;
    return initGlobalRuntime(this.deps.runtime, this.deps.defaultWorkingDir ?? this.hostAdapter.paths.userDataDir);
  }

  /** Cierra la base al salir de la app. */
  dispose(): void {
    this.deps.runtime?.persistence.close();
  }

  private get runtime(): GlobalRuntime {
    if (!this.deps.runtime) throw new RuntimeNotWiredError('GlobalRuntime');
    return this.deps.runtime;
  }

  hasRuntime(): boolean {
    return this.deps.runtime !== undefined;
  }

  // ── Proyecto activo ──────────────────────────────────────────────────────

  /** Un proyecto abierto a la vez en el MVP (doc 01 §7.a, punto 7.a del encargo): reconstruye el
   *  ProjectRuntime si cambia, pero antes cancela cualquier run vivo del proyecto que se cierra —
   *  si no, ese run seguiría corriendo contra un `RunController`/`WorkspaceFs` que ya nadie referencia
   *  desde `RuntimeHost` (el `ProjectRuntime` viejo queda solo con el `runController` en curso, sin
   *  IPC que pueda cancelarlo después porque `host.runController` ya apunta al proyecto nuevo). */
  async openProject(project: Project): Promise<ProjectRuntime> {
    if (this.projectRuntime && this.projectRuntime.projectId !== project.id) {
      await this.cancelActiveRunsOf(this.projectRuntime);
    }
    if (this.projectRuntime?.projectId !== project.id) {
      this.projectRuntime = createProjectRuntime(this.runtime, this.hostAdapter, project);
    }
    return this.projectRuntime;
  }

  private async cancelActiveRunsOf(previous: ProjectRuntime): Promise<void> {
    if (!this.deps.runtime) return;
    try {
      const { chats, runs } = this.deps.runtime.persistence.repositories;
      const [chatsOfProject, activeRuns] = await Promise.all([chats.listByProject(previous.projectId), runs.listActive()]);
      const chatIds = new Set(chatsOfProject.map((c) => c.id));
      const toCancel = activeRuns.filter((run) => chatIds.has(run.chatId));
      await Promise.all(toCancel.map((run) => previous.runController.cancel(run.id).catch((error: unknown) => {
        console.error(`[host] no se pudo cancelar el run "${run.id}" al cambiar de proyecto`, error);
      })));
    } catch (error) {
      console.error('[host] no se pudieron listar/cancelar los runs activos del proyecto anterior', error);
    }
  }

  get activeProject(): ProjectRuntime | undefined {
    return this.projectRuntime;
  }

  get activeProjectRoot(): string | undefined {
    return this.projectRuntime?.projectRoot;
  }

  private requireProject(what: string): ProjectRuntime {
    if (!this.projectRuntime) throw new NoProjectOpenError(what);
    return this.projectRuntime;
  }

  // ── Getters usados por los handlers IPC ──────────────────────────────────

  get runController(): RunController {
    return this.requireProject('run:*').runController;
  }

  get checkpointService(): CheckpointService {
    return this.requireProject('checkpoint:*').checkpointService;
  }

  get eventStore(): EventStore {
    return this.runtime.events;
  }

  get modelManager(): ModelManager {
    return this.runtime.modelManager;
  }

  get hardwareProbe(): HardwareProbe {
    return this.runtime.hardwareProbe;
  }

  get modelGateway(): ModelGateway {
    return this.runtime.gateway;
  }

  get downloadManager(): DownloadManager {
    return this.runtime.downloadManager;
  }

  get modelCatalog(): ModelCatalogEntry[] {
    return this.deps.runtime?.modelCatalog ?? [];
  }

  get recommendationEngine(): RecommendationEngine {
    return this.runtime.recommendationEngine;
  }

  /** Reenvía `download:progress`/`download:done`/`download:failed` (doc 13 §5) al renderer; se
   *  suscribe una sola vez, recién cuando ya existe la `BrowserWindow` (main/index.ts), igual que
   *  `onRunEvent` para `runtime:event`. No-op si el runtime real no está armado. */
  onDownloadEvent(handlers: {
    onProgress: (job: DownloadJob) => void;
    onDone: (job: DownloadJob) => void;
    onFailed: (job: DownloadJob, error: string) => void;
  }): () => void {
    if (!this.deps.runtime) return () => {};
    const dm = this.deps.runtime.downloadManager;
    dm.on('progress', handlers.onProgress);
    dm.on('done', handlers.onDone);
    dm.on('failed', handlers.onFailed);
    return () => {
      dm.off('progress', handlers.onProgress);
      dm.off('done', handlers.onDone);
      dm.off('failed', handlers.onFailed);
    };
  }

  get providers(): Provider[] {
    return this.runtime.providers;
  }

  // ── Ajustes > Proveedores (punto 3 del encargo) ──────────────────────────

  listProviderConfigs() {
    return this.runtime.listProviderConfigs();
  }

  get providersRepository() {
    return this.runtime.providersRepository;
  }

  get secureKeyStore() {
    return this.runtime.secureKeyStore;
  }

  /** Reconstruye `providers`/`gateway`/`modelManager` tras un agregar/editar/quitar/(des)habilitar
   *  provider — ver `GlobalRuntime.refreshProviders` (createRuntime.ts). */
  refreshProviders(): void {
    this.runtime.refreshProviders();
  }

  get auditLog() {
    return this.runtime.auditLog;
  }

  get downloadsRepository() {
    return this.runtime.downloadsRepository;
  }

  async testProvider(id: string) {
    return this.runtime.testProvider(id);
  }

  /** Punto 5 del encargo ("reanudar permisos pendientes tras reinicio — tarjeta de permiso
   *  rehidratada"): [] si no hay proyecto abierto (nada que rehidratar todavía) en vez de lanzar —
   *  la UI llama esto al abrir un proyecto, no necesita un run vivo. */
  async pendingPermissionRequests() {
    if (!this.projectRuntime) return [];
    return this.projectRuntime.runController.pendingPermissionRequests();
  }

  get projectRepository(): ProjectRepository | undefined {
    return this.deps.runtime?.persistence.repositories.projects;
  }

  get chatRepository(): ChatRepository {
    return this.runtime.persistence.repositories.chats;
  }

  get messageRepository(): MessageRepository {
    return this.runtime.persistence.repositories.messages;
  }

  get toolCallRepository(): ToolCallRepository {
    return this.runtime.persistence.repositories.toolCalls;
  }

  get checkpointRepository(): CheckpointRepository {
    return this.runtime.persistence.repositories.checkpoints;
  }

  get taskRepository(): TaskRepository {
    return this.runtime.persistence.repositories.tasks;
  }

  get settingsRepository(): SettingsRepository | undefined {
    return this.deps.runtime?.persistence.repositories.settings;
  }

  get profileRepository(): ProfileRepository {
    if (!this.deps.profileRepository) throw new RuntimeNotWiredError('ProfileRepository');
    return this.deps.profileRepository;
  }

  /** Runs de un chat, para que `chat:history` pueda juntar las tool calls de todos ellos
   *  (`ToolCallRepository` solo expone `listByRun`, doc 04 §6). */
  async runsOfChat(chatId: string): Promise<RunRecord[]> {
    return this.runtime.persistence.repositories.runs.listByChat(chatId);
  }

  /** `permission:answer` (doc 05 §2.6 paso 28): resuelve la espera del run vivo en este proceso. */
  async answerPermission(answer: PermissionAnswer): Promise<void> {
    await this.requireProject('permission:answer').runController.answerPermission(answer.toolCallId, answer);
  }

  /** Suscribe `cb` a los RunEvent ya persistidos (BroadcastEventStore). Devuelve la desuscripción;
   *  si todavía no hay runtime real, un no-op, para que main/index.ts arme el batcher igual. */
  onRunEvent(cb: (event: RunEvent) => void): () => void {
    if (!this.deps.runtime) return () => {};
    return this.deps.runtime.events.subscribe(cb);
  }
}
