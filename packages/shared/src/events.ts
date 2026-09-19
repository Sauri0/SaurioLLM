// RunEvent como z.discriminatedUnion sobre `type` — packages/shared/src/events.ts.
// Define: doc 04 §6. RunEvent es la fuente de verdad (ADR-3): toda fila de proyección se escribe
// en la misma transacción que su evento (ver EventStore en runtime/persistence/types.ts).
import { z } from 'zod';
import { RunState, ToolCallStatus } from './enums.js';
import {
  ChatMessageSchema, ResponseMetricsSchema, ToolCallRecordSchema, PermissionRequestSchema,
  PermissionDecisionSchema, PermissionAnswerSchema, CheckpointSchema, TaskSchema, AdjustmentSchema,
  RunErrorSchema, ModelRefSchema, ModelResolutionSchema,
} from './domain.js';

export const ContextInspectionReasonSchema = z.enum([
  'not_connected', 'not_configured', 'disabled', 'empty', 'build_failed',
  'budget', 'compaction', 'missing_data', 'truncated_for_limit', 'unavailable_after_restart',
]);

export const ContextInspectionSchema = z.object({
  /** Único contenido potencialmente sensible del inspector: la raíz ya visible del proyecto. Los
   * bloques nunca incluyen prompt, memoria, adjuntos ni secretos completos. */
  projectRoot: z.string(),
  tokenUsageQuality: z.literal('estimated'),
  limitSource: z.enum(['reported', 'provisional']),
  sources: z.array(z.object({
    kind: z.enum([
      'system_prompt', 'environment', 'tools', 'project_instructions',
      'repo_map', 'agent_memory', 'history', 'summary',
    ]),
    status: z.enum(['included', 'absent', 'pruned', 'compacted', 'unavailable']),
    tokens: z.number().int().nonnegative().optional(),
    itemCount: z.number().int().nonnegative().optional(),
    omittedCount: z.number().int().nonnegative().optional(),
    reason: ContextInspectionReasonSchema.optional(),
    provenance: z.string().optional(),
  })),
  /** false en runs rehidratados/continuados que no conservan metadata estructurada de adjuntos. */
  attachmentsKnown: z.boolean(),
  attachments: z.array(z.object({
    name: z.string(),
    kind: z.enum(['file', 'image']),
    status: z.enum(['included', 'excluded']),
    reason: ContextInspectionReasonSchema.optional(),
    truncated: z.boolean(),
  })),
  history: z.object({
    inputMessages: z.number().int().nonnegative(),
    includedMessages: z.number().int().nonnegative(),
    prunedMessages: z.number().int().nonnegative(),
    compactedMessages: z.number().int().nonnegative(),
    summaryIncluded: z.boolean(),
  }),
});
export type ContextInspection = z.infer<typeof ContextInspectionSchema>;

export const ContextBudgetReportSchema = z.object({
  numCtx: z.number(),
  /** Feedback real v0.2.1, punto 1e: el numCtx REAL enviado al provider tras aplicar
   *  `defaultNumCtxFor`/el cap (nunca el máximo teórico del modelo, ej. 262k) — antes la UI mostraba
   *  el contexto vigente usando `contextMax` del modelo, no lo que de verdad se mandó. Opcional/aditivo
   *  para no romper snapshots/tests existentes que arman `ContextBudgetReport` sin este campo; cuando
   *  falta, un consumidor puede seguir cayendo a `numCtx` (mismo comportamiento previo).
   */
  effectiveNumCtx: z.number().optional(),
  /** Ausente en eventos anteriores: no certifica el límite del proveedor. */
  contextLimitSource: z.enum(['reported', 'provisional']).optional(),
  reserveForResponse: z.number(),
  used: z.object({
    system: z.number(), tools: z.number(), repoMap: z.number(), memory: z.number(), history: z.number(),
  }),
  totalUsed: z.number(),
  fits: z.boolean(),
  /** Inspector P4 aditivo. Ausente en eventos legacy. */
  inspection: ContextInspectionSchema.optional(),
});
export type ContextBudgetReport = z.infer<typeof ContextBudgetReportSchema>;

/** Feedback real v0.2.1, punto 1d: fases de una línea de estado simple ("¿qué está haciendo el
 *  agente ahora?") sin que la UI tenga que inferirlo de RunState + tool.status. */
export const RunActivityPhase = z.enum([
  'thinking', 'reading', 'searching', 'editing', 'running_command', 'waiting_permission',
  'compacting', 'answering',
]);
export type RunActivityPhase = z.infer<typeof RunActivityPhase>;

/** Campos comunes a toda variante de RunEvent (doc 04 §6). */
const runEventBase = {
  seq: z.number(),
  runId: z.string(),
  chatId: z.string(),
  ts: z.number(),
};

