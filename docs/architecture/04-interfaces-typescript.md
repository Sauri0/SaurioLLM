# Documento 04: Interfaces TypeScript principales

Propósito: fijar el contrato de tipos de `@saurio/runtime` y `packages/shared` para que el scaffolding parta de interfaces ya acordadas, no de código de la app.

Leyenda: `[COMPROBADO EN EQUIPO]` `[VERIFICADO EN DOC OFICIAL]` `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]`

Convención de este documento `[DECISIÓN DE DISEÑO]`: todo lo que sigue son **interfaces y tipos**, no implementación. Cada bloque indica en un comentario si es `// MVP`, `// v0.2`, `// v0.3` o `// v0.4` según la tabla de la sección 16 de la columna vertebral (en adelante "la columna"); cuando una sección entera es MVP se aclara una sola vez al inicio del bloque. Las estimaciones llevan el campo `quality: 'measured' | 'estimated' | 'unavailable'` (regla 6 de la columna); ningún tipo permite presentar una estimación como medición.

---

## 1. Enums y tipos base — `packages/shared/src/enums.ts`

MVP salvo donde se indica. Única fuente de verdad; todo lo demás importa de acá.

```ts
import { z } from 'zod';

export const RunState = z.enum([
  'created', 'preparing', 'queued', 'generating', 'parsing',
  'awaiting_permission', 'executing_tool', 'compacting', 'cancelling',
  'completed', 'cancelled', 'failed', 'interrupted',
]);
export type RunState = z.infer<typeof RunState>;

export const ToolCallStatus = z.enum([
  'pending', 'awaiting_permission', 'approved', 'denied', 'running',
  'awaiting_input',              // v0.3: solo MCP tools que piden input intermedio
  'done', 'failed', 'cancelled', 'orphaned', 'abandoned',
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

export const PermissionCategory = z.enum([
  'read', 'write', 'delete', 'terminal', 'git_commit', 'git_push',
  'network',   // v0.3
  'mcp',       // v0.3
]);
export type PermissionCategory = z.infer<typeof PermissionCategory>;

export const PermissionDecisionKind = z.enum(['allow', 'ask', 'deny']);
export type PermissionDecisionKind = z.infer<typeof PermissionDecisionKind>;

export const Risk = z.enum(['low', 'medium', 'high']);
export type Risk = z.infer<typeof Risk>;

/** plan/agent en el MVP; ask/edit son filtros triviales que se activan en v0.2. */
export const Mode = z.enum(['plan', 'ask', 'edit', 'agent']);
export type Mode = z.infer<typeof Mode>;

/** local únicamente en el MVP; lan/proxied-cloud/cloud existen en el tipo desde el día 1
 *  para que ModelRef y PermissionPolicy no cambien de forma cuando se habiliten (v0.4). */
export const Locality = z.enum(['local', 'lan', 'proxied-cloud', 'cloud']);
export type Locality = z.infer<typeof Locality>;

export const ChatRole = z.enum(['system', 'user', 'assistant', 'tool']);
export type ChatRole = z.infer<typeof ChatRole>;

export const ToolTransport = z.enum(['native', 'text']);
export type ToolTransport = z.infer<typeof ToolTransport>;

export const AgentRole = z.enum(['lead', 'coder', 'reviewer', 'explorer', 'custom']);
export type AgentRole = z.infer<typeof AgentRole>;

export const MatchLevel = z.enum(['exact', 'eol', 'indent', 'whitespace', 'fuzzy']);
export type MatchLevel = z.infer<typeof MatchLevel>;

/** Toda cifra que ve el usuario declara su procedencia (regla 6 de la columna). */
export const Quality = z.enum(['measured', 'estimated', 'unavailable']);
export type Quality = z.infer<typeof Quality>;
```

---

## 2. Dominio compartido — `packages/shared/src/domain.ts`

MVP salvo donde se indica.

```ts
import { RunState, ToolCallStatus, PermissionCategory, Mode, Locality, ChatRole,
  ToolTransport, AgentRole, MatchLevel, Quality } from './enums';

export interface Project {
  id: string; path: string; name: string; createdAt: number; lastOpenedAt: number;
  settings?: Record<string, unknown>;
}

/** ModelRef identifica un modelo ante el Gateway; es serializable (va en effective_config_json). */
export interface ModelRef { providerId: string; name: string; locality: Locality }

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string }        // base64; MVP solo si el modelo tiene vision
  | { type: 'resource'; uri: string; text?: string };     // v0.3: adjuntos de MCP

export interface ToolCall {
  id: string; name: string; args: unknown; index?: number; transport: ToolTransport;
}

export interface ToolResult {
  content: ContentPart[]; isError: boolean; structured?: unknown;
  truncated?: boolean; fullOutputPath?: string;           // > 30.000 chars: preview + tool-outputs/<id>.txt
}

export interface ChatMessage {
  id: string; role: ChatRole; content: string; thinking?: string; images?: string[];
  toolCalls?: ToolCall[]; toolCallId?: string; toolName?: string;
  tokenEstimate?: number;
  /** true: mensaje del recordatorio final; nunca se persiste ni entra al prefijo cacheado. */
  ephemeral?: boolean;
}

export interface Task {
  id: string; chatId: string; ord: number; title: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
}

/** Salida estructurada del modo plan (tool finish con schema). */
export interface Plan { runId: string; summary: string; tasks: Task[] }

export interface CheckpointFile {
  relPath: string; change: 'created' | 'modified' | 'deleted';
  preHash?: string; postHash?: string;
  blobMissing?: boolean;                                   // archivo > 20 MB: hash sin blob
}

export interface Checkpoint {
  id: string; runId: string; chatId: string; toolCallId?: string;
  kind: 'tool' | 'revert';
  files: CheckpointFile[];
  stats: { files: number; added: number; removed: number };
  status: 'active' | 'reverted' | 'partial';
}

/** El "chat" de la columna es la unidad de conversación persistente por agente y proyecto;
 *  es el equivalente de lo que este brief llama "Session" — ver Nomenclatura agregada. */
export interface Chat {
  id: string; projectId: string; agentId: string; title?: string; mode: Mode;
  modelRef?: ModelRef; profileId?: string; createdAt: number; updatedAt: number; archived: boolean;
}
```

---

## 3. Model Gateway y Providers — `packages/runtime/src/gateway/`

MVP: `Provider`, `ModelGateway`, `InferenceScheduler`, `OllamaProvider` (implementación, no en este documento). `OpenAICompatProvider` es v0.2; `pull/delete` en `Provider` son v0.2; providers `cloud` v0.4.

