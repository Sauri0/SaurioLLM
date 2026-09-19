// Dominio compartido (zod schemas + tipos inferidos) — packages/shared/src/domain.ts.
// Define: doc 04 §2. El doc 04 declara estas formas como interfaces TS puras; este archivo las
// envuelve en zod porque el doc 04 §16 (ipc.ts) exige `z.ZodType<X>` para cada una de ellas y porque
// la tarea de contratos pide "schemas zod y tipos inferidos" — ver deviations. Las formas (nombres de
// campo, opcionalidad, uniones) son verbatim del doc 04 §2; no se agregan campos no documentados.
import { z } from 'zod';
import {
  Mode, Locality, ChatRole, ToolTransport, PermissionCategory,
  Risk, ToolCallStatus, MatchLevel, Quality, AgentRole,
  AgentOwnerKind, ModelMode, MemorySourceKind, MemoryConfidence, PermissionPreset,
  ChatPermissionPreset, Effort,
} from './enums.js';

export const ProjectSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  createdAt: z.number(),
  lastOpenedAt: z.number(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** ModelRef identifica un modelo ante el Gateway; es serializable (va en effective_config_json). */
export const ModelRefSchema = z.object({
  providerId: z.string(),
  name: z.string(),
  locality: Locality,
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

/** Métricas de una respuesta. Los duration_ns de Ollama son measured; providers /v1 sin
 *  duraciones caen a estimated [VERIFICADO EN DOC OFICIAL: api.md Metrics]. Doc 04 §3.
 *  Movido arriba de `ChatMessageSchema` (antes vivía después) para que `ChatMessageSchema.metrics`
 *  (punto 4 del encargo: "mostrar tokens de entrada/salida... costo 'no disponible' salvo que el
 *  proveedor lo informe") pueda referenciarlo — ya se persistía en `messages.response_metrics_json`
 *  desde antes de esta tarea (`events/projections/messages.ts`), pero `ChatMessage` no lo exponía. */
export const ResponseMetricsSchema = z.object({
  promptTokens: z.number().optional(),
  cachedPromptTokens: z.number().optional(),
  evalTokens: z.number().optional(),
  loadMs: z.number().optional(),
  promptEvalMs: z.number().optional(),
  evalMs: z.number().optional(),
  totalMs: z.number().optional(),
  ttftClientMs: z.number().optional(),
  quality: Quality,
});
export type ResponseMetrics = z.infer<typeof ResponseMetricsSchema>;

export const ContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  // base64; MVP solo si el modelo tiene vision
  z.object({ type: z.literal('image'), mime: z.string(), data: z.string() }),
  // v0.3: adjuntos de MCP
  z.object({ type: z.literal('resource'), uri: z.string(), text: z.string().optional() }),
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
  index: z.number().optional(),
  transport: ToolTransport,
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.object({
  content: z.array(ContentPartSchema),
  isError: z.boolean(),
  structured: z.unknown().optional(),
  // > 30.000 chars: preview + tool-outputs/<id>.txt
  truncated: z.boolean().optional(),
  fullOutputPath: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: ChatRole,
  content: z.string(),
  thinking: z.string().optional(),
  images: z.array(z.string()).optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  tokenEstimate: z.number().optional(),
  /** true: mensaje del recordatorio final; nunca se persiste ni entra al prefijo cacheado. */
  ephemeral: z.boolean().optional(),
  /** true: el provider se cortó a mitad de generación y este es el fragmento parcial recibido
   *  (doc 10 §6 caso 3, doc 07 §4.5). `ContextBuilder` antepone "[respuesta cortada]" cuando este
   *  mensaje entra a un prompt de un run distinto del que lo generó (run:continue); el reintento
   *  inmediato del mismo turno nunca lo agrega a `history` en primer lugar, así que queda excluido
   *  sin necesitar una rama especial. Campo agregado (additive) — packages/runtime/src/{context,agent}
   *  lo consumen y lo escriben. */
  truncated: z.boolean().optional(),
  /** Punto 4 del encargo ("mostrar tokens de entrada/salida y costo 'no disponible' salvo que el
   *  proveedor lo informe"): ya se persistía en `messages.response_metrics_json` (evento
   *  `message.done`, doc 03 §4.3) pero `ChatMessage` no lo exponía hacia `chat:history`/la UI. No hay
   *  campo de costo porque ningún Provider del MVP lo informa (OllamaProvider/OpenAICompatProvider/
   *  AnthropicProvider no devuelven precio) — la UI muestra "no disponible" por ausencia de este campo
   *  o de `promptTokens`/`evalTokens`, sin inventar una cifra. */
  metrics: ResponseMetricsSchema.optional(),
  /** Punto 4 del encargo (doc 16 §10.4/§10.9: "la insignia NUBE por mensaje usa ese dato histórico"):
   *  el `ModelRef` (incluida su `locality`) del modelo que efectivamente generó ESTE mensaje, no el
   *  modelo VIGENTE del chat (que puede haber cambiado desde entonces). Persistido en
   *  `messages.model_ref_json` (migración 0003); mensajes de antes de esa migración quedan sin este
   *  campo — la UI cae al modelo vigente del chat en ese caso (mismo comportamiento previo). */
  modelRef: ModelRefSchema.optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  ord: z.number(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done', 'skipped']),
});
export type Task = z.infer<typeof TaskSchema>;

/** Salida estructurada del modo plan (tool finish con schema). */
export const PlanSchema = z.object({
  runId: z.string(),
  summary: z.string(),
  tasks: z.array(TaskSchema),
});
export type Plan = z.infer<typeof PlanSchema>;

export const CheckpointFileSchema = z.object({
  relPath: z.string(),
  change: z.enum(['created', 'modified', 'deleted']),
  preHash: z.string().optional(),
  postHash: z.string().optional(),
  // archivo > 20 MB: hash sin blob
  blobMissing: z.boolean().optional(),
});
export type CheckpointFile = z.infer<typeof CheckpointFileSchema>;

export const CheckpointSchema = z.object({
  id: z.string(),
  runId: z.string(),
  chatId: z.string(),
  toolCallId: z.string().optional(),
  kind: z.enum(['tool', 'revert']),
  files: z.array(CheckpointFileSchema),
  stats: z.object({ files: z.number(), added: z.number(), removed: z.number() }),
  status: z.enum(['active', 'reverted', 'partial']),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

/** El "chat" de la columna es la unidad de conversación persistente por agente y proyecto;
 *  es el equivalente de lo que el brief llama "Session" — ver doc 04, Nomenclatura agregada. */
export const ChatSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  agentId: z.string(),
  title: z.string().optional(),
  mode: Mode,
  modelRef: ModelRefSchema.optional(),
  profileId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archived: z.boolean(),
  /** Doc 19 §2.1 (E3a delegación, migración 0005): presente cuando este chat es el CHAT HIJO que
   *  `RunController.runDelegateTool` crea para una delegación — apunta al run PADRE que la disparó.
   *  `undefined` para cualquier chat normal (comportamiento previo, todos los chats existentes). */
  originRunId: z.string().optional(),
  /** Feedback real v0.2.1, punto 1a: preset de permisos vigente para ESTE chat (`chat:setPermissionPreset`).
   *  `undefined` = chats creados antes de esta migración; el runtime cae a 'ask' (comportamiento más
   *  conservador, nunca se asume un preset más permisivo por default). */
  permissionPreset: ChatPermissionPreset.optional(),
  /** Feedback real v0.2.1, punto 1b: nivel de esfuerzo vigente para ESTE chat (`chat:setEffort`).
   *  `undefined` = default 'balanced' (packages/runtime/src/agent/modelPolicy.ts). */
  effort: Effort.optional(),
});
export type Chat = z.infer<typeof ChatSchema>;

// ── Feedback real v0.2.1, punto 1c: adjuntos de `run:start` ──────────────────────────────────────
/** Un adjunto que el usuario sube junto con su mensaje. Exactamente uno de `path`/`dataBase64` debe
 *  venir con contenido (el otro queda vacío) — `path` cuando el archivo ya está en disco (más liviano
 *  para IPC), `dataBase64` cuando viene del portapapeles/drag-drop sin path real. Límites de tamaño
 *  los aplica el handler de `run:start` (no el schema, que solo valida forma) antes de aceptar la tool
 *  call — ver apps/desktop/src/main/ipc/run.ts. */
export const AttachmentSchema = z.object({
  kind: z.enum(['file', 'image']),
  name: z.string(),
  mime: z.string(),
  path: z.string().optional(),
  dataBase64: z.string().optional(),
  sizeBytes: z.number().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

// ── Feedback real v0.2.1, punto 12: proyectos persistentes ("como Claude Code/Codex") ────────────
/** Fila de `project:recent` — igual que `Project` pero con lo que la lista de proyectos abiertos
 *  necesita mostrar sin una llamada aparte por proyecto: cantidad de chats y si la carpeta todavía
 *  existe en disco (para avisar "carpeta no encontrada" en vez de fallar `project:open` en silencio). */
export const ProjectRecentSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  lastOpenedAt: z.number(),
  chatCount: z.number(),
  folderExists: z.boolean(),
});
export type ProjectRecent = z.infer<typeof ProjectRecentSchema>;

// ── Formas cruzadas por RunEvent/IPC (doc 04 §5, §6, §7) ────────────────────
// Regla de doc 02 §3 "Dónde van los schemas zod compartidos": un shape usado por más de una
// capa (acá, por el discriminated union de RunEvent y por el mapa ipc) se define una sola vez
// en packages/shared; packages/runtime/src/{gateway,agent,permissions}/types.ts reexportan el
// tipo desde acá en vez de redefinirlo. El doc 04 las ubica en prosa dentro de esas secciones de
// runtime porque describe el módulo que las produce, no dónde vive el schema zod — ver deviations.

/** Doc 04 §7. */
export const PermissionRequestSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  category: PermissionCategory,
  risk: Risk,
  summary: z.string(),
  triggeredBy: z.string(),
  preview: z.object({
    diff: z.string().optional(),
    command: z.string().optional(),
    paths: z.array(z.string()).optional(),
  }).optional(),
  rememberOptions: z.array(z.object({
    scope: z.enum(['project', 'global']),
    suggestedPattern: z.string(),
  })),
  /** Campos agregados (additive, doc 06 §5/§6/§8/§12): antes de esta tarea se representaban sin
   *  tocar el schema (`noAllowOption` como `rememberOptions: []`, `forceWarning` como prefijo
   *  "COMANDO CRÍTICO:" en `triggeredBy` + `risk: 'high'`, packages/runtime/src/permissions/engine.ts)
   *  — esa dualidad hacía que un cliente no pudiera distinguir "no hay patrón sugerido para esto" de
   *  "invariante: nunca se puede permitir siempre", ni "es de verdad crítico" de "un preset estricto
   *  eligió ask". Ahora son campos reales y explícitos; `DefaultPermissionEngine` los produce y
   *  `rememberOptions`/`triggeredBy` dejan de cargar ese significado extra (ver deviations). */
  noAllowOption: z.boolean().optional(),
  forceWarning: z.boolean().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

/** Doc 04 §7. */
export const PermissionDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.enum(['allow', 'deny']),
    decidedBy: z.enum(['rule', 'mode']),
    ruleId: z.string().optional(),
    reason: z.string(),
  }),
  z.object({
    decision: z.literal('ask'),
    request: PermissionRequestSchema,
  }),
]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/** Doc 04 §7. */
export const PermissionAnswerSchema = z.object({
  toolCallId: z.string(),
  answer: z.enum(['allow_once', 'allow_always', 'deny']),
  rememberScope: z.enum(['project', 'global']).optional(),
  pattern: z.string().optional(),
  reason: z.string().optional(),
});
export type PermissionAnswer = z.infer<typeof PermissionAnswerSchema>;

/** Un ajuste automático concreto; el único del MVP es capear numCtx a contextMax (ADR-7). Doc 04 §5. */
export const AdjustmentSchema = z.object({
  param: z.string(),
  requested: z.unknown(),
  applied: z.unknown(),
  reason: z.string(),
  source: z.enum(['auto', 'user']),
  evidenceCompatId: z.string().optional(),   // liga a ModelCompat cuando hay evidencia (v0.2+)
});
export type Adjustment = z.infer<typeof AdjustmentSchema>;

/** Doc 04 §5. */
export const RunErrorSchema = z.object({
  code: z.enum([
    'oom_load', 'oom_generate', 'provider_down', 'provider_lost', 'server_busy',
    'timeout', 'format', 'loop', 'max_iterations', 'context_overflow', 'cancelled',
    'interrupted', 'unknown',
  ]),
  message: z.string(),
  raw: z.string().optional(),
});
export type RunError = z.infer<typeof RunErrorSchema>;

/** Fila persistida de tool_calls (proyección); distinta de ToolCall (mensaje del modelo). Doc 04 §5. */
export const ToolCallRecordSchema = z.object({
  id: z.string(),
  runId: z.string(),
  messageId: z.string().optional(),
  iteration: z.number(),
  toolName: z.string(),
  args: z.unknown(),
  argsHash: z.string(),
  category: PermissionCategory,
  risk: Risk,
  transport: ToolTransport,
  status: ToolCallStatus,
  permissionDecisionId: z.string().optional(),
  checkpointId: z.string().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  resultPreview: z.string().optional(),
  resultPath: z.string().optional(),
  resultIsError: z.boolean().optional(),
  error: RunErrorSchema.optional(),
  matchLevel: MatchLevel.optional(),      // solo edit_file
  /** Campo agregado (additive, doc 10 §3/§5.2, doc 09 §3): espeja `tool_calls.expected_pre_hash`
   *  (columna reservada desde la migración 1) para que edit_file/write_file/delete_file puedan
   *  chequear "¿cambió el archivo desde que lo leí?" contra SQLite en vez de solo contra el
   *  `ReadTracker` en memoria de packages/runtime/src/tools — sobrevive a un reinicio real del
   *  proceso. `undefined`/ausente: el run nunca leyó ese path antes de esta tool call. */
  expectedPreHash: z.string().optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

// ── Gateway: capabilities/info/estimación de memoria (doc 04 §3) ────────────
// Cruzan IPC (models:list/describe/fits) -> viven en shared por la misma regla de doc 02 §3.

export const ModelCapabilitiesSchema = z.object({
  tools: z.boolean(), thinking: z.boolean(), vision: z.boolean(), embedding: z.boolean(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const ModelInfoSchema = z.object({
  ref: ModelRefSchema,
  digest: z.string(),
  sizeBytes: z.number(),
  family: z.string(),
  parameterSize: z.string(),
  quantization: z.string(),
  capabilities: ModelCapabilitiesSchema,
  contextMax: z.number().optional(),
  remoteHost: z.string().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/** Extiende ModelInfo con lo que trae /api/show; modelInfo es el bag crudo (arch, block_count, etc.)
 *  [VERIFICADO EN DOC OFICIAL: api/types.go ShowResponse]. Doc 04 §3. */
export const ModelDescriptionSchema = ModelInfoSchema.extend({
  modelInfo: z.record(z.string(), z.unknown()),
  template: z.string().optional(),
  parameters: z.string().optional(),
});
export type ModelDescription = z.infer<typeof ModelDescriptionSchema>;

/** Resultado de /api/ps para un modelo cargado. Doc 04 §3. */
export const LoadedModelSchema = z.object({
  name: z.string(), digest: z.string(), size: z.number(), sizeVram: z.number(),
  contextLength: z.number(), expiresAt: z.string(),
});
export type LoadedModel = z.infer<typeof LoadedModelSchema>;

/** Estimación de VRAM/RAM antes de cargar; ver fórmula en la columna §9.
 *  fitClass y bytes son [HIPÓTESIS A PROBAR] hasta que exista un ModelCompat para el hardware
 *  actual. Doc 04 §3. */
export const MemoryEstimateSchema = z.object({
  vramNeededBytes: z.number(),
  vramAvailableBytes: z.number(),
  fitClass: z.enum(['fits_gpu', 'tight', 'partial_offload', 'no_fit']),
  quality: Quality,      // 'estimated' salvo que exista ModelCompat -> 'measured'
  source: z.enum(['formula', 'model_compat']),
  hardwareFingerprint: z.string().optional(),      // presente cuando source === 'model_compat'
});
export type MemoryEstimate = z.infer<typeof MemoryEstimateSchema>;

// ── Scheduler: estado de slots/cola (doc 04 §3) — usados por MetricsSnapshot ─

export const SlotStatusSchema = z.object({
  slotId: z.string(),
  providerId: z.string(),
  state: z.enum(['idle', 'loading', 'busy']),
  currentModel: ModelRefSchema.optional(),
  leaseHolderRunId: z.string().optional(),
});
export type SlotStatus = z.infer<typeof SlotStatusSchema>;

export const QueuedJobSchema = z.object({
  runId: z.string(),
  ref: ModelRefSchema,
  priority: z.enum(['interactive', 'subagent', 'benchmark', 'warmup']),
  enqueuedAt: z.number(),
});
export type QueuedJob = z.infer<typeof QueuedJobSchema>;

// ── Checkpoints: diff/revert (doc 04 §9) ─────────────────────────────────────

export const DiffResultSchema = z.object({ unified: z.string(), added: z.number(), removed: z.number() });
export type DiffResult = z.infer<typeof DiffResultSchema>;

/** Un archivo entra en conflicts cuando hash(actual) !== postHash: el usuario lo editó
 *  después del checkpoint del agente (columna §13). Doc 04 §9. */
export const RevertConflictSchema = z.object({
  relPath: z.string(), pre: z.string().optional(), post: z.string().optional(), current: z.string(),
  /** Campo agregado (additive, doc 09 §5.3 "Atribución del conflicto"): presente cuando `planRevert`
   *  encontró, en CUALQUIER checkpoint (no solo los de la selección), una fila `checkpoint_files` más
   *  reciente cuyo `post_hash` coincide con el hash actual — es decir, el contenido de hoy también lo
   *  dejó un agente, en `runId`/`chatId`, no necesariamente el usuario. Ausente: "el usuario editó
   *  después" (default de la UI, sin necesidad de un booleano aparte). */
  editedBy: z.object({ runId: z.string(), chatId: z.string(), at: z.number() }).optional(),
});
export type RevertConflict = z.infer<typeof RevertConflictSchema>;

/** Campo agregado (additive, doc 09 §5.3 "uncoveredEffects"): tool calls `run_command` del mismo run
 *  que un checkpoint de la selección, en estado `done`/`failed`, cuyo `finishedAt` cae dentro del
 *  rango de la selección — el revert de archivos no deshace estos efectos (doc 09 §6). */
export const UncoveredEffectSchema = z.object({
  toolCallId: z.string(), toolName: z.string(), command: z.string().optional(),
  category: PermissionCategory, finishedAt: z.number(),
});
export type UncoveredEffect = z.infer<typeof UncoveredEffectSchema>;

export const RevertPlanSchema = z.object({
  restorable: z.array(z.string()),
  conflicts: z.array(RevertConflictSchema),
  /** Campo agregado (additive, doc 09 §5.3): siempre presente (posiblemente vacío) — no es opcional
   *  porque "no hay efectos no cubiertos" es información tan real como "sí los hay". */
  uncoveredEffects: z.array(UncoveredEffectSchema).default([]),
  /** Campo agregado (additive, doc 09 §5.3/§5.4): presente solo si el proyecto tiene `.git` y algún
   *  checkpoint de la selección guardó un `git_head` (doc 09 §2.2) que difiere del `HEAD` actual —
   *  ambas lecturas de solo lectura (`git rev-parse HEAD` / `--abbrev-ref HEAD`). */
  branchChanged: z.object({
    was: z.object({ sha: z.string(), branch: z.string() }),
    now: z.object({ sha: z.string(), branch: z.string() }),
  }).optional(),
});
export type RevertPlan = z.infer<typeof RevertPlanSchema>;

/** El revert crea a su vez un checkpoint (kind: 'revert'), por lo tanto es reversible. Doc 04 §9. */
export const RevertResultSchema = z.object({
  restored: z.array(z.string()), skipped: z.array(z.string()), revertCheckpointId: z.string(),
});
export type RevertResult = z.infer<typeof RevertResultSchema>;

// ── Archivos: árbol lazy por carpeta (doc 16 §11: `files:tree` no existía en el contrato IPC;
// FilesPanel lo invocaba con `invokeRaw` y se degradaba con un aviso) ───────────────────────────
/** Un nivel del árbol de archivos del proyecto. `files:tree` es perezoso por carpeta (doc del
 *  encargo, punto 1): cada llamada devuelve solo los hijos directos de `relPath` (o de la raíz si
 *  se omite), nunca el árbol completo recursivo — evita recorrer node_modules/.git enteros de una.
 *  `hasChildren` le dice a la UI si mostrar la flecha de expandir sin pedir ya los nietos. */
export const FileTreeNodeSchema = z.object({
  relPath: z.string(),
  name: z.string(),
  kind: z.enum(['file', 'dir']),
  hasChildren: z.boolean().optional(),
  sizeBytes: z.number().optional(),
  externallyModified: z.boolean().optional(),
});
export type FileTreeNode = z.infer<typeof FileTreeNodeSchema>;

export const FileReadResultSchema = z.object({
  relPath: z.string(),
  content: z.string(),
  sizeBytes: z.number(),
  truncated: z.boolean(),
});
export type FileReadResult = z.infer<typeof FileReadResultSchema>;

// ── Centro de modelos v0.2: carpeta OLLAMA_MODELS detectada (doc 16 §12, doc 13 §6/§12) ────────
// Mismos nombres de campo que `DetectedModelsFolder`/`AttachWarning` de
// packages/runtime/src/models/ModelManager.ts (`detectedModelsFolder()`/`attachWarnings()`, ya
// implementados ahí — el gap real que registraba doc 16 §12 era solo la falta de canal IPC).
export const AttachWarningSchema = z.object({
  code: z.enum(['context_256k_default', 'network_exposed']),
  message: z.string(),
});
export type AttachWarning = z.infer<typeof AttachWarningSchema>;

export const ModelsFolderInfoSchema = z.object({
  path: z.string(),
  source: z.enum(['env:user', 'env:machine', 'default']),
  validated: z.boolean(),
  freeBytes: z.number().optional(),
  totalBytes: z.number().optional(),
  spaceQuality: Quality,
  warnings: z.array(AttachWarningSchema),
});
export type ModelsFolderInfo = z.infer<typeof ModelsFolderInfoSchema>;

// ── Centro de modelos: catálogo curado y recomendaciones (doc 13 §3/§8, v0.2/v0.3) ──────────────

export const ModelCatalogEntrySchema = z.object({
  name: z.string(),
  tag: z.string(),
  sizeBytes: z.number(),
  capabilities: ModelCapabilitiesSchema,
  contextMax: z.number(),
  quantization: z.string().optional(),
  suggestedUse: z.array(z.enum(['coding', 'chat', 'analysis', 'vision'])),
  notes: z.string().optional(),
  /** Punto 4 del encargo (doc 16, "modelos con X / sin compatibilidad para descargar"): variante de
   *  NUBE de Ollama (tag terminado en "-cloud", o alias "cloud" — corre en los servidores de Ollama,
   *  nunca en la PC del usuario). `sizeBytes` en estas entradas es siempre 0 (no ocupa disco local);
   *  la UI las muestra aparte con insignia NUBE, ocultas por defecto, y nunca ofrece "Descargar". */
  cloud: z.boolean().optional(),
  /** Variante LOCAL cuyo tamaño no se pudo confirmar por parseo del HTML de ollama.com/library
   *  (formato de la página cambió, o la fila no trae el dato) — antes se descartaba en silencio y
   *  desaparecía del catálogo sin explicación; ahora se muestra igual (con `sizeBytes: 0` de
   *  placeholder) y la ficha la resuelve contra el registry de Ollama al abrirla
   *  (`models:resolveByName`), quedando descargable. */
  sizeUnresolved: z.boolean().optional(),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

/** Escala de seis niveles para "¿me conviene este modelo en esta PC?" (sesión 2026-09-18, cobertura
 *  máxima del catálogo) — espejo zod de `@saurio/runtime` `ModelTier`
 *  (`packages/runtime/src/models/TierClassifier.ts`, que es la única fuente de la lógica; acá solo se
 *  declara la forma para que cruce IPC). Campo ADITIVO en `CatalogItemSchema`/`RecommendationSchema`:
 *  nada que ya consumía esos tipos se rompe si `tier` viene `undefined` (p. ej. mientras no se pudo
 *  muestrear hardware). */
export const ModelTierSchema = z.object({
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  label: z.string(),
  color: z.enum(['green', 'teal', 'yellow', 'orange', 'red', 'gray']),
  explanation: z.string(),
  quality: z.enum(['measured', 'estimated']),
});
export type ModelTier = z.infer<typeof ModelTierSchema>;

/** Entrada del catálogo curado con estado derivado contra `models`/`downloads` (doc 13 §11: estados
 *  `not_installed | downloading | installed_untested | installed_tested | loaded`, no una columna
 *  SQL nueva). El Centro de modelos (pestaña "Explorar") consume esto en vez del catálogo crudo. */
export const CatalogItemSchema = z.object({
  entry: ModelCatalogEntrySchema,
  status: z.enum(['not_installed', 'downloading', 'installed_untested', 'installed_tested', 'loaded']),
  downloadId: z.string().optional(),
  /** `undefined` solo si no se pudo muestrear el hardware al armar la respuesta (nunca por diseño:
   *  el handler de `models:catalog` siempre lo intenta, doc 13 §2 "para priorizar calidad"). */
  tier: ModelTierSchema.optional(),
});
export type CatalogItem = z.infer<typeof CatalogItemSchema>;

export const RecommendationSchema = z.object({
  catalogEntry: ModelCatalogEntrySchema,
  fitClass: z.enum(['fits_gpu', 'tight', 'partial_offload', 'no_fit']),
  locality: Locality,
  speedHint: z.enum(['fast', 'medium', 'slow']),
  usesCpuOffload: z.boolean(),
  tested: z.object({ tokPerSec: z.number(), testedAt: z.number(), hardwareFingerprint: z.string() }).optional(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

// ── Centro de modelos: biblioteca completa de Ollama + Hugging Face (doc 16 §12.6, v0.2) ────────

/** Resultado de `models:hfSearch` — espejo zod de `HuggingFaceSearchResult`
 *  (`@saurio/runtime` `packages/runtime/src/models/HuggingFaceClient.ts`, que es la única fuente de la
 *  lógica de búsqueda; acá solo se declara la forma para que cruce IPC). */
export const HuggingFaceSearchResultSchema = z.object({
  id: z.string(),
  likes: z.number(),
  downloads: z.number(),
  tags: z.array(z.string()),
  pipelineTag: z.string().optional(),
  libraryName: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type HuggingFaceSearchResult = z.infer<typeof HuggingFaceSearchResultSchema>;

/** Resultado de `models:hfFiles` — un archivo `.gguf` de un repo de Hugging Face con su cuantización
 *  parseada del nombre (`HuggingFaceClient.listGgufFiles`). `sizeBytes` es `undefined` si el llamador
 *  no pidió `?blobs=true` (nunca se inventa un tamaño). */
export const HuggingFaceGgufFileSchema = z.object({
  filename: z.string(),
  sizeBytes: z.number().optional(),
  quant: z.string().optional(),
});
export type HuggingFaceGgufFile = z.infer<typeof HuggingFaceGgufFileSchema>;

/** De dónde salió el catálogo devuelto por `models:libraryCatalog` (`OllamaLibraryClient.getCatalog`,
 *  doc 16 §12.6 punto 2): 'network' = se sincronizó ahora contra ollama.com/library; 'cache' = caché en
 *  userData todavía vigente (TTL 24h) o, sin red, una vencida; 'bundled' = snapshot empaquetado con la
 *  app (`resources/model-catalog.snapshot.json`), último recurso sin red y sin caché. La UI muestra
 *  cuál es (nunca finge que el catálogo está siempre fresco). */
export const LibraryCatalogSourceSchema = z.enum(['cache', 'network', 'bundled']);
export type LibraryCatalogSource = z.infer<typeof LibraryCatalogSourceSchema>;

export const LibraryCatalogResultSchema = z.object({
  items: z.array(CatalogItemSchema),
  source: LibraryCatalogSourceSchema,
  cachedAt: z.number().optional(),
  // Fecha de generación del snapshot devuelto (ISO), presente para las tres fuentes (incluida
  // 'bundled', que no tiene `cachedAt` porque nunca se cacheó en userData) — la UI la usa para
  // "Catálogo del <fecha>" sin importar de dónde salió.
  generatedAt: z.string().optional(),
  // Stale-while-revalidate (doc 16 §16.5): `true` cuando lo devuelto es caché vencida o el snapshot
  // empaquetado y YA se disparó una sincronización real en segundo plano contra ollama.com/library —
  // la UI muestra "actualizando…" y espera el evento `models:libraryUpdated` para refrescarse sola.
  syncing: z.boolean().optional(),
  familyCount: z.number(),
  variantCount: z.number(),
});
export type LibraryCatalogResult = z.infer<typeof LibraryCatalogResultSchema>;

/** Resultado de `models:resolveByName` ("Descargar por nombre" libre, punto 4 del encargo): valida
 *  contra el registry de Ollama o contra `hf.co/<usuario>/<repo>:<quant>`, sin descargar nada todavía —
 *  la UI usa esto para mostrar tamaño/espacio/nivel ANTES de que el usuario confirme la descarga. */
export const ResolveModelByNameResultSchema = z.object({
  fullName: z.string(),
  source: z.enum(['ollama', 'huggingface']),
  sizeBytes: z.number(),
  freeBytes: z.number().optional(),
  spaceOk: z.boolean(),
  tier: ModelTierSchema.optional(),
});
export type ResolveModelByNameResult = z.infer<typeof ResolveModelByNameResultSchema>;

export const DownloadJobSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  modelName: z.string(),
  status: z.enum(['queued', 'running', 'paused', 'cancelled', 'done', 'failed', 'insufficient_space']),
  totalBytes: z.number(),
  completedBytes: z.number(),
  bytesPerSec: z.number().optional(),
  etaMs: z.number().optional(),
  layers: z.array(z.object({ digest: z.string(), total: z.number(), completed: z.number() })),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  error: z.string().optional(),
});
export type DownloadJob = z.infer<typeof DownloadJobSchema>;

// ── Telemetría: snapshot de métricas del sistema (doc 04 §14) ───────────────

/** Envoltorio genérico: todo número que ve el usuario pasa por acá (regla 6 de la columna). */
export function metricSchema<T extends z.ZodType>(value: T) {
  return z.object({ value, quality: Quality, source: z.string(), sampledAt: z.number() });
}
export interface Metric<T> { value: T; quality: z.infer<typeof Quality>; source: string; sampledAt: number }

export const SystemSampleSchema = z.object({
  cpuPct: metricSchema(z.number()),
  ramUsedBytes: metricSchema(z.number()),
  gpuUtilPct: metricSchema(z.number()).optional(),
  vramUsedBytes: metricSchema(z.number()).optional(),
  gpuTempC: metricSchema(z.number()).optional(),
  powerW: metricSchema(z.number()).optional(),
  appRssBytes: metricSchema(z.number()),     // app.getAppMetrics()
});
export type SystemSample = z.infer<typeof SystemSampleSchema>;

/** Doc 14 §7: cada diagnóstico trae su evidencia ya etiquetada (medido/estimado/no disponible) y una
 *  acción sugerida — nunca cambia nada solo (packages/runtime/src/telemetry/types.ts, contrato
 *  canónico; este schema espeja esa forma para que pueda cruzar IPC). */
export const DiagnosticSchema = z.object({
  code: z.enum(['offload', 'slow_generation', 'low_vram', 'cache_miss', 'provider_down', 'oom_load', 'context_mismatch', 'queue_backlog']),
  message: z.string(),
  evidence: z.array(metricSchema(z.unknown())),
  suggestedAction: z.object({ label: z.string(), opensSettings: z.string().optional() }).optional(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const MetricsSnapshotSchema = z.object({
  slots: z.array(SlotStatusSchema),
  queue: z.array(QueuedJobSchema),
  loaded: z.array(LoadedModelSchema),
  system: SystemSampleSchema,
  // Doc 14 §7/§9 punto 3 "Diagnósticos": se agrega acá (en vez de un canal aparte) porque el panel
  // de rendimiento siempre los muestra junto al resto del snapshot, y así `metrics:snapshot` y
  // `metrics:tick` (mismo tipo) traen diagnósticos sin duplicar el viaje IPC.
  diagnostics: z.array(DiagnosticSchema).default([]),
});
export type MetricsSnapshot = z.infer<typeof MetricsSnapshotSchema>;

/** Forma ad-hoc que doc 04 §16 declara inline para 'provider:health' (sin interfaz nombrada
 *  en las secciones 1-15); se nombra acá para poder exportar tipo + schema como el resto. */
export const ProviderHealthSchema = z.object({
  providerId: z.string(), ok: z.boolean(), version: z.string().optional(), error: z.string().optional(),
});
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

// ── Proveedores locales/API (doc 18-proveedores.md §3, "qué necesita el host") ──────────────────
// Ajustes > Proveedores (punto 3 del encargo): agregar/editar/borrar un provider configurado por el
// usuario (Ollama attach, OpenAI, OpenRouter, Anthropic, OpenAI-compatible personalizado) + probar
// conexión + listar modelos. La clave de API NUNCA cruza acá en el sentido inverso (host -> renderer):
// `ProviderConfigSchema` solo expone `hasApiKey`/`apiKeyLast4` (punto 1 del encargo).

/** Identifica qué preset de baseUrl/headers usó el usuario al agregar el provider — puramente
 *  informativo para la UI (qué ícono/nombre mostrar, qué baseUrl default sugerir); el contrato real
 *  de inferencia sigue siendo `Provider.kind` (packages/runtime/src/gateway/Provider.ts: 'ollama' |
 *  'openai-compat' | 'cloud'). 'custom' es "OpenAI-compatible personalizado" (baseUrl libre: LM
 *  Studio, llama.cpp server, vLLM, Groq...). */
export const ProviderPresetSchema = z.enum(['ollama', 'openai', 'openrouter', 'anthropic', 'custom']);
export type ProviderPreset = z.infer<typeof ProviderPresetSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string(),
  preset: ProviderPresetSchema,
  kind: z.enum(['ollama', 'openai-compat', 'cloud']),
  label: z.string(),
  baseUrl: z.string(),
  enabled: z.boolean(),
  /** Locality declarada (Ollama/custom se derivan de `baseUrl`; Anthropic es siempre 'cloud') —
   *  se manda ya resuelta para que la UI agrupe/badgee sin reimplementar la heurística de
   *  `classifyLocality` (doc 18 §1). */
  locality: Locality,
  /** true si hay una clave guardada en el almacén seguro del host (Electron `safeStorage`, punto 1
   *  del encargo); el valor real de la clave nunca viaja al renderer. */
  hasApiKey: z.boolean(),
  /** Últimos 4 caracteres de la clave guardada, solo si `hasApiKey`; el resto queda irrecuperable
   *  desde acá (punto 1 del encargo: "el renderer solo ve clave configurada: sí/no y los últimos 4
   *  caracteres"). */
  apiKeyLast4: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** false para el provider Ollama sembrado por defecto (doc 13 §6, `seedOllamaProviderRow`) — no
   *  se puede borrar desde Ajustes > Proveedores, solo deshabilitar. */
  removable: z.boolean(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ProviderTestResultSchema = z.object({
  providerId: z.string(),
  ok: z.boolean(),
  version: z.string().optional(),
  error: z.string().optional(),
  /** Nombres de modelo encontrados (`listModels()`), para que "Probar conexión" pueda mostrar de
   *  una vez "conectado, N modelos" sin un segundo viaje a `models:list`. */
  modelNames: z.array(z.string()).optional(),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;

/** Fila de auditoría de llamadas no locales (punto 4 del encargo: "registrar en audit_log cada
 *  llamada no local"); `audit_log` (doc 03) es genérica (`kind`/`payload_json`) — esta es la forma
 *  específica que usa `kind: 'provider.non_local_call'`. */
export const NonLocalCallAuditEntrySchema = z.object({
  id: z.number(),
  ts: z.number(),
  providerId: z.string(),
  modelName: z.string(),
  locality: Locality,
  runId: z.string(),
});
export type NonLocalCallAuditEntry = z.infer<typeof NonLocalCallAuditEntrySchema>;

// ── Banco de pruebas y perfiles (doc 04 §15) — v0.2/v0.3, solo lo que exige el tipado de ipc.ts ──

/** v0.3. Doc 04 §15. */
export const BenchmarkConfigSchema = z.object({
  numCtx: z.number(), kvCacheType: z.string().optional(), think: z.boolean(),
  temperature: z.literal(0), seed: z.literal(42), numPredict: z.literal(256),
});
export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;

/** v0.3. Doc 04 §15. */
export const BenchmarkResultSchema = z.object({
  loadMs: z.number(), promptTps: z.number(), genTps: z.number(), ttftMs: z.number(),
  peakVramMib: z.number(), baselineVramMib: z.number(), offloadRatio: z.number(), qualityScore: z.number().optional(),
});
export type BenchmarkResult = z.infer<typeof BenchmarkResultSchema>;

/** v0.3. Doc 04 §15; sin implementación, solo el shape que exige el tipado de bench:list en ipc.ts. */
export const BenchmarkRunSchema = z.object({
  id: z.string(), suiteId: z.string(), modelName: z.string(), modelDigest: z.string(),
  config: BenchmarkConfigSchema, results: BenchmarkResultSchema,
  perTask: z.array(z.object({ taskId: z.string(), passed: z.boolean(), detail: z.string().optional() })),
  compatId: z.string().optional(), createdAt: z.number(),
});
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;

/** v0.2. Doc 04 §15, Desvíos §3. `config` se deja como `z.unknown()` a propósito: `ProfileConfig`
 *  completo depende de `ContextPolicy` y `PermissionPolicy['preset']` (packages/runtime/src/{agent,
 *  permissions}/types.ts), que son v0.2/MVP-adyacentes pero cuyo detalle de perfiles activos es v0.2
 *  (doc 04 §15 intro); no se define acá para no anticipar una forma que ese trabajo puede ajustar. */
export const ProfileSchema = z.object({
  id: z.string(), projectId: z.string().optional(), name: z.string(),
  isBuiltin: z.boolean(), isDefault: z.boolean(), config: z.unknown(),
});
export type Profile = z.infer<typeof ProfileSchema>;

// ── Doc 19 §1.2 — E2a "Mis agentes" ──────────────────────────────────────────
// `AgentProfileSchema` NO es un espejo 1:1 de `AgentConfig` (packages/runtime/src/agent/types.ts,
// interfaz TS pura, nunca cruzó IPC hasta esta tarea): expone solo los campos que la vitrina de "Mis
// agentes" y `agents:*` necesitan (identidad + los tres selectores del editor, doc 19 §1.6) — deja
// afuera `contextPolicy`/`permissions.rules`/`maxIterations`/`temperature`/`toolTransport`/
// `defaultMode`/`workingDir`, que siguen siendo responsabilidad exclusiva del `AgentConfig` que
// resuelve `AgentConfigResolver` para el run (`packages/runtime/src/persistence/repositories/agent.ts`
// sigue devolviendo `AgentConfig` completo para eso). Deviation de la letra literal de doc 19 §1.2
// ("extiende el AgentConfigSchema existente") porque ese schema zod no existe — ver arriba.
export const AgentProfileSchema = z.object({
  id: z.string(),
  ownerKind: AgentOwnerKind,
  name: z.string(),
  role: AgentRole,
  description: z.string().optional(),
  avatarEmoji: z.string().optional(),
  avatarColor: z.string().optional(),
  modelMode: ModelMode,
  /** Solo tiene sentido con `modelMode: 'fixed'`; con `'auto'` lo resuelve `agent/modelPolicy.ts`
   *  en cada run (doc 19 §1.5), así que puede faltar acá. */
  model: ModelRefSchema.optional(),
  systemPrompt: z.string(),
  allowedTools: z.array(z.string()),
  permissionPreset: PermissionPreset,
  createdAt: z.number(),
  archivedAt: z.number().optional(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/** Doc 19 §1.1/§1.7: una fila de memoria propia de un agente, con procedencia explícita.
 *  `projectId: undefined` = memoria global del agente (visible en cualquier proyecto);
 *  `AgentMemoryRepository.list` es el único punto que aplica el filtro de privacidad de T09. */
export const AgentMemorySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  projectId: z.string().optional(),
  content: z.string(),
  sourceKind: MemorySourceKind,
  confidence: MemoryConfidence,
  originRef: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  expiresAt: z.number().optional(),
  invalidatedAt: z.number().optional(),
});
export type AgentMemory = z.infer<typeof AgentMemorySchema>;

/** Doc 19 §1.2: "sin plantilla obligatoria... todos los campos salvo `name` tienen default sensato"
 *  (R01 — usar la app sin crear agentes sigue siendo el camino por defecto). `memoryScope`/`projectId`
 *  solo orientan dónde cae la PRIMERA fila de memoria que el agente llegue a escribir; no son columnas
 *  de `agents` (la privacidad real vive en `agent_memories.project_id`, por fila, doc 19 §1.7). */
export const AgentCreateInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  role: AgentRole.default('custom'),
  avatarEmoji: z.string().optional(),
  avatarColor: z.string().optional(),
  modelMode: ModelMode.default('fixed'),
  model: ModelRefSchema.optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  permissionPreset: PermissionPreset.default('balanced'),
  memoryScope: z.enum(['global', 'project']).default('global'),
  projectId: z.string().optional(),
});
export type AgentCreateInput = z.infer<typeof AgentCreateInputSchema>;

// ── Doc 19 §2.2 — E3a "Delegación desde el chat" ─────────────────────────────
// Esquema deliberadamente chico (mitigación central contra la falta de fiabilidad de un modelo de
// 8B, doc 19 §5): 4 campos de entrada, sin anidamiento salvo un `budget` opcional de dos números.

/** Input de la tool `delegate` (packages/runtime/src/tools/builtin/delegate.ts). `targetAgentId`
 *  ausente: `RunController.runDelegateTool` crea un worker efímero (`owner_kind: 'worker'`, doc 19
 *  §0/§2.5) con el `role` pedido en vez de fallar. */
export const DelegationRequestSchema = z.object({
  targetAgentId: z.string().optional(),
  role: AgentRole.optional(),
  task: z.string().min(1),
  expectedDeliverable: z.string().min(1),
  budget: z.object({
    maxIterations: z.number().optional(),
    timeoutMs: z.number().optional(),
  }).optional(),
});
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;

/** Salida de la tool `delegate` — traduce literal el "protocolo de entrega" de la investigación
 *  (doc 19 §2.2). Doc 19 §2.5 paso 6: si el último mensaje del hijo no valida contra este schema, se
 *  envuelve como `{status:'completed', summary:<texto crudo>, uncertainties:['formato no
 *  estructurado']}` en vez de fallar la delegación completa. */
export const DelegationResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'needs_input']),
  summary: z.string(),
  artifacts: z.array(z.object({ path: z.string(), description: z.string() })).optional(),
  uncertainties: z.array(z.string()).optional(),
  nextAction: z.string().optional(),
});
export type DelegationResult = z.infer<typeof DelegationResultSchema>;
