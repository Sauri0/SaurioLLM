// Mapa channel -> { input, output } (zod) — fuente de verdad de IPC. packages/shared/src/ipc.ts.
// Define: doc 04 §16. Canales sin comentario de versión son MVP; `// v0.2` / `// v0.3` quedan
// tipados (para que el resto del monorepo compile contra ellos) pero sin handler real todavía
// (principio 8 de la columna vertebral).
import { z } from 'zod';
import { Mode, ChatPermissionPreset, Effort, RunState } from './enums.js';
import {
  ProjectSchema, ChatSchema, ChatMessageSchema, ToolCallRecordSchema, CheckpointSchema, TaskSchema,
  ModelRefSchema, ModelInfoSchema, ModelDescriptionSchema, LoadedModelSchema, MemoryEstimateSchema,
  DiffResultSchema, RevertPlanSchema, RevertResultSchema, PermissionAnswerSchema, PermissionRequestSchema, ProviderHealthSchema,
  MetricsSnapshotSchema, BenchmarkConfigSchema, BenchmarkRunSchema, ProfileSchema,
  FileTreeNodeSchema, FileReadResultSchema, ModelsFolderInfoSchema,
  CatalogItemSchema, RecommendationSchema, DownloadJobSchema,
  ProviderConfigSchema, ProviderPresetSchema, ProviderTestResultSchema, NonLocalCallAuditEntrySchema,
  AgentProfileSchema, AgentMemorySchema, AgentCreateInputSchema,
  HuggingFaceSearchResultSchema, HuggingFaceGgufFileSchema, LibraryCatalogResultSchema, ResolveModelByNameResultSchema,
  ModelTierSchema, AttachmentSchema, ProjectRecentSchema, ProviderCatalogStatusSchema,
  ModelResolutionSchema, RunErrorSchema,
} from './domain.js';
import { RunEventSchema } from './events.js';

const ChatHistorySchema = z.object({
  messages: z.array(ChatMessageSchema),
  toolCalls: z.array(ToolCallRecordSchema),
  checkpoints: z.array(CheckpointSchema),
  tasks: z.array(TaskSchema),
  /** Último run persistido del chat. Permite rehidratar un cierre/error después de reiniciar sin
   *  reconstruir estados transitorios a partir de todo el event log. */
  lastRun: z.object({
    id: z.string(),
    state: RunState,
    error: RunErrorSchema.optional(),
  }).optional(),
  /** Última razón realmente persistida. Ausente para chats sin runs o runs legacy. */
  modelResolution: ModelResolutionSchema.optional(),
});

const BenchRequestSchema = z.object({
  suiteId: z.string(), modelRef: ModelRefSchema, config: BenchmarkConfigSchema,
});

/** Canal de prueba usado por el smoke test del scaffolding (renderer -> main -> renderer, doc 02
 *  §1). No forma parte del contrato del doc 04 §16; se mantiene además de los canales del doc 04
 *  ("todos los canales del doc 04" no implica "solo esos") para no romper apps/desktop, que no es
 *  un directorio de esta tarea (regla "tocá solo los directorios que te asigna tu tarea"). */
const AppPingInputSchema = z.object({ sentAt: z.number() });
const AppPingOutputSchema = z.object({
  pong: z.literal(true),
  receivedAt: z.number(),
  versions: z.object({ node: z.string(), electron: z.string(), chrome: z.string() }),
});

/** PRIORIDAD CERO punto 1 (bloqueo real reportado tras instalar v0.1: "Ollama instalado pero
 *  apagado" — la app no lo detectaba ni lo arrancaba sola). `apps/desktop/src/main/services/ollama/
 *  OllamaProcessManager.ts` implementa la lógica real; este canal la expone. Se llama sola al
 *  arrancar la app (main/index.ts) y también manualmente desde un botón "Iniciar Ollama" en la barra
 *  de estado (`layout/StatusBar.tsx`) cuando el health check falla. `error` es un código estable
 *  ('ollama_not_installed' | 'timeout_starting' | mensaje crudo del SO), no un texto para mostrar
 *  directo — la UI decide el copy. */
const OllamaEnsureRunningOutputSchema = z.object({
  running: z.boolean(),
  startedByApp: z.boolean(),
  error: z.string().optional(),
});