```ts
// ── Capabilities, info y estimaciones de memoria ──────────────────────────
export interface ModelCapabilities { tools: boolean; thinking: boolean; vision: boolean; embedding: boolean }

export interface ModelInfo {
  ref: ModelRef; digest: string; sizeBytes: number; family: string; parameterSize: string;
  quantization: string; capabilities: ModelCapabilities; contextMax?: number; remoteHost?: string;
}

/** Extiende ModelInfo con lo que trae /api/show; modelInfo es el bag crudo (arch, block_count, etc.)
 *  [VERIFICADO EN DOC OFICIAL: api/types.go ShowResponse]. */
export interface ModelDescription extends ModelInfo {
  modelInfo: Record<string, unknown>; template?: string; parameters?: string;
}

/** Resultado de /api/ps para un modelo cargado. */
export interface LoadedModel {
  name: string; digest: string; size: number; sizeVram: number; contextLength: number; expiresAt: string;
}

/** Estimación de VRAM/RAM antes de cargar; ver fórmula en la columna §9.
 *  fitClass y bytes son [HIPÓTESIS A PROBAR] hasta que exista un ModelCompat para el hardware actual. */
export interface MemoryEstimate {
  vramNeededBytes: number; vramAvailableBytes: number;
  fitClass: 'fits_gpu' | 'tight' | 'partial_offload' | 'no_fit';
  quality: Quality;                          // 'estimated' salvo que exista ModelCompat -> 'measured'
  source: 'formula' | 'model_compat';
  hardwareFingerprint?: string;               // presente cuando source === 'model_compat'
}

// ── Chat (request/response) ───────────────────────────────────────────────
export interface JsonSchemaTool { type: 'function'; function: { name: string; description: string; parameters: object } }

export interface ChatRequest {                // puro y serializable; se graba tal cual para eval/
  model: string; messages: ChatMessage[]; tools?: JsonSchemaTool[];
  options: {
    numCtx: number;                            // SIEMPRE explícito (condición 12.b); nunca se confía en el default del server
    temperature: number; numPredict: number; topP?: number; topK?: number; seed?: number; stop?: string[];
  };
  think?: boolean | 'low' | 'medium' | 'high' | 'max';
  format?: 'json' | object;                    // rescate de formato tras 2 fallos de parseo (columna §6.5)
  keepAlive?: string | number;
}

export interface ChatContext {
  runId: string; signal: AbortSignal; authorizedLocality: Locality[];
  priority: 'interactive' | 'subagent' | 'benchmark' | 'warmup';
}

export type ProviderErrorCode =
  | 'connection_refused' | 'stream_cut' | 'oom_load' | 'oom_generate' | 'model_not_found'
  | 'no_tools_support' | 'server_busy' | 'context_too_large' | 'timeout' | 'unknown';

/** Métricas de una respuesta. Los duration_ns de Ollama son measured; providers /v1 sin
 *  duraciones caen a estimated [VERIFICADO EN DOC OFICIAL: api.md Metrics]. */
export interface ResponseMetrics {
  promptTokens?: number; cachedPromptTokens?: number; evalTokens?: number;
  loadMs?: number; promptEvalMs?: number; evalMs?: number; totalMs?: number; ttftClientMs?: number;
  quality: Quality;
}

export type ChatChunk =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'error'; message: string; code?: ProviderErrorCode }
  | { type: 'done'; doneReason: string; metrics: ResponseMetrics };

export interface PullProgress { status: string; digest?: string; total?: number; completed?: number }   // v0.2

// ── Provider ───────────────────────────────────────────────────────────────
/** Un Provider habla con UN backend de inferencia (Ollama, LM Studio, llama.cpp server, cloud).
 *  El Gateway es el único consumidor directo (regla de imports §2 de la columna); el ModelManager
 *  recibe la lista de providers() DEL GATEWAY, nunca instancia OllamaProvider por su cuenta. */
export interface Provider {
  readonly id: string;
  readonly kind: 'ollama' | 'openai-compat' | 'cloud';     // 'openai-compat' v0.2, 'cloud' v0.4
  readonly locality: Locality;

  health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string; error?: string }>;
  listModels(): Promise<ModelInfo[]>;
  describeModel(name: string): Promise<ModelDescription>;
  listLoaded?(): Promise<LoadedModel[]>;                    // /api/ps

  /** Streaming con abort real por request (ADR-2: el cliente ollama 0.6.3 no lo permite). */
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;

  load?(name: string, numCtx: number, keepAlive: string | number): Promise<{ loadMs: number }>;
  unload?(name: string): Promise<void>;                     // keep_alive: 0
  pull?(name: string, signal: AbortSignal): AsyncIterable<PullProgress>;   // v0.2
  delete?(name: string): Promise<void>;                     // v0.2
}

// ── ModelGateway y Scheduler ────────────────────────────────────────────────
/** Única puerta de inferencia (ADR-5): adquiere un slot al empezar chat() y lo libera en
 *  'done' | 'error' | abort. El AgentRuntime nunca ve el Scheduler ni el Provider directamente. */
export interface ModelGateway {
  chat(ref: ModelRef, req: ChatRequest, ctx: ChatContext): AsyncIterable<ChatChunk>;
  providers(): Provider[];
  resolve(ref: ModelRef): Provider;
  ensureLoaded(ref: ModelRef, numCtx: number): Promise<void>;   // precalentamiento, priority 'warmup'
  status(): { slots: SlotStatus[]; queue: QueuedJob[] };
}

/** Un lease de slot; el que lo obtiene es responsable de liberarlo (release) o dejar que
 *  el signal lo corte. Nombrado InferenceSlot en el brief de este documento — ver Nomenclatura agregada. */
export interface SlotLease { readonly slotId: string; readonly ref: ModelRef; readonly acquiredAt: number }

export interface SlotStatus {
  slotId: string; providerId: string; state: 'idle' | 'loading' | 'busy';
  currentModel?: ModelRef; leaseHolderRunId?: string;
}

export interface QueuedJob { runId: string; ref: ModelRef; priority: ChatContext['priority']; enqueuedAt: number }

/** Interno al Gateway; el AgentRuntime no lo importa directamente (regla de imports). */
export interface InferenceScheduler {
  acquire(ref: ModelRef, numCtx: number, priority: ChatContext['priority'], signal: AbortSignal): Promise<SlotLease>;
  release(lease: SlotLease): void;
  status(): { slots: SlotStatus[]; queue: QueuedJob[] };
}

/** settings.inference.slots por provider; 'auto' = 1 para local con VRAM < 24 GB [DECISIÓN DE DISEÑO]. */
export interface SchedulerConfig { slots: 'auto' | number; groupByModel: true }
```

---

## 4. Tool System — `packages/runtime/src/tools/`

MVP: registro de las 10 builtins, protocolo nativo y texto, `WorkspaceFs`. `source.kind = 'mcp' | 'delegate'` existen en el tipo desde el día 1 (principio 8 de la columna) pero sin implementación hasta v0.3/v0.4.