export const RunEventSchema = z.discriminatedUnion('type', [
  z.object({ ...runEventBase, type: z.literal('run.state'), from: RunState, to: RunState, reason: z.string().optional() }),
  z.object({
    ...runEventBase, type: z.literal('context.built'), budget: ContextBudgetReportSchema,
    modelResolution: ModelResolutionSchema.optional(),
  }),
  z.object({ ...runEventBase, type: z.literal('context.usage'), used: z.number(), budget: z.number(), cacheHitRatio: z.number().optional() }),
  z.object({
    ...runEventBase, type: z.literal('context.compacted'), summaryMessageId: z.string().optional(),
    tokensBefore: z.number(), tokensAfter: z.number(),
    // Additive (packages/runtime/src/context §7.4, doc 16 §4 ítem 5): ids de `messages` que esta
    // compactación marca con `compacted_by = summaryMessageId` (nunca se borran). Opcional porque
    // el "Plan B" de nivel 1 puro (doc 07 §7.3, format falla) no genera `summaryMessageId`.
    replacedMessageIds: z.array(z.string()).optional(),
  }),
  z.object({ ...runEventBase, type: z.literal('message.delta'), messageId: z.string(), field: z.enum(['content', 'thinking']), text: z.string() }),
  z.object({ ...runEventBase, type: z.literal('message.done'), message: ChatMessageSchema, metrics: ResponseMetricsSchema }),
  z.object({ ...runEventBase, type: z.literal('tool.registered'), call: ToolCallRecordSchema }),
  z.object({ ...runEventBase, type: z.literal('tool.permission'), request: PermissionRequestSchema }),
  z.object({ ...runEventBase, type: z.literal('tool.decision'), toolCallId: z.string(), decision: z.union([PermissionDecisionSchema, PermissionAnswerSchema]) }),
  z.object({ ...runEventBase, type: z.literal('tool.status'), toolCallId: z.string(), status: ToolCallStatus, resultPreview: z.string().optional(), error: z.string().optional() }),
  // salida en vivo de run_command
  z.object({ ...runEventBase, type: z.literal('tool.progress'), toolCallId: z.string(), text: z.string() }),
  z.object({ ...runEventBase, type: z.literal('checkpoint.created'), checkpoint: CheckpointSchema }),
  z.object({ ...runEventBase, type: z.literal('checkpoint.reverted'), checkpointId: z.string(), restored: z.array(z.string()), conflicts: z.array(z.string()), revertCheckpointId: z.string() }),
  z.object({ ...runEventBase, type: z.literal('tasks.updated'), tasks: z.array(TaskSchema) }),
  z.object({ ...runEventBase, type: z.literal('run.adjustment'), adjustment: AdjustmentSchema }),
  z.object({ ...runEventBase, type: z.literal('run.error'), error: RunErrorSchema, recoverable: z.boolean() }),
  z.object({ ...runEventBase, type: z.literal('run.recovered'), orphaned: z.array(ToolCallRecordSchema), abandoned: z.array(ToolCallRecordSchema) }),
  // Doc 19 §2.3 (E3a delegación): emitido por el run PADRE (runId/chatId de la base son los del
  // padre) cuando la tool `delegate` crea el run/chat hijo. `parentRunId` repite `runId` a propósito
  // (literal del doc 19 §2.3) para que el payload sea autocontenido sin que un consumidor tenga que
  // saber que `runId` de la base ES el padre. `childChatId` es un campo agregado (additive, no está
  // en la letra literal del doc): sin él, `DelegationCard` no tiene forma de resolver a qué chat abrir
  // con "ver conversación completa" sin escanear todo el stream de eventos del hijo primero.
  z.object({
    ...runEventBase, type: z.literal('run.delegated'),
    parentRunId: z.string(), childRunId: z.string(), childChatId: z.string(),
    targetAgentId: z.string(), task: z.string(),
    toolCallId: z.string().optional(),
  }),
  // Feedback real v0.2.1, punto 1d: reusa RunEvent en vez de un canal aparte — la UI arma una línea
  // de estado simple ("Leyendo archivo.ts…", "Ejecutando comando…") sin tener que traducir RunState.
  z.object({
    ...runEventBase, type: z.literal('run.activity'),
    phase: RunActivityPhase, label: z.string(), toolCallId: z.string().optional(),
  }),
  // Feedback real v0.2.1, punto 10: modelo chico (< ~7B) en modo agente — aviso no bloqueante, la UI
  // lo muestra una sola vez por run (no repetido en cada iteración).
  z.object({
    ...runEventBase, type: z.literal('run.smallModelWarning'),
    modelRef: ModelRefSchema, parameterSize: z.string().optional(),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

/** `Omit`/`Pick` sobre un union discriminado no distribuyen (computan sobre `keyof` del union
 *  completo, que son solo las claves comunes); este helper sí, y es obligatorio para tocar
 *  campos de `RunEvent` sin perder el payload de cada variante (from/to, message, call, request, etc.). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