const EngineStatusSchema = z.object({
  phase: z.enum(['missing', 'checking', 'downloading', 'verifying', 'extracting', 'installed', 'cancelled', 'error']),
  version: z.string().optional(), completedBytes: z.number(), totalBytes: z.number().optional(), error: z.string().optional(),
  mode: z.enum(['managed', 'external']), hasManaged: z.boolean(),
});

export const ipc = {
  'app:ping':               { input: AppPingInputSchema, output: AppPingOutputSchema },
  // Asistente de primer arranque (punto 5 del encargo): "abre la descarga oficial de Ollama con
  // consentimiento explícito" — el consentimiento se pide en la UI (OnboardingWizard) ANTES de
  // invocar esto; este canal solo hace `shell.openExternal(url)`, nunca descarga ni ejecuta nada.
  'app:openExternal':       { input: z.object({ url: z.string().url() }), output: z.void() },
  'ollama:ensureRunning':  { input: z.void(), output: OllamaEnsureRunningOutputSchema },
  'engine:status':         { input: z.void(), output: EngineStatusSchema },
  'engine:install':        { input: z.void(), output: EngineStatusSchema },
  'engine:cancel':         { input: z.void(), output: z.void() },
  'engine:select':         { input: z.object({ mode: z.enum(['managed', 'external']) }), output: OllamaEnsureRunningOutputSchema },
  'project:open':          { input: z.object({ path: z.string().optional() }), output: ProjectSchema },
  'project:createManaged': { input: z.object({ name: z.string().trim().min(1).max(80) }), output: ProjectSchema },
  'project:list':          { input: z.void(), output: z.array(ProjectSchema) },
  // Feedback real v0.2.1, punto 12 ("proyectos persistentes como Claude Code/Codex"): lista de
  // proyectos abiertos alguna vez, más reciente primero, con cantidad de chats y si la carpeta sigue
  // existiendo — abrir uno de acá NO debe requerir el diálogo de carpeta (`project:open` ya acepta
  // `path` opcional para esto).
  'project:recent':        { input: z.void(), output: z.array(ProjectRecentSchema) },
  // Saca el proyecto de la lista de recientes; nunca borra la carpeta ni el historial (eso requiere
  // una confirmación/acción aparte que no existe en el MVP — doc del encargo: "sin borrar archivos ni
  // historial salvo confirmación aparte").
  'project:remove':        { input: z.object({ id: z.string() }), output: z.void() },
  'project:rename':        { input: z.object({ id: z.string(), name: z.string() }), output: ProjectSchema },
  'project:relocate':      { input: z.object({ id: z.string().min(1), path: z.string().optional() }), output: ProjectSchema.nullable() },
  // `confirmed`: mismo mecanismo que `chat:setModel` (frontera local/nube, punto 4 del encargo) —
  // crear un chat nuevo directamente con un modelRef NUBE es otra forma de "elegir un modelo NUBE
  // para un chat", así que pasa por la misma confirmación explícita la primera vez por proyecto.
  'chat:create':           { input: z.object({ projectId: z.string(), agentId: z.string(), mode: Mode, modelRef: ModelRefSchema.optional(), modelSelection: z.enum(['auto', 'explicit']).optional(), confirmed: z.boolean().optional() }).superRefine((value, ctx) => {
    if ((value.modelSelection ?? 'explicit') === 'explicit' && !value.modelRef) {
      ctx.addIssue({ code: 'custom', path: ['modelRef'], message: 'un chat con selección explícita requiere modelo' });
    }
    if (value.modelSelection === 'auto' && value.modelRef) {
      ctx.addIssue({ code: 'custom', path: ['modelRef'], message: 'un chat automático no persiste un modelo provisional' });
    }
  }), output: ChatSchema },
  'chat:list':             { input: z.object({ projectId: z.string() }), output: z.array(ChatSchema) },
  'chat:search': { input: z.object({
    projectId: z.string().min(1), query: z.string().trim().min(1).max(200),
    since: z.number().int().nonnegative().optional(), until: z.number().int().nonnegative().optional(),
    includeArchived: z.boolean().optional(), offset: z.number().int().nonnegative().max(100000).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }), output: z.object({ items: z.array(z.object({
    chatId: z.string(), projectId: z.string(), title: z.string(), updatedAt: z.number(), archived: z.boolean(),
    snippet: z.string(), messageId: z.string().optional(), matchedAt: z.number().optional(),
  })), hasMore: z.boolean() }) },
  'chat:history':          { input: z.object({ chatId: z.string() }), output: ChatHistorySchema },
  // Cambiar modelo/modo de un chat existente (punto 3 del encargo; doc 04 §16 no traía este canal
  // porque el MVP fijaba modelo/modo al crear el chat — `chats.model_ref_json`/`chats.mode` son
  // columnas mutables desde el principio, así que no hace falta migración nueva).
  // `confirmed` (punto 4 del encargo, frontera local/nube): obligatorio implícito para un modelRef
  // NUBE la primera vez por proyecto — el handler devuelve `CloudConfirmationRequiredError` si falta
  // y el modelo no es local; la UI lo captura, muestra el diálogo de confirmación explícito ("el
  // contenido de este chat saldrá de tu PC hacia <proveedor>") y reintenta con `confirmed: true`, que
  // además persiste el consentimiento del proyecto (`settings` scope `project`, key
  // `providers.cloudConsent`) para no volver a preguntar. Sin efecto para modelos `local`.
  'chat:setModel':         { input: z.object({ chatId: z.string(), modelRef: ModelRefSchema, confirmed: z.boolean().optional() }), output: ChatSchema },
  'chat:setMode':          { input: z.object({ chatId: z.string(), mode: Mode }), output: ChatSchema },
  // Feedback real v0.2.1, punto 1a/1b: preset de permisos y effort por chat. `unrestricted` exige
  // `confirmed: true` explícito (doc del encargo: "requiere confirmación explícita al activarlo") —
  // sin eso el handler devuelve error accionable en vez de aplicarlo en silencio.
  'chat:setPermissionPreset': { input: z.object({ chatId: z.string(), preset: ChatPermissionPreset, confirmed: z.boolean().optional() }), output: ChatSchema },
  'chat:setEffort':        { input: z.object({ chatId: z.string(), effort: Effort }), output: ChatSchema },
  // Feedback real v0.2.1, punto 12: renombrar/archivar/borrar un chat (la UI de renderer va a dibujar
  // la lista anidada proyecto -> chats con estas acciones).
  'chat:rename':           { input: z.object({ chatId: z.string(), title: z.string() }), output: ChatSchema },
  'chat:archive':          { input: z.object({ chatId: z.string(), archived: z.boolean() }), output: ChatSchema },
  'chat:delete':           { input: z.object({ chatId: z.string() }), output: z.void() },
  // Feedback real v0.2.1, punto 1c: adjuntos de archivo/imagen junto con el mensaje del usuario.
  'run:start':             { input: z.object({ chatId: z.string(), text: z.string(), mode: Mode, attachments: z.array(AttachmentSchema).optional() }), output: z.object({ runId: z.string() }) },
  'run:cancel':            { input: z.object({ runId: z.string() }), output: z.void() },
  'run:cancelChild':       { input: z.object({ parentRunId: z.string(), childRunId: z.string() }), output: z.void() },
  'run:continue':          { input: z.object({ runId: z.string(), extraIterations: z.number().optional() }), output: z.object({ runId: z.string() }) },
  'run:regenerate':        { input: z.object({ runId: z.string().min(1) }), output: z.object({ runId: z.string() }) },
  'permission:answer':     { input: PermissionAnswerSchema, output: z.void() },
  'checkpoint:list':       { input: z.object({ chatId: z.string() }), output: z.array(CheckpointSchema) },
  'checkpoint:diff':       { input: z.object({ checkpointId: z.string(), relPath: z.string() }), output: DiffResultSchema },
  'checkpoint:planRevert': { input: z.object({ checkpointIds: z.array(z.string()) }), output: RevertPlanSchema },
  'checkpoint:revert':     { input: z.object({ checkpointIds: z.array(z.string()), resolution: z.record(z.string(), z.enum(['restore', 'keep_mine', 'skip'])) }), output: RevertResultSchema },  // zod 4.6.5: z.record exige key+value schema
  'models:list':           { input: z.object({ refresh: z.boolean().optional(), providerId: z.string().optional() }), output: z.array(ModelInfoSchema) },
  'models:catalogStatus':  { input: z.undefined(), output: z.array(ProviderCatalogStatusSchema) },
  'models:updateManual':   { input: z.object({ providerId: z.string().min(1), name: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/u).refine((name) => !name.includes('\0')), remove: z.boolean().optional() }), output: z.void() },
  'models:loaded':         { input: z.void(), output: z.array(LoadedModelSchema) },
  'models:describe':       { input: z.object({ ref: ModelRefSchema }), output: ModelDescriptionSchema },
  'models:fits':           { input: z.object({ ref: ModelRefSchema, numCtx: z.number() }), output: MemoryEstimateSchema },
  'models:pull':           { input: z.object({ name: z.string() }), output: z.object({ downloadId: z.string() }) },
  'models:pullCancel':     { input: z.object({ downloadId: z.string() }), output: z.void() },
  'models:delete':         { input: z.object({ name: z.string() }), output: z.void() },
  'models:folderInfo':     { input: z.void(), output: ModelsFolderInfoSchema },
  // Centro de modelos v0.2/v0.3 (doc 13 §10): pestañas "Explorar" y "Recomendaciones". No estaban en
  // la tabla de canales de spine §5 (el catálogo curado es posterior a ese documento); se agregan acá
  // porque el Centro de modelos (mi zona) es el único consumidor.
  'models:catalog':        { input: z.void(), output: z.array(CatalogItemSchema) },
  'models:recommend':      { input: z.object({ use: z.enum(['coding', 'chat', 'analysis', 'vision']), goal: z.enum(['speed', 'quality']) }), output: z.array(RecommendationSchema) },
  'models:downloads':      { input: z.void(), output: z.array(DownloadJobSchema) },
  // Cobertura máxima del catálogo (doc 16 §12.6, puntos 1-5 del encargo): biblioteca completa de
  // Ollama (OllamaLibraryClient, caché 24h + snapshot empaquetado) y búsqueda de Hugging Face GGUF.
  'models:libraryCatalog': { input: z.object({ forceRefresh: z.boolean().optional() }), output: LibraryCatalogResultSchema },
  'models:hfSearch':       { input: z.object({ query: z.string() }), output: z.array(HuggingFaceSearchResultSchema) },
  'models:hfFiles':        { input: z.object({ modelId: z.string() }), output: z.array(HuggingFaceGgufFileSchema) },
  'models:resolveByName':  { input: z.object({ name: z.string() }), output: ResolveModelByNameResultSchema },
  'models:pullExternal':   { input: z.object({ ref: z.string(), sizeBytes: z.number() }), output: z.object({ downloadId: z.string() }) },
  // Selector de contexto 4k/8k/16k/32k de la ficha de Explorar (punto 5 del encargo): recalcula
  // memoria/nivel para un tamaño de pesos ya conocido sin volver a pedir el catálogo completo.
  'models:tierForSize':    { input: z.object({ sizeBytes: z.number(), numCtx: z.number() }), output: ModelTierSchema },
  'provider:health':       { input: z.void(), output: z.array(ProviderHealthSchema) },
  // Ajustes > Proveedores (punto 3 del encargo, doc 18 §3 "qué necesita el host"): CRUD sobre la
  // tabla `providers` (ya existía, doc 03) + almacén seguro de claves (Electron `safeStorage`, punto 1)
  // + `health()`/`listModels()` real contra el provider recién agregado ("probar conexión").
  'providers:list':        { input: z.void(), output: z.array(ProviderConfigSchema) },
  'providers:add':         {
    input: z.object({
      preset: ProviderPresetSchema, label: z.string(), baseUrl: z.string(),
      apiKey: z.string().optional(), headers: z.record(z.string(), z.string()).optional(),
    }),
    output: ProviderConfigSchema,
  },
  'providers:update':      {
    input: z.object({
      id: z.string(), label: z.string().optional(), baseUrl: z.string().optional(),
      enabled: z.boolean().optional(),
      // string: reemplaza la clave guardada; null: la borra del almacén seguro; undefined: no la toca.
      apiKey: z.string().nullable().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
    output: ProviderConfigSchema,
  },
  'providers:remove':      { input: z.object({ id: z.string() }), output: z.void() },
  'providers:test':        { input: z.object({ id: z.string() }), output: ProviderTestResultSchema },
  // Punto 4 del encargo ("visor simple del audit_log de llamadas no locales en Ajustes >
  // Proveedores"): `SqlAuditLogRepository.listNonLocalCalls()` ya existía y ya estaba probado
  // (doc 16 §10.9, "listo para un canal futuro si hace falta") — este es ese canal.
  'providers:auditLog':    { input: z.void(), output: z.array(NonLocalCallAuditEntrySchema) },
  // Punto 5 del encargo ("reanudar permisos pendientes tras reinicio... tarjeta de permiso
  // rehidratada"): al abrir un proyecto (o al arrancar la app con un proyecto ya activo), la UI llama
  // esto para repoblar `PermissionCard` con lo que quedó `awaiting_permission` de una sesión anterior
  // — sin esto, la tarjeta solo aparecía si el evento `tool.permission` llegaba en vivo (doc 10 §5.2).
  'permission:pending':    { input: z.void(), output: z.array(z.object({ runId: z.string(), chatId: z.string(), request: PermissionRequestSchema })) },
  // Árbol de archivos del proyecto, perezoso por carpeta (punto 1 del encargo; doc 16 §11: canal
  // que faltaba en este contrato, FilesPanel lo invocaba con invokeRaw y se degradaba).
  'files:tree':            { input: z.object({ projectId: z.string(), relPath: z.string().optional() }), output: z.array(FileTreeNodeSchema) },
  'files:read':            { input: z.object({ projectId: z.string(), relPath: z.string() }), output: FileReadResultSchema },
  // Búsqueda acotada y cancelable: una coincidencia por archivo, sin devolver ni retener el contenido
  // completo del proyecto. El requestId permite al renderer descartar/cancelar consultas supersedidas.
  'files:search':          { input: z.object({
    projectId: z.string().min(1), requestId: z.string().min(1).max(120), query: z.string().trim().min(1).max(200),
    mode: z.enum(['path', 'content', 'all']).optional(), offset: z.number().int().nonnegative().max(100000).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }), output: z.object({
    requestId: z.string(), items: z.array(z.object({
      relPath: z.string(), name: z.string(), match: z.enum(['path', 'content']), line: z.number().int().positive().optional(),
      excerpt: z.string().max(400).optional(), sizeBytes: z.number().nonnegative(),
    })), hasMore: z.boolean(), cancelled: z.boolean(),
  }) },
  'files:cancelSearch':    { input: z.object({ projectId: z.string().min(1), requestId: z.string().min(1).max(120) }), output: z.void() },
  'terminal:create':       { input: z.object({ projectId: z.string(), shell: z.string().optional() }), output: z.object({ terminalId: z.string() }) },
  'terminal:resize':       { input: z.object({ terminalId: z.string(), cols: z.number(), rows: z.number() }), output: z.void() },
  'terminal:close':        { input: z.object({ terminalId: z.string() }), output: z.void() },
  'project:personal': { input: z.void(), output: ProjectSchema },
  'hardware:profile': { input: z.object({ refresh: z.boolean().optional() }), output: z.object({
    cpu: z.object({ name: z.string(), threads: z.number().int().positive(), physicalCores: z.number().int().positive().optional() }),
    ram: z.object({ totalBytes: z.number().nonnegative(), freeBytes: z.number().nonnegative() }),
    gpu: z.object({ vendor: z.enum(['nvidia', 'amd', 'intel', 'apple', 'other']), vramTotalBytes: z.number().nonnegative(), vramUsedBytes: z.number().nonnegative().optional(), integrated: z.boolean().optional(), quality: z.enum(['measured', 'estimated', 'unavailable']), source: z.string() }).optional(),
    sampledAt: z.number(),
  }) },
  'providers:usageSummary': { input: z.object({ since: z.number().nonnegative().optional(), runId: z.string().optional() }), output: z.object({
    reportedUsd: z.number().nonnegative(), reportedCalls: z.number().int().nonnegative(),
    estimatedUsd: z.number().nonnegative(), estimatedCalls: z.number().int().nonnegative(),
    unavailableCalls: z.number().int().nonnegative(), totalCalls: z.number().int().nonnegative(),
  }) },
  'metrics:snapshot':      { input: z.void(), output: MetricsSnapshotSchema },
  // Doc 14 §6/§8: "metrics:tick... solo mientras el panel está abierto" — el renderer avisa acá
  // cuando el Panel de rendimiento se monta/desmonta para que main arranque/pare el muestreo
  // continuo (v0.2); no existía un canal para esto, `perfStore.setPanelOpen` solo tocaba estado local.
  'metrics:setPanelOpen':  { input: z.object({ open: z.boolean() }), output: z.void() },
  'settings:get':          { input: z.object({ key: z.string(), projectId: z.string().optional() }), output: z.unknown() },
  'settings:set':          { input: z.object({ key: z.string(), value: z.unknown(), projectId: z.string().optional() }), output: z.void() },
  'bench:run':             { input: BenchRequestSchema, output: z.object({ benchmarkRunId: z.string() }) },   // v0.3
  'bench:cancel':          { input: z.object({ benchmarkRunId: z.string() }), output: z.void() },             // v0.3
  'bench:list':            { input: z.object({ modelName: z.string().optional() }), output: z.array(BenchmarkRunSchema) },  // v0.3
  'profiles:list':         { input: z.object({ projectId: z.string().optional() }), output: z.array(ProfileSchema) },  // v0.2
  'profiles:save':         { input: ProfileSchema, output: ProfileSchema },                                    // v0.2
  'profiles:setDefault':   { input: z.object({ projectId: z.string(), profileId: z.string() }), output: z.void() },  // v0.2

  // Doc 19 §1.4 — E2a "Mis agentes". `agents:list` sin filtro devuelve solo `ownerKind: 'personal'`
  // no archivados (la UI de "Mis agentes" nunca ve `'worker'`/`'coordinator'`, doc 19 §0/§1.5).
  // `projectId` no filtra la LISTA de agentes (un agente personal es visible en cualquier proyecto,
  // doc 19 §0 "alcance por proyecto" es de la MEMORIA, no del agente); se acepta igual en el input
  // por si una vista futura lo necesita, sin uso todavía en el handler del MVP de esta entrega.
  'agents:list':           { input: z.object({ projectId: z.string().optional(), includeArchived: z.boolean().optional() }), output: z.array(AgentProfileSchema) },
  'agents:create':         { input: AgentCreateInputSchema, output: AgentProfileSchema },
  'agents:collaborators:get': { input: z.object({ chatId: z.string(), projectId: z.string() }), output: z.object({ agentIds: z.array(z.string()) }) },
  'agents:collaborators:set': { input: z.object({ chatId: z.string(), projectId: z.string(), agentIds: z.array(z.string()).max(12) }), output: z.object({ agentIds: z.array(z.string()) }) },
  'agents:update':         { input: z.object({ id: z.string(), patch: AgentCreateInputSchema.partial() }), output: AgentProfileSchema },
  'agents:archive':        { input: z.object({ id: z.string() }), output: z.void() },
  'agents:restore':        { input: z.object({ id: z.string() }), output: z.void() },
  'agents:duplicate':      { input: z.object({ id: z.string(), name: z.string().optional() }), output: AgentProfileSchema },
  'agent-memory:list':     { input: z.object({ agentId: z.string(), projectId: z.string().optional() }), output: z.array(AgentMemorySchema) },
  'agent-memory:upsert':   { input: AgentMemorySchema.partial(), output: AgentMemorySchema },
  'agent-memory:delete':   { input: z.object({ id: z.string() }), output: z.void() },
} as const;

export type IpcChannel = keyof typeof ipc;
export type IpcInput<C extends IpcChannel> = z.infer<(typeof ipc)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.infer<(typeof ipc)[C]['output']>;

/** Alias retrocompatible con el scaffolding (`ipcContract`/`IpcContract`) del smoke test de
 *  apps/desktop; `ipc`/`IpcChannel`/`IpcInput`/`IpcOutput` (arriba) son los nombres canónicos del
 *  doc 04 §16 y lo que debe importar código nuevo. */
export const ipcContract = ipc;
export type IpcContract = typeof ipc;

// Eventos main -> renderer (webContents.send), sin invoke/response:
export interface RendererEvents {
  'runtime:event': z.infer<typeof RunEventSchema>[];                          // batched cada 30 ms
  'models:changed': { installed: z.infer<typeof ModelInfoSchema>[]; loaded: z.infer<typeof LoadedModelSchema>[] };
  'download:progress': z.infer<typeof DownloadJobSchema>;
  'download:done': z.infer<typeof DownloadJobSchema>;
  // El job completo permite insertar una descarga que falló antes de emitir progreso (por ejemplo,
  // al resolver un redirect de Hugging Face), además de conservar tamaño/modelo para reintentar.
  'download:failed': z.infer<typeof DownloadJobSchema>;
  'metrics:tick': z.infer<typeof MetricsSnapshotSchema>;                        // solo con el panel de rendimiento abierto
  'provider:health': { providerId: string; ok: boolean; version?: string; error?: string };
  'bench:progress': { benchmarkRunId: string; taskId: string; completed: number; total: number };  // v0.3
  'bench:done': { benchmarkRunId: string; result: z.infer<typeof BenchmarkRunSchema> };             // v0.3
  'bench:failed': { benchmarkRunId: string; error: string };                     // v0.3
  // fs.watch sobre la raíz del proyecto abierto (punto 1 del encargo, "modificado externamente"):
  // se emite cuando un archivo cambia en disco por fuera de una escritura hecha por una tool de
  // SaurioLLM; `relPath` en POSIX, relativo a la raíz del proyecto.
  'files:changed': { projectId: string; relPath: string; kind: 'modified' | 'removed' };
  // Stale-while-revalidate de "Explorar" (doc 16 §16.5, arreglo real de la causa —"Cargando
  // catálogo…" ~13s contra ollama.com/library— en vez de solo el síntoma en la UI que ya cubría §16.5):
  // `models:libraryCatalog` ahora puede devolver de inmediato una caché vencida o el snapshot
  // empaquetado (`syncing: true`) mientras `OllamaLibraryClient` sincroniza en segundo plano; al
  // terminar esa sincronización, el host reenvía acá el mismo shape que la respuesta de
  // `models:libraryCatalog` (aditivo: reutiliza `LibraryCatalogResultSchema`, no reemplaza ningún canal
  // existente) para que `ExploreTab.tsx` se refresque sola sin perder búsqueda/filtros/página.
  'models:libraryUpdated': z.infer<typeof LibraryCatalogResultSchema>;
  // Si la sincronización de fondo falla, la UI se queda con lo que ya estaba mostrando y solo agrega
  // un aviso no bloqueante (nunca bloquea ni borra el catálogo ya visible).
  'models:libraryUpdateFailed': { error: string };
  // el puerto de datos de la terminal NO viaja por acá: ver 'terminal:port' más abajo
}

/** Firma de registerHandler en main: valida input con zod, ejecuta y valida output antes de
 *  responder; valida además event.senderFrame contra el BrowserWindow dueño de la sesión
 *  [VERIFICADO EN DOC OFICIAL: electronjs.org/docs/latest/tutorial/security]. */
export type IpcHandler<C extends IpcChannel> = (input: IpcInput<C>, meta: { senderFrame: unknown }) => Promise<IpcOutput<C>>;

export declare function registerHandler<C extends IpcChannel>(channel: C, handler: IpcHandler<C>): void;

/** MessagePort de Electron/DOM; packages/shared no incluye lib DOM (doc 02 §4.2, tsconfig "Node
 *  puro, sin DOM ni Electron"), así que se tipa acá con la forma mínima que necesita el preload
 *  real. `apps/desktop/src/preload` sí tiene lib DOM y su `MessagePort` nativo es estructuralmente
 *  compatible con esta interfaz — ver doc 04, Desvíos §5. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: unknown[]): void;
  start(): void;
  close(): void;
}

/** Firma expuesta por el preload vía contextBridge; el renderer nunca ve ipcRenderer crudo.
 *  `terminalPort` NO puede devolver un `MessagePort` como valor de retorno síncrono de una
 *  función de contextBridge [VERIFICADO EN DOC OFICIAL: electronjs.org/docs/latest/tutorial/message-ports].
 *  Contrato real: `terminal:create` (invoke) da `{ terminalId }`; main crea el canal con
 *  `MessageChannelMain` y hace `webContents.postMessage('terminal:port', { terminalId }, [port1])`;
 *  el preload escucha ese canal, guarda `event.ports[0]` y lo reexpone acá vía `onTerminalPort`. */
export interface PreloadApi {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>>;
  onEvent<E extends keyof RendererEvents>(channel: E, cb: (payload: RendererEvents[E]) => void): () => void;
  onTerminalPort(cb: (terminalId: string, port: MessagePortLike) => void): () => void;
}