```ts
import type { ZodType } from 'zod';

/** classify() es donde se declaran peligrosidad y efectos secundarios reales de una llamada
 *  concreta (p. ej. run_command según el comando parseado); category/mutating son la base estática. */
export interface ToolClassification {
  category: PermissionCategory; risk: Risk; summary: string;
  paths?: string[];              // edit_file/write_file/delete_file: para protected paths
  command?: string;              // run_command: comando parseado, para CommandParser
}

export interface ToolDefinition<A = unknown> {
  name: string;                                    // [A-Za-z0-9_.-]{1,128}; MCP: mcp__<server>__<tool>
  description: string;
  inputSchema: object;                             // JSON Schema; contrato con el modelo y con MCP
  argsSchema?: ZodType<A>;                          // builtins: fuente de verdad; deriva inputSchema
  category: PermissionCategory;                     // categoría base, antes de classify()
  mutating: boolean;                                // dispara CheckpointService.begin
  idempotent: boolean;                               // [DECISIÓN DE DISEÑO, agregado en este documento]
                                                      // true: reintentar tras un fallo de red no duplica efecto
                                                      // (list_files, search_code, read_file, read_output, task_update);
                                                      // false: edit_file, write_file, delete_file, run_command — nunca
                                                      // se reintentan solas (columna §12, "idempotencia")
  allowedInModes: Mode[];
  source: { kind: 'builtin' } | { kind: 'mcp'; serverId: string } | { kind: 'delegate' };  // mcp/delegate: v0.3/v0.4
  classify?(args: A): ToolClassification;           // si falta, se usa { category, risk: 'low', summary: name }
  handler: ToolHandler<A>;
}

export type ToolHandler<A> = (args: A, ctx: ToolContext) => Promise<ToolResult>;

export interface CheckpointHandle {
  checkpointId: string;
  before(relPath: string): Promise<void>;
  after(relPath: string): Promise<void>;
}

export interface ToolContext {
  projectRoot: string; cwd: string; runId: string; toolCallId: string;
  signal: AbortSignal; timeoutMs: number;
  fs: WorkspaceFs;                                  // confinado al workspace; aplica protected paths y .saurioignore
  checkpoint: CheckpointHandle;                      // begin ya hecho por el runtime si mutating === true
  emit(ev: { toolCallId: string; text: string }): void;   // shape del payload de 'tool.progress' (§6); RunEvent no tiene campo `payload`
  log(e: unknown): void;
}

/** Acceso a archivos confinado; ninguna tool ni MCP toca fs/child_process directamente. */
export interface WorkspaceFs {
  readFile(relPath: string): Promise<{ content: string; hash: string; eol: 'LF' | 'CRLF'; bom: boolean }>;
  writeFileAtomic(relPath: string, content: string, opts?: { eol?: 'LF' | 'CRLF'; bom?: boolean }): Promise<void>;
  deleteFile(relPath: string): Promise<void>;
  listDir(relPath: string, depth: number): Promise<{ path: string; isDir: boolean }[]>;
  isProtected(relPath: string): boolean;             // .git/**, .saurio/**, .env*, *.pem, id_rsa*, .vscode/**, .idea/**
  isIgnored(relPath: string): boolean;               // .gitignore + .saurioignore
  resolve(relPath: string): string;                  // rechaza '..' que salga del workspace
}

/** Dos transportes detrás de una interfaz (ADR-6): NativeToolProtocol usa la API tools;
 *  TextToolProtocol imprime <tool_call> en el prompt y escanea content. */
export interface ToolProtocol {
  renderTools(tools: ToolDefinition[]): { apiTools?: JsonSchemaTool[]; systemSuffix?: string; stop?: string[] };
  parse(message: ChatMessage): { toolCalls: ToolCall[]; text: string; parseErrors: string[] };
  renderResult(call: ToolCall, result: ToolResult): ChatMessage;   // native: role 'tool'; text: role 'user' + <tool_result>
}

/** Registro único: builtins, MCP (v0.3) y delegate (v0.4) conviven detrás de la misma interfaz;
 *  el AgentRuntime nunca distingue el origen de una tool al invocarla. */
export interface ToolRegistry {
  register(def: ToolDefinition): void;
  unregister(name: string): void;
  list(filter?: { names?: string[]; mode?: Mode }): ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  onChanged(cb: () => void): () => void;             // MCP tools/list_changed; no-op hasta v0.3
}

/** Firma de las 10 builtins del registro (nombres únicos, implementación fuera de este documento). */
export type BuiltinToolName =
  | 'list_files' | 'search_code' | 'read_file' | 'read_output'
  | 'edit_file' | 'write_file' | 'delete_file' | 'run_command'
  | 'task_update' | 'finish';
```

---

## 5. Agent Runtime — `packages/runtime/src/agent/`

MVP salvo `fileScope` (v0.4) y `parentRunId` con delegación real (v0.4; la columna existe desde la migración 1 por costo de migración, principio 8).

```ts
export interface ContextPolicy {
  numCtx: number; reserveForResponse: number; repoMapTokens: number; historyBudgetRatio: number;
  maxReadLines: number; maxSearchResults: number; maxCommandLines: number;
  compactAtRatio: number; compactEveryTurns: number; keepLastTurns: number;
  fewShot: boolean;
}

export interface AgentConfig {
  id: string; name: string; role: AgentRole; model: ModelRef;
  systemPrompt: string; systemPromptHash: string;
  allowedTools: string[]; permissions: PermissionPolicy;
  workingDir: string; contextPolicy: ContextPolicy;
  memory: { readProjectMemory: boolean; writeProjectMemory: boolean };
  maxIterations: number; temperature: number; thinking: 'off' | 'on' | 'auto';
  toolTransport: 'auto' | 'native' | 'text'; defaultMode: Mode;
  profileId?: string;
  fileScope?: string;          // v0.4: restringe el agente a un subárbol del proyecto
}

/** Un ajuste automático concreto; el único del MVP es capear numCtx a contextMax (ADR-7). */
export interface Adjustment {
  param: string; requested: unknown; applied: unknown; reason: string;
  source: 'auto' | 'user'; evidenceCompatId?: string;   // liga a ModelCompat cuando hay evidencia (v0.2+)
}

/** Congelada al iniciar el run (regla 4: prefijo estable); nunca cambia dentro del mismo run. */
export interface EffectiveConfig {
  model: ModelRef; numCtx: number; think: ChatRequest['think']; tools: string[];
  transport: ToolTransport; promptHash: string; profileId?: string; adjustments: Adjustment[];
}

/** Ver Nomenclatura agregada: "Session" del brief = Chat (§2) + Run; Run es la ejecución concreta,
 *  Chat es el contenedor persistente donde viven varios runs en el tiempo. */
export interface Run {
  id: string; chatId: string; parentRunId?: string;      // parentRunId: subagentes, v0.4
  agent: AgentConfig; mode: Mode; state: RunState; iteration: number;
  effectiveConfig: EffectiveConfig;
}

export interface RunError {
  code: 'oom_load' | 'oom_generate' | 'provider_down' | 'provider_lost' | 'server_busy'
    | 'timeout' | 'format' | 'loop' | 'max_iterations' | 'context_overflow' | 'cancelled'
    | 'interrupted' | 'unknown';
  message: string; raw?: string;
}

/** Transiciones válidas de la máquina de estados (columna §12); usado para validar en tiempo de
 *  ejecución y para generar el diagrama de estados sin duplicar la lista a mano. */
export const RUN_TRANSITIONS: Record<RunState, RunState[]> = {
  created: ['preparing', 'interrupted'],             // 'interrupted' solo la emite recover()
  preparing: ['queued', 'failed', 'interrupted'],     // 'interrupted' solo la emite recover()
  queued: ['generating', 'cancelling', 'failed', 'interrupted'],           // 'interrupted' solo la emite recover()
  generating: ['parsing', 'cancelling', 'failed', 'interrupted'],          // 'interrupted' solo la emite recover()
  parsing: ['completed', 'awaiting_permission', 'executing_tool', 'cancelling', 'failed', 'interrupted'],  // 'interrupted' solo la emite recover()
  awaiting_permission: ['executing_tool', 'parsing', 'cancelling', 'failed'],  // 'failed': chat/proyecto borrado mientras se esperaba respuesta
  executing_tool: ['compacting', 'queued', 'cancelling', 'failed', 'interrupted'],  // 'interrupted' solo la emite recover()
  compacting: ['queued', 'failed', 'interrupted'],    // 'interrupted' solo la emite recover()
  cancelling: ['cancelled'],
  completed: [], cancelled: [], failed: [], interrupted: [], // terminal; run:continue crea un run nuevo en 'created'
};

/** El RunController orquesta ContextManager, ToolSystem, PermissionEngine, CheckpointService,
 *  TaskManager y ModelGateway; ver flujo completo en la columna §6. Firma resumida: */
export interface RunController {
  start(chatId: string, text: string, mode: Mode): Promise<{ runId: string }>;
  cancel(runId: string): Promise<void>;
  continueRun(runId: string, extraIterations?: number): Promise<{ runId: string }>;   // crea un run nuevo
  recover(): Promise<{ orphaned: ToolCallRecord[]; abandoned: ToolCallRecord[] }>;      // al arrancar la app
}

/** Fila persistida de tool_calls (proyección); distinta de ToolCall (mensaje del modelo). */
export interface ToolCallRecord {
  id: string; runId: string; messageId?: string; iteration: number;
  toolName: string; args: unknown; argsHash: string;
  category: PermissionCategory; risk: Risk; transport: ToolTransport;
  status: ToolCallStatus;
  permissionDecisionId?: string; checkpointId?: string;
  startedAt?: number; finishedAt?: number;
  resultPreview?: string; resultPath?: string; resultIsError?: boolean; error?: RunError;
  matchLevel?: MatchLevel;                    // solo edit_file
}
```

---

## 6. Eventos de Run — `packages/shared/src/events.ts`

MVP: todos los tipos salvo que el payload dependa de una feature v0.2+ (se indica en línea). `RunEvent` es la fuente de verdad (ADR-3): toda fila de proyección se escribe en la misma transacción que su evento.

```ts
export interface ContextBudgetReport {
  numCtx: number; reserveForResponse: number;
  used: { system: number; tools: number; repoMap: number; memory: number; history: number };
  totalUsed: number; fits: boolean;
}

export type RunEvent = { seq: number; runId: string; chatId: string; ts: number } & (
  | { type: 'run.state'; from: RunState; to: RunState; reason?: string }
  | { type: 'context.built'; budget: ContextBudgetReport }
  | { type: 'context.usage'; used: number; budget: number; cacheHitRatio?: number }
  | { type: 'context.compacted'; summaryMessageId: string; tokensBefore: number; tokensAfter: number }
  | { type: 'message.delta'; messageId: string; field: 'content' | 'thinking'; text: string }
  | { type: 'message.done'; message: ChatMessage; metrics: ResponseMetrics }
  | { type: 'tool.registered'; call: ToolCallRecord }
  | { type: 'tool.permission'; request: PermissionRequest }
  | { type: 'tool.decision'; toolCallId: string; decision: PermissionDecision | PermissionAnswer }
  | { type: 'tool.status'; toolCallId: string; status: ToolCallStatus; resultPreview?: string; error?: string }
  | { type: 'tool.progress'; toolCallId: string; text: string }             // salida en vivo de run_command
  | { type: 'checkpoint.created'; checkpoint: Checkpoint }
  | { type: 'checkpoint.reverted'; checkpointId: string; restored: string[]; conflicts: string[]; revertCheckpointId: string }
  | { type: 'tasks.updated'; tasks: Task[] }
  | { type: 'run.adjustment'; adjustment: Adjustment }
  | { type: 'run.error'; error: RunError; recoverable: boolean }
  | { type: 'run.recovered'; orphaned: ToolCallRecord[]; abandoned: ToolCallRecord[] }
);

/** Proyector: aplica un RunEvent a las tablas relacionales dentro de la misma transacción SQLite
 *  que insertó el evento. `saurio db rebuild` vuelve a correr todos los eventos con este contrato. */
export interface EventProjector { apply(event: RunEvent): void }

/** `Omit`/`Pick` sobre un union discriminado no distribuyen (computan sobre `keyof` del union
 *  completo, que son solo las claves comunes); este helper sí, y es obligatorio para tocar
 *  campos de `RunEvent` sin perder el payload de cada variante (from/to, message, call, request, etc.). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface EventStore {
  append(event: DistributiveOmit<RunEvent, 'seq'>): RunEvent;  // persiste + proyecta en una transacción
  since(runId: string, seq: number): RunEvent[];
  lastSeq(runId: string): number;
}
```

---

## 7. Permisos — `packages/runtime/src/permissions/`

MVP: `plan`/`agent`, categorías `read|write|delete|terminal|git_commit|git_push`, `CommandParser` pwsh + bash. `network`/`mcp` son v0.3.

```ts
export interface PermissionRule {
  id?: string; scope: 'session' | 'project' | 'global';
  toolName: string; pattern?: string; decision: PermissionDecisionKind;
  source: 'user' | 'preset' | 'mode' | 'settings';
}

export interface PermissionPolicy {
  preset: 'strict' | 'balanced' | 'trusting';
  rules: PermissionRule[];
  terminalAllowlist: string[];
}

export interface PermissionRequest {
  toolCallId: string; toolName: string; category: PermissionCategory; risk: Risk;
  summary: string; triggeredBy: string;                       // qué regla/default disparó el pedido
  preview?: { diff?: string; command?: string; paths?: string[] };
  rememberOptions: { scope: 'project' | 'global'; suggestedPattern: string }[];
}

export type PermissionDecision =
  | { decision: 'allow' | 'deny'; decidedBy: 'rule' | 'mode'; ruleId?: string; reason: string }
  | { decision: 'ask'; request: PermissionRequest };

export interface PermissionAnswer {
  toolCallId: string; answer: 'allow_once' | 'allow_always' | 'deny';
  rememberScope?: 'project' | 'global'; pattern?: string; reason?: string;
}

/** Orden de evaluación fijo deny -> ask -> allow, sin especificidad
 *  [VERIFICADO EN DOC OFICIAL: code.claude.com/docs/en/permissions]. */
export interface PermissionEngine {
  evaluate(call: ToolClassification & { toolName: string }, mode: Mode, policy: PermissionPolicy): PermissionDecision;
  isProtectedPath(relPath: string): boolean;
  isCriticalCommand(parsed: ParsedCommand): boolean;
  isBlockedByDefault(parsed: ParsedCommand, touchedByRun: Set<string>): boolean;
}

/** Salida de CommandParser (uno por shell: pwsh, bash); cada subcomando debe matchear
 *  para 'allow'; si el parser no está seguro, el resultado fuerza 'ask' [DECISIÓN DE DISEÑO]. */
export interface ParsedCommand {
  raw: string; shell: 'pwsh' | 'bash';
  subcommands: { tokens: string[]; category: PermissionCategory }[];
  confident: boolean;
}

export interface CommandParser { parse(raw: string, shell: 'pwsh' | 'bash'): ParsedCommand }
```

---

## 8. Context Management — `packages/runtime/src/context/`

MVP: presupuesto a 16k, compactación nivel 0 y 2 (nivel 1 solo junto con nivel 2), lectura de `SAURIO.md`. Presupuesto a 32k y `.saurio/rules/*.md` son v0.2.

```ts
export interface ContextBudget {
  numCtx: number; reserveForResponse: number;
  perBlock: { systemAndFewShot: number; toolDefs: number; repoMap: number; memoryAndTasks: number; history: number; margin: number };
}

export interface TokenCounter {
  estimate(text: string, kind: 'prose' | 'code' | 'json' | 'path'): number;
  calibrate(modelRef: ModelRef, estimated: number, measured: number): void;   // EMA sobre token_calibration
}

export interface CompactionResult {
  level: 0 | 1 | 2;
  summaryMessage?: ChatMessage;              // nivel 2: schema { objetivo, archivos_tocados[], decisiones[], ... }
  replacedMessageIds: string[];              // reciben compacted_by; nunca se borran
  tokensBefore: number; tokensAfter: number;
}

export interface Compactor {
  shouldCompact(usedTokens: number, budget: ContextBudget, turnsSinceLast: number, policy: ContextPolicy): boolean;
  compact(history: ChatMessage[], policy: ContextPolicy, model: ModelRef): Promise<CompactionResult>;
}

/** Habla con el ProjectIndexer (utilityProcess); nunca construye el árbol tree-sitter en main. */
export interface RepoMapClient {
  build(projectRoot: string, opts: { budgetTokens: number; mentioned: string[]; touched: string[] }): Promise<{ text: string; tokens: number }>;
  invalidate(changedFiles: string[]): void;
}

/** Ensamblador del prompt: system inmutable -> few-shot -> repo map -> memoria -> resumen ->
 *  historial -> mensaje efímero final. Garantiza tokens <= numCtx - reserveForResponse. */
export interface ContextBuilder {
  build(input: {
    agent: AgentConfig; mode: Mode; history: ChatMessage[]; repoMap: string; projectMemory?: string;
  }): Promise<{ messages: ChatMessage[]; report: ContextBudgetReport }>;
}
```

---

## 9. Checkpoints — `packages/runtime/src/checkpoint/`

MVP completo salvo el shadow-repo detector (v0.3).

```ts
export interface CheckpointService {
  begin(runId: string, toolCallId: string, paths: string[]): Promise<CheckpointHandle>;
  commit(handle: CheckpointHandle): Promise<Checkpoint>;
  diff(checkpointId: string, relPath: string): Promise<{ unified: string; added: number; removed: number }>;
  planRevert(checkpointIds: string[]): Promise<RevertPlan>;
  revert(checkpointIds: string[], resolution: Record<string, RevertResolution>): Promise<RevertResult>;
}

export type RevertResolution = 'restore' | 'keep_mine' | 'skip';

/** Un archivo entra en conflicts cuando hash(actual) !== postHash: el usuario lo editó
 *  después del checkpoint del agente (columna §13). */
export interface RevertConflict { relPath: string; pre?: string; post?: string; current: string }

export interface RevertPlan { restorable: string[]; conflicts: RevertConflict[] }

/** El revert crea a su vez un checkpoint (kind: 'revert'), por lo tanto es reversible. */
export interface RevertResult { restored: string[]; skipped: string[]; revertCheckpointId: string }

export interface BlobStore {
  put(content: Buffer | string): Promise<{ hash: string; size: number }>;
  get(hash: string): Promise<Buffer | null>;
  addRef(hash: string): void; releaseRef(hash: string): void;   // recuento para GC de blobs
}
```

---

## 10. Tasks — `packages/runtime/src/tasks/`

MVP. `Task`/`Plan` ya definidos en §2; acá solo el manager.

```ts
export interface TaskManager {
  update(chatId: string, runId: string, tasks: Omit<Task, 'chatId'>[]): Promise<Task[]>;   // tool task_update
  list(chatId: string): Promise<Task[]>;
}
```

---

## 11. Scheduler y hardware — `packages/runtime/src/models/`

MVP: `HardwareProbe` con CPU/RAM medidos + nvidia-smi bajo demanda; `MemoryEstimator.fits()`. AMD/Apple/registro de Windows son v0.2; `RecommendationEngine` es v0.3.

```ts
/** Cada dato trae su fuente y confiabilidad (condición 11.A); nunca se mezcla measured con
 *  estimated sin decirlo. Ver tabla completa de fuentes en la columna §17. */
export interface HardwareDatum<T> { value: T; unit?: string; quality: Quality; source: string; sampledAt: number }

/** Renombrado desde "hardware_inventory_json" del brief; llamado HardwareProfile en este
 *  documento porque agrupa el snapshot completo con el que se calcula fitClass y recomendaciones
 *  — ver Nomenclatura agregada. */
export interface HardwareProfile {
  cpu: { name: HardwareDatum<string>; threads: HardwareDatum<number>; physicalCores?: HardwareDatum<number> };
  ram: { totalBytes: HardwareDatum<number>; freeBytes: HardwareDatum<number> };
  gpu?: {
    vendor: 'nvidia' | 'amd' | 'apple' | 'other';
    vramTotalBytes: HardwareDatum<number>; vramUsedBytes?: HardwareDatum<number>;
    utilizationPct?: HardwareDatum<number>; temperatureC?: HardwareDatum<number>; powerW?: HardwareDatum<number>;
  };
  fingerprint: string;      // hash(gpu_uuid, vram_total, cpu_model, ram_total); invalida ModelCompat si cambia
  sampledAt: number;
}

export interface HardwareProbe {
  sample(): Promise<HardwareProfile>;
  supportsGpuSampling(): boolean;      // false: nvidia-smi ausente y no hay contador Windows disponible
}

export interface MemoryEstimator {
  fits(ref: ModelRef, numCtx: number, hardware: HardwareProfile): Promise<MemoryEstimate>;
}
```

---

## 12. Project Indexer / Repo Map — `packages/repomap/`

MVP: ts, tsx, js, python; el resto de lenguajes es v0.2.

```ts
export interface RepoTag { file: string; name: string; kind: 'def' | 'ref'; line: number }

export interface RepoGraphNode { file: string; rank: number }

/** Corre en un utilityProcess aparte de main (ADR-1); recibe comandos por su propio canal IPC
 *  interno, no por packages/shared/ipc.ts (ese es solo main <-> renderer). */
export interface ProjectIndexer {
  index(projectPath: string, changedFiles?: string[]): Promise<{ filesIndexed: number; tookMs: number }>;
  rank(query: { mentioned: string[]; touched: string[] }): Promise<RepoGraphNode[]>;
  render(nodes: RepoGraphNode[], budgetTokens: number): Promise<{ text: string; tokens: number }>;
  tagsFor(file: string): Promise<RepoTag[]>;
}
```

---

## 13. Model Hub: catálogo, descargas y recomendaciones — `packages/runtime/src/models/`

MVP: catálogo instalado, capabilities, `fits`, carpeta detectada (modo attach), badge de localidad. `DownloadManager` es v0.2, `RecommendationEngine` y modo managed son v0.3.

```ts
export interface ModelManager {
  listInstalled(refresh?: boolean): Promise<ModelInfo[]>;
  listLoaded(): Promise<LoadedModel[]>;                 // único poller de /api/ps del sistema
  describeModel(ref: ModelRef): Promise<ModelDescription>;
  fits(ref: ModelRef, numCtx: number): Promise<MemoryEstimate>;
  detectedModelsFolder(): Promise<{ path: string; source: 'env:user' | 'env:machine' | 'default'; validated: boolean }>;
}

export interface DownloadJob {                          // v0.2
  id: string; providerId: string; modelName: string;
  status: 'queued' | 'running' | 'paused' | 'cancelled' | 'done' | 'failed';
  totalBytes: number; completedBytes: number;
  layers: { digest: string; total: number; completed: number }[];
  startedAt?: number; finishedAt?: number; error?: string;
}

export interface DownloadManager {                      // v0.2
  checkSpace(modelName: string): Promise<{ neededBytes: number; freeBytes: number; ok: boolean }>;
  pull(modelName: string): Promise<{ downloadId: string }>;
  cancel(downloadId: string): Promise<void>;
  delete(modelName: string): Promise<void>;              // hace unload previo si está cargado
}

export interface ModelCatalogEntry {                     // resources/model-catalog.json, v0.2
  name: string; tag: string; sizeBytes: number; capabilities: ModelCapabilities;
  contextMax: number; suggestedUse: ('coding' | 'chat' | 'analysis' | 'vision')[]; notes?: string;
}

/** Salida del RecommendationEngine (v0.3); función pura sobre inventario x catálogo x ModelCompat.
 *  "tested" solo aparece si existe una fila ModelCompat con status 'fits' para este fingerprint. */
export interface Recommendation {
  catalogEntry: ModelCatalogEntry; fitClass: MemoryEstimate['fitClass'];
  locality: Locality;
  speedHint: 'fast' | 'medium' | 'slow'; usesCpuOffload: boolean;
  tested?: { tokPerSec: number; testedAt: number; hardwareFingerprint: string };  // ausente: sin ModelCompat
}

export interface RecommendationEngine {                  // v0.3
  recommend(hardware: HardwareProfile, use: ModelCatalogEntry['suggestedUse'][number], goal: 'speed' | 'quality'): Promise<Recommendation[]>;
}
```

---

## 14. Métricas y telemetría — `packages/runtime/src/telemetry/`

MVP: métricas por respuesta y por run, `/api/ps` vía ModelManager, CPU/RAM, nvidia-smi bajo demanda. `SystemSampler` continuo y `metrics_minute` son v0.2; diagnósticos completos también v0.2.

```ts
/** Envoltorio genérico: todo número que ve el usuario pasa por acá (regla 6 de la columna). */
export interface Metric<T> { value: T; quality: Quality; source: string; sampledAt: number }

export interface SystemSample {
  cpuPct: Metric<number>; ramUsedBytes: Metric<number>;
  gpuUtilPct?: Metric<number>; vramUsedBytes?: Metric<number>; gpuTempC?: Metric<number>; powerW?: Metric<number>;
  appRssBytes: Metric<number>;                 // app.getAppMetrics()
}

export interface RunMetrics {
  runId: string; promptTokens: number; evalTokens: number; cacheHitRatio?: number;
  tokPerSecPrompt?: number; tokPerSecGen?: number; ttftMsAvg?: number;
  iterations: number; toolCallsByStatus: Partial<Record<ToolCallStatus, number>>;
  wallTimeMs: number; loadMs?: number;
  vramPeakBytes?: Metric<number>; vramBaselineBytes?: Metric<number>;
}

export interface MetricsSnapshot {
  slots: SlotStatus[]; queue: QueuedJob[]; loaded: LoadedModel[]; system: SystemSample;
}

export interface Diagnostic {
  code: 'offload' | 'slow_generation' | 'low_vram' | 'cache_miss' | 'provider_down' | 'oom_load' | 'context_mismatch';
  message: string; evidence: Metric<unknown>[]; suggestedAction?: { label: string; opensSettings?: string };
}

/** Nunca cambia configuración por su cuenta (condición 11.B): solo diagnostica y sugiere. */
export interface Diagnostics { evaluate(snapshot: MetricsSnapshot, history: RunMetrics[]): Diagnostic[] }

export interface MetricsAggregator {
  recordResponse(chatId: string, runId: string, metrics: ResponseMetrics): void;
  recordRun(metrics: RunMetrics): void;
  chatStats(chatId: string): Promise<{ tokens: number; medianTps: number; avgCacheHit: number }>;   // v_chat_stats
  modelStats(providerId: string, modelName: string): Promise<{ tokens: number; medianTps: number; avgCacheHit: number }>; // v_model_stats
}
```

---

## 15. Benchmark y perfiles — `packages/runtime/src/benchmark/`

Todo v0.3 salvo `Profile` (perfil implícito por chat existe conceptualmente desde el MVP; `profiles` como tabla activa es v0.2).

```ts
export interface BenchmarkConfig {
  numCtx: number; kvCacheType?: string; think: boolean; temperature: 0; seed: 42; numPredict: 256;
}

export interface BenchmarkResult {
  loadMs: number; promptTps: number; genTps: number; ttftMs: number;
  peakVramMib: number; baselineVramMib: number; offloadRatio: number; qualityScore?: number;
}

export interface BenchmarkRun {
  id: string; suiteId: string; modelName: string; modelDigest: string;
  config: BenchmarkConfig; results: BenchmarkResult; perTask: { taskId: string; passed: boolean; detail?: string }[];
  compatId?: string; createdAt: number;
}

/** Única escritura de model_compat (columna §19: Benchmark no estima, solo mide). */
export interface ModelCompat {
  id: string; providerId: string; modelName: string; modelDigest: string; hardwareFingerprint: string;
  numCtx: number; kvCacheType?: string; think: string; ollamaVersion?: string; driverVersion?: string;
  sizeBytes: number; sizeVramBytes: number; offloadRatio: number;
  loadMs: number; promptTps: number; genTps: number; ttftMs: number; peakVramMib: number; peakRamMib: number;
  qualityScore?: number; status: 'fits' | 'partial' | 'failed'; error?: string; testedAt: number;
}

export interface BenchmarkSuite {
  id: string; kind: 'speed' | 'quality';
  run(model: ModelRef, gateway: ModelGateway, manager: ModelManager, config: BenchmarkConfig): Promise<BenchmarkRun>;
}

/** Extraída como interfaz propia (antes objeto anónimo embebido en `Profile.config`) para que
 *  `packages/shared/src/domain.ts` tenga una única forma de este dato; `fallbackModel` y el
 *  union de `kvCacheType` ya estaban dados por sentados en la tabla de perfiles built-in. */
export interface ProfileConfig {
  model: ModelRef; fallbackModel?: ModelRef; numCtx: number; temperature: number; topP?: number;
  think: ChatRequest['think']; numPredict: number; keepAlive: string | number;
  contextPolicy: ContextPolicy; maxIterations: number; permissionPreset: PermissionPolicy['preset'];
  timeouts: { commandMs: number };
  kvCacheType?: 'f16' | 'q8_0' | 'q4_0';   // solo managed
}

/** Config resuelta que aplica un chat; los built-in (rapido/equilibrado/calidad) tienen id
 *  estable para poder citarlos en effective_config_json.profileId. `isDefault` distingue,
 *  entre varios perfiles con el mismo `projectId`, cuál es el default (nivel 4 de precedencia);
 *  a lo sumo un perfil por projectId puede tener isDefault === true, regla que aplica la capa
 *  de escritura, no el tipo. */
export interface Profile {
  id: string; projectId?: string; name: string; isBuiltin: boolean; isDefault: boolean;
  config: ProfileConfig;
}

/** AutoAdjustment del brief = Adjustment (§5) ya persistido como fila; alias documentado
 *  para que quede explícito que no hay dos formas de un ajuste — ver Nomenclatura agregada. */
export type AutoAdjustment = Adjustment & { id: string; runId: string; revertedAt?: number };
```

---

## 16. Contrato IPC tipado — `packages/shared/src/ipc.ts` + `main`/`preload`

MVP: todos los canales salvo los marcados `// v0.2` / `// v0.3`.

```ts
import { z } from 'zod';

// Esquemas zod que envuelven los tipos de arriba (z.infer da los tipos TS; se omiten por brevedad)
declare const ProjectSchema: z.ZodType<Project>;
declare const ChatSchema: z.ZodType<Chat>;
declare const ChatHistorySchema: z.ZodType<{ messages: ChatMessage[]; toolCalls: ToolCallRecord[]; checkpoints: Checkpoint[]; tasks: Task[] }>;
declare const ModelRefSchema: z.ZodType<ModelRef>;
declare const ModelInfoSchema: z.ZodType<ModelInfo>;
declare const ModelDescriptionSchema: z.ZodType<ModelDescription>;
declare const LoadedModelSchema: z.ZodType<LoadedModel>;
declare const FitEstimateSchema: z.ZodType<MemoryEstimate>;
declare const CheckpointSchema: z.ZodType<Checkpoint>;
declare const DiffSchema: z.ZodType<{ unified: string; added: number; removed: number }>;
declare const RevertPlanSchema: z.ZodType<RevertPlan>;
declare const RevertReportSchema: z.ZodType<RevertResult>;
declare const PermissionAnswerSchema: z.ZodType<PermissionAnswer>;
declare const ProviderHealthSchema: z.ZodType<{ providerId: string; ok: boolean; version?: string; error?: string }>;
declare const MetricsSnapshotSchema: z.ZodType<MetricsSnapshot>;
declare const BenchRequestSchema: z.ZodType<{ suiteId: string; modelRef: ModelRef; config: BenchmarkConfig }>;
declare const BenchRunSchema: z.ZodType<BenchmarkRun>;                // v0.3
declare const ProfileSchema: z.ZodType<Profile>;                      // v0.2

export const ipc = {
  'project:open':          { input: z.object({ path: z.string().optional() }), output: ProjectSchema },
  'project:list':          { input: z.void(), output: z.array(ProjectSchema) },
  'chat:create':           { input: z.object({ projectId: z.string(), agentId: z.string(), mode: Mode, modelRef: ModelRefSchema }), output: ChatSchema },
  'chat:list':             { input: z.object({ projectId: z.string() }), output: z.array(ChatSchema) },
  'chat:history':          { input: z.object({ chatId: z.string() }), output: ChatHistorySchema },
  'run:start':             { input: z.object({ chatId: z.string(), text: z.string(), mode: Mode }), output: z.object({ runId: z.string() }) },
  'run:cancel':            { input: z.object({ runId: z.string() }), output: z.void() },
  'run:continue':          { input: z.object({ runId: z.string(), extraIterations: z.number().optional() }), output: z.object({ runId: z.string() }) },
  'permission:answer':     { input: PermissionAnswerSchema, output: z.void() },
  'checkpoint:list':       { input: z.object({ chatId: z.string() }), output: z.array(CheckpointSchema) },
  'checkpoint:diff':       { input: z.object({ checkpointId: z.string(), relPath: z.string() }), output: DiffSchema },
  'checkpoint:planRevert': { input: z.object({ checkpointIds: z.array(z.string()) }), output: RevertPlanSchema },
  'checkpoint:revert':     { input: z.object({ checkpointIds: z.array(z.string()), resolution: z.record(z.string(), z.enum(['restore', 'keep_mine', 'skip'])) }), output: RevertReportSchema },  // zod 4.6.5: z.record exige key+value schema
  'models:list':           { input: z.object({ refresh: z.boolean().optional() }), output: z.array(ModelInfoSchema) },
  'models:loaded':         { input: z.void(), output: z.array(LoadedModelSchema) },
  'models:describe':       { input: z.object({ ref: ModelRefSchema }), output: ModelDescriptionSchema },
  'models:fits':           { input: z.object({ ref: ModelRefSchema, numCtx: z.number() }), output: FitEstimateSchema },
  'models:pull':           { input: z.object({ name: z.string() }), output: z.object({ downloadId: z.string() }) },   // v0.2
  'models:pullCancel':     { input: z.object({ downloadId: z.string() }), output: z.void() },                          // v0.2
  'models:delete':         { input: z.object({ name: z.string() }), output: z.void() },                                // v0.2
  'provider:health':       { input: z.void(), output: z.array(ProviderHealthSchema) },
  'terminal:create':       { input: z.object({ projectId: z.string(), shell: z.string().optional() }), output: z.object({ terminalId: z.string() }) },
  'terminal:resize':       { input: z.object({ terminalId: z.string(), cols: z.number(), rows: z.number() }), output: z.void() },
  'terminal:close':        { input: z.object({ terminalId: z.string() }), output: z.void() },
  'metrics:snapshot':      { input: z.void(), output: MetricsSnapshotSchema },
  'settings:get':          { input: z.object({ key: z.string(), projectId: z.string().optional() }), output: z.unknown() },
  'settings:set':          { input: z.object({ key: z.string(), value: z.unknown(), projectId: z.string().optional() }), output: z.void() },
  'bench:run':             { input: BenchRequestSchema, output: z.object({ benchmarkRunId: z.string() }) },   // v0.3
  'bench:cancel':          { input: z.object({ benchmarkRunId: z.string() }), output: z.void() },             // v0.3
  'bench:list':            { input: z.object({ modelName: z.string().optional() }), output: z.array(BenchRunSchema) },  // v0.3
  'profiles:list':         { input: z.object({ projectId: z.string().optional() }), output: z.array(ProfileSchema) },  // v0.2
  'profiles:save':         { input: ProfileSchema, output: ProfileSchema },                                    // v0.2
  'profiles:setDefault':   { input: z.object({ projectId: z.string(), profileId: z.string() }), output: z.void() },  // v0.2
} as const;

export type IpcChannel = keyof typeof ipc;
export type IpcInput<C extends IpcChannel> = z.infer<(typeof ipc)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.infer<(typeof ipc)[C]['output']>;

// Eventos main -> renderer (webContents.send), sin invoke/response:
export interface RendererEvents {
  'runtime:event': RunEvent[];                                                  // batched cada 30 ms
  'models:changed': { installed: ModelInfo[]; loaded: LoadedModel[] };
  'download:progress': { downloadId: string; completed: number; total: number; bytesPerSec: number; etaMs: number };  // v0.2
  'download:done': { downloadId: string };                                      // v0.2
  'download:failed': { downloadId: string; error: string };                     // v0.2
  'metrics:tick': MetricsSnapshot;                                               // solo con el panel de rendimiento abierto
  'provider:health': { providerId: string; ok: boolean; version?: string; error?: string };
  'bench:progress': { benchmarkRunId: string; taskId: string; completed: number; total: number };  // v0.3
  'bench:done': { benchmarkRunId: string; result: BenchmarkRun };                // v0.3
  'bench:failed': { benchmarkRunId: string; error: string };                     // v0.3
  // el puerto de datos de la terminal NO viaja por acá: ver 'terminal:port' más abajo
}

/** Firma de registerHandler en main: valida input con zod, ejecuta y valida output antes de
 *  responder; valida además event.senderFrame contra el BrowserWindow dueño de la sesión
 *  [VERIFICADO EN DOC OFICIAL: electronjs.org/docs/latest/tutorial/security]. */
export type IpcHandler<C extends IpcChannel> = (input: IpcInput<C>, meta: { senderFrame: unknown }) => Promise<IpcOutput<C>>;

export declare function registerHandler<C extends IpcChannel>(channel: C, handler: IpcHandler<C>): void;

/** Firma expuesta por el preload vía contextBridge; el renderer nunca ve ipcRenderer crudo.
 *  `terminalPort` NO puede devolver un `MessagePort` como valor de retorno síncrono de una
 *  función de contextBridge [VERIFICADO EN DOC OFICIAL: electronjs.org/docs/latest/tutorial/message-ports].
 *  Contrato real: `terminal:create` (invoke) da `{ terminalId }`; main crea el canal con
 *  `MessageChannelMain` y hace `webContents.postMessage('terminal:port', { terminalId }, [port1])`;
 *  el preload escucha ese canal, guarda `event.ports[0]` y lo reexpone acá vía `onTerminalPort`. */
export interface PreloadApi {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>>;
  onEvent<E extends keyof RendererEvents>(channel: E, cb: (payload: RendererEvents[E]) => void): () => void;
  onTerminalPort(cb: (terminalId: string, port: MessagePort) => void): () => void;
}
```

**Validación en el borde** `[DECISIÓN DE DISEÑO]`: el preload no valida (no puede confiar en sí mismo si el renderer está comprometido); toda validación real ocurre en `main`, en `registerHandler`, con el mismo `input`/`output` de `ipc.ts` — el preload solo tipa. `chat:history`, `checkpoint:list` y `models:list` son de solo lectura y no requieren permiso adicional; `checkpoint:revert`, `run:cancel` y `models:delete` (v0.2) revalidan que el recurso referenciado pertenezca al proyecto activo antes de ejecutar, para que un canal invocado con un id ajeno no cruce proyectos.

---

## Imprescindible para el MVP / Previsto para más adelante

La referencia de alcance por componente es la tabla de la sección 16 de la columna; en términos de este documento:

- **Imprescindible para el MVP:** todas las interfaces de las secciones 1 a 10 y 16 sin comentario de versión; `Provider` sin `pull/delete`; `ToolDefinition.source.kind` limitado en la práctica a `'builtin'`; `ModelManager`/`HardwareProbe` sin AMD/Apple/registro de Windows; `Profile` como concepto (perfil implícito por chat), sin la tabla `profiles` activa.
- **Previsto para más adelante:** `DownloadManager`/`ModelCatalogEntry` (v0.2), `RecommendationEngine`/`Benchmark`/`ModelCompat`/`BenchmarkRun` (v0.3), `McpClient` y `source.kind = 'mcp'` con implementación real (v0.3), `delegate`/subagentes con `parentRunId` funcional (v0.4), `fileScope` (v0.4), `network`/`mcp` como categorías de permiso activas (v0.3), `SystemSample` continuo y `Diagnostics` completos (v0.2), `OpenAICompatProvider` y providers `cloud` (v0.2/v0.4).

---

## Nomenclatura agregada

Nombres que este documento introdujo porque el brief los pedía con un término distinto al de la columna, o porque hacía falta una interfaz auxiliar que la columna no nombra explícitamente:

- **`Session` (brief) → `Chat` + `Run`** `[DECISIÓN DE DISEÑO]`: la columna no usa "Session"; `Chat` es el contenedor persistente (fila `chats`) y `Run` es cada ejecución del agente dentro de un chat (fila `runs`). Se documenta la equivalencia en el JSDoc de `Chat` y `Run` en vez de introducir un tipo `Session` redundante.
- **`InferenceSlot` (brief) → `SlotLease` + `SlotStatus`** `[DECISIÓN DE DISEÑO]`: la columna nombra `SlotLease` (lo que se adquiere/libera) y `SlotStatus` (lo que se reporta a Telemetry/UI); se documentó la equivalencia en el JSDoc de `SlotLease` en vez de agregar un tercer nombre.
- **`HardwareProfile`** `[DECISIÓN DE DISEÑO]`: la columna describe el contenido (`settings.hardware_inventory_json`, tabla de fuentes en §17) pero no lo nombra como tipo; se define acá agrupando los `HardwareDatum<T>` de CPU/RAM/GPU más el `fingerprint` que ya usa `model_compat`.
- **`HardwareDatum<T>`** `[DECISIÓN DE DISEÑO]`: envoltorio genérico `{ value, unit, quality, source, sampledAt }` para no repetir la forma en cada campo de `HardwareProfile`.
- **`ToolClassification`** `[DECISIÓN DE DISEÑO]`: nombre para el tipo de retorno de `ToolDefinition.classify()`, que la columna describe en prosa (categoría real, riesgo, resumen, paths/command) sin nombrarlo.
- **`ToolDefinition.idempotent`** `[DECISIÓN DE DISEÑO]`: campo agregado por el brief ("flags de peligrosidad e idempotencia") que la columna no tiene como campo explícito, aunque sí como regla de comportamiento ("ninguna tool call se reintenta sola", §12). Se agrega el flag para que el runtime pueda decidir reintentos automáticos de errores de transporte (`connection_refused`/`stream_cut`) sin tocar el campo `mutating`, que ya está tomado por "dispara checkpoint".
- **`AutoAdjustment`** `[DECISIÓN DE DISEÑO]`: alias de `Adjustment` (ya persistido, con `id`/`runId`/`revertedAt`) para cubrir el nombre que pide el brief sin duplicar el tipo.
- **`EventProjector`** `[DECISIÓN DE DISEÑO]`: nombre para la función que la columna describe en el ADR-3 ("escritura doble en una transacción") y en `saurio db rebuild`, sin nombrarla como interfaz.
- **`RUN_TRANSITIONS`** `[DECISIÓN DE DISEÑO]`: tabla de transiciones válidas derivada literalmente del diagrama de estados de la columna §12, para que la validación en runtime y la documentación no diverjan.
- **`DistributiveOmit<T, K>`** `[DECISIÓN DE DISEÑO]`: helper de tipos que la columna no define; `Omit`/`Pick` no distribuyen sobre un union discriminado como `RunEvent`, así que cualquier tipo derivado de él (p. ej. `EventStore.append`) necesita esta variante para no perder el payload de cada variante.
- **`ProfileConfig`** `[DECISIÓN DE DISEÑO]`: interfaz extraída del objeto anónimo que antes vivía embebido en `Profile.config`, para que `packages/shared/src/domain.ts` tenga una única forma de este dato (ver Desvíos §3).

---

## Desvíos respecto de la columna vertebral

1. **`RunState.interrupted` es un estado terminal, sin salidas.** Una versión anterior de este documento declaraba `RUN_TRANSITIONS.interrupted = ['queued', 'cancelled']`, lo cual habilitaría reanudar automáticamente el mismo run interrumpido — exactamente lo que prohíbe la condición 4 ("al reiniciar nunca se re-ejecuta automáticamente"). **Se corrigió a `RUN_TRANSITIONS.interrupted = []`** (bloque de la sección 5): el run que queda en `interrupted` no vuelve a ningún estado; `run:continue` no lo reactiva, sino que crea un **run nuevo**, que arranca en `created` como cualquier otro. Como contraparte, `recover()` (doc 10 §5.3, doc 05 §1) necesita poder llevar a `interrupted` a los runs que quedaron abiertos al reiniciar la app; por eso `'interrupted'` aparece como destino válido de `created`, `preparing`, `queued`, `generating`, `parsing`, `executing_tool` y `compacting`, marcado en cada caso `// solo recover()`: esa transición la emite únicamente `recover()` al arrancar, nunca el bucle normal del `RunController`. Se agregó además `awaiting_permission -> failed` para el caso en que el chat o el proyecto se borran mientras un run espera una decisión de permiso.
2. **`ToolDefinition.idempotent` es un campo nuevo, no solo documentado en prosa.** Ver Nomenclatura agregada. Motivo: el brief pide explícitamente "flags de... idempotencia" como campo de la interfaz, y la columna solo lo trata como regla de negocio (nunca reintentar una tool call sola). Se agrega el campo sin cambiar el comportamiento que ya describe la columna: el runtime sigue sin reintentar ninguna tool call por su cuenta; el flag queda disponible para cuando el ADR de reintentos de transporte (columna §6, paso 17) necesite distinguir qué falló antes de la tool (reintentable) de qué falló en la tool (nunca).
3. **`Profile.config` pasa de objeto anónimo a `ProfileConfig` nombrada, con `fallbackModel` y `kvCacheType` tipado.** Una versión anterior de este documento repetía el contenido de `Profile.config` como objeto anónimo, sin `fallbackModel` y con `kvCacheType?: string` sin restricción. Se extrae `ProfileConfig` como interfaz propia (`fallbackModel?: ModelRef`, `kvCacheType?: 'f16' | 'q8_0' | 'q4_0'`) para que sea la única forma de este dato que importa el resto del monorepo, y se agrega `isDefault: boolean` a `Profile` para poder distinguir el perfil default de un proyecto entre varios con el mismo `projectId` (nivel 4 de precedencia). **Nota de alcance:** la columna correspondiente `CREATE TABLE profiles` (doc 03) queda fuera del alcance de esta edición, que se limita al doc 04; agregar ahí `is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1))` queda pendiente como tarea separada sobre ese documento.
4. **`ToolContext.emit` deja de referenciar un campo `payload` inexistente.** Se reemplaza `emit(payload: Extract<RunEvent, { type: 'tool.progress' }>['payload'])` (no compila: ninguna variante de `RunEvent` tiene una propiedad `payload`) por `emit(ev: { toolCallId: string; text: string })`, que es la forma real del payload de `tool.progress` en la sección 6.
5. **`PreloadApi.terminalPort` deja de ser un método síncrono que devuelve `MessagePort`.** Un `MessagePort` de Electron no puede devolverse como valor de retorno de una función de `contextBridge`; se lo transfiere con `webContents.postMessage(canal, datos, [port])` y se recibe como `event.ports[0]`. Se reemplaza por `onTerminalPort(cb)` en `PreloadApi`, con `terminal:create` (ya existente, sin cambios de firma) devolviendo `{ terminalId }` por `invoke` y main abriendo el `MessageChannelMain` por separado.
6. **Tabla `ipc` y `RendererEvents` completadas con los canales de banco de pruebas y perfiles.** Se agregan `bench:cancel`, `bench:list`, `profiles:list`, `profiles:save`, `profiles:setDefault` a la tabla `ipc`, y `bench:progress`/`bench:done`/`bench:failed` y `download:done`/`download:failed` a `RendererEvents`, siguiendo el patrón ya usado por `download:progress` y `models:*`.

---

## Preguntas abiertas

Ninguna de las decisiones de este documento cambia el diseño de la columna vertebral ni reabre alguna de las seis preguntas de su sección 20; no se agregan preguntas nuevas.
