// RunController: orquesta un run de punta a punta — packages/runtime/src/agent/RunController.ts.
// Define: doc 05 (flujo completo de una ejecución) + doc 10 (fallos y recuperación). Inyección total
// de dependencias (doc 04 §5 RunController): ContextBuilder, ToolRegistry+ToolProtocol,
// PermissionEngine, CheckpointService, TaskManager y ModelGateway, más los puertos locales de ports.ts.
//
// Nota sobre la máquina de estados (doc 16 §4 ítem 7, cerrado en esta tarea): `RUN_TRANSITIONS`
// (./types.ts) ahora incluye la arista `parsing -> queued` que pide doc 05 §2.5 (pasos 23-25:
// reintento de parseo, "elegí una tool o llamá a finish", permiso denegado — todos vuelven a encolar
// el turno sin pasar por `executing_tool`). El bypass que existía antes en `returnToQueue()` (escribir
// el evento `run.state` a mano porque la arista no estaba en la tabla) se eliminó: `transition()`
// valida y persiste la arista real igual que cualquier otra. También se agregó `queued -> compacting`
// (doc 07 §7.1: el disparador se evalúa al armar el contexto, antes de generar) y `compacting ->
// cancelling` (doc 10 §2: es un estado activo más, ocupa slot real — doc 07 §7.2).
import type {
  Mode, RunState, ChatMessage, ToolCall, ToolResult, PermissionAnswer, PermissionRequest,
  RunError as RunErrorShared, ResponseMetrics, ToolTransport, DelegationRequest, DelegationResult,
  ChatPermissionPreset, Effort, RunActivityPhase, Attachment, ModelRef, AgentMemory, RunEvent,
  ModelResolution,
} from '@saurio/shared';
import { DelegationRequestSchema, DelegationResultSchema } from '@saurio/shared';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { ModelGateway, ChatRequest, JsonSchemaTool } from '../gateway/types.js';
import type {
  ToolRegistry, ToolProtocol, ToolDefinition, ToolContext, CheckpointHandle, ToolClassification,
  WorkspaceFs,
} from '../tools/types.js';
import type { PermissionEngine } from '../permissions/types.js';
import { toAgentLevelPreset } from '../permissions/engine.js';
import type { PermissionMemory } from '../permissions/memory.js';
import { planStepsFromText } from '../tasks/planText.js';
import type { CheckpointService } from '../checkpoint/types.js';
import type { ContextBuilder, RepoMapClient, CompactionResult, ContextInspectionInput } from '../context/types.js';
import { ToolExecutionError } from '../tools/errors.js';
import type {
  EventStore, ChatRepository, MessageRepository, ToolCallRepository, CheckpointRepository,
} from '../persistence/types.js';
import type { TaskManager } from '../tasks/types.js';
import type {
  AgentConfig, EffectiveConfig, RunController as RunControllerContract, ToolCallRecord, Adjustment,
} from './types.js';
import type {
  RunRepository, RunRecord, AgentConfigResolver, Clock, IdGenerator, OrphanDiagnostics, ModelContextProbe,
  LastReadHashes, ModelLayerCountProbe, AgentProfilePort, ModelParameterSizeProbe, ModelVisionProbe,
  ChatCollaboratorPort, AgentMemoryPort,
} from './ports.js';
import { RunStateMachine } from './RunStateMachine.js';
import { LoopDetector } from './LoopDetector.js';
import { DegenerationDetector } from './DegenerationDetector.js';
import { MessageDeltaBatcher } from './deltaBatcher.js';
import { hashArgs } from './hash.js';
import { recover as recoverRuns, synthesizeInterruptedResultMessage, type RecoverResult } from './recover.js';
import { buildEnvironmentPrompt } from './environmentPrompt.js';
import { contextPolicyForNumCtx, hashSystemPrompt } from './defaults.js';
import { textMutationCorrectionFor } from './textMutationCorrection.js';

/** Punto 1c/9 del encargo: tope de caracteres por adjunto de texto (no confundir con el límite de
 *  tamaño de ARCHIVO, que aplica el host antes de siquiera llamar a `start()` — ver
 *  apps/desktop/src/main/ipc/run.ts). Este es el tope de lo que entra al prompt en sí. */
const MAX_ATTACHMENT_TEXT_CHARS = 20_000;

/** Construye el bloque de contexto acotado de los adjuntos `kind: 'file'` (punto 1c/9 del encargo).
 *  Ignora silenciosamente un adjunto sin `dataBase64` (nada que insertar) en vez de fallar todo el
 *  run por un adjunto mal formado — el host ya valida esto antes de llamar a `start()`. */
function buildAttachmentContextBlock(attachments: Attachment[]): string {
  const blocks = attachments
    .filter((a) => a.kind === 'file' && a.dataBase64)
    .map((a) => {
      const raw = Buffer.from(a.dataBase64!, 'base64').toString('utf8');
      const truncated = raw.length > MAX_ATTACHMENT_TEXT_CHARS;
      const body = truncated
        ? `${raw.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}\n…[adjunto truncado, ${raw.length} chars totales]…`
        : raw;
      return `--- Adjunto: ${a.name} ---\n${body}\n--- fin de ${a.name} ---`;
    });
  return blocks.length > 0 ? `\n\n${blocks.join('\n\n')}` : '';
}

/** Punto 10 del encargo: "< ~7B parámetros" — umbral aproximado, documentado como tal (no hay una
 *  línea oficial entre "chico" y "grande"; 7B es el tamaño de referencia que ya usa este repo para
 *  qwen2.5-coder:7b/qwen3:8b, docs/MANUAL.md). */
const SMALL_MODEL_THRESHOLD_B = 7;

/** Parsea `ModelInfo.parameterSize` (ej. "8B", "3.8B", "270M", "1.5b") a billones de parámetros.
 *  `undefined` ante cualquier formato no reconocido — nunca se inventa un tamaño. */
function parseParameterSizeBillions(raw: string): number | undefined {
  const match = /^([\d.]+)\s*([BM])$/i.exec(raw.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return match[2]!.toUpperCase() === 'M' ? value / 1000 : value;
}

const MUTATING_ERROR_RETRY_CODES = new Set(['connection_refused', 'stream_cut']);
const BUSY_RETRY_CODE = 'server_busy';
/** PRIORIDAD CERO punto 2: tope de reintentos SEGUIDOS de `connection_refused` antes de fallar el
 *  run con `provider_down` en vez de reintentar para siempre (ver `retryOrFail`). 3 reintentos de
 *  2s = ~6s de "Generando…" como máximo con el provider caído, un tiempo corto y predecible en vez
 *  de indefinido. */
const MAX_CONNECTION_RETRIES = 3;
/** Un 429/server_busy persistente no puede dejar el run reintentando cada 3s para siempre. Se
 * permiten tres reintentos consecutivos, igual que para un provider que rechaza la conexión. */
const MAX_SERVER_BUSY_RETRIES = 3;
const MAX_FORMAT_RETRIES = 2;
/** Doc 19 §2.5/§5 (E3a delegación): profundidad máxima 1 (un run hijo no puede delegar de nuevo) y
 *  máximo 3 delegaciones por run — límites duros contra un modelo de 8B que delega de más, sin
 *  depender de que el propio modelo se autolimite. */
const MAX_DELEGATION_DEPTH = 1;
const MAX_DELEGATIONS_PER_RUN = 3;
/** Tarea "carga de modelo/oom_load": escalera de fracciones de `block_count` a offloadear a GPU en
 *  cada reintento tras un `oom_load` (75% -> 50% -> 0 = CPU pura). Sin `block_count` real
 *  (`modelLayerCountProbe` no inyectado o sin respuesta), la escalera colapsa a un único paso: `[0]`
 *  — ver `handleOomLoad`. */
const OOM_GPU_RATIOS = [0.75, 0.5, 0];
/** Doc 09 §2.3: únicas tools con `mutating: true` sobre el filesystem en el MVP — las únicas cuyo
 *  `tool_calls.expected_pre_hash` importa (doc 10 §3, ítem 16 de doc 16 §4). */
const MUTATING_FILE_TOOLS = new Set(['edit_file', 'write_file', 'delete_file']);
/** Estados desde los que RUN_TRANSITIONS permite -> cancelling (doc 10 §2; `compacting` se agregó
 *  en esta tarea, ver nota de cabecera del archivo). */
const CANCELLABLE_STATES = new Set<RunState>(['queued', 'generating', 'parsing', 'awaiting_permission', 'executing_tool', 'compacting']);
const TERMINAL_STATES = new Set<RunState>(['completed', 'cancelled', 'failed', 'interrupted']);

/** Serializa memorias ya filtradas por el host como datos con procedencia, no como instrucciones.
 * El contenedor que agrega ContextBuilder es deliberadamente separado de `projectMemory`/SAURIO.md. */
export function formatAgentMemoryForContext(memories: AgentMemory[]): string | undefined {
  if (memories.length === 0) return undefined;
  const sourceLabels: Record<AgentMemory['sourceKind'], string> = {
    user_stated: 'dicho por la persona usuaria',
    inferred: 'inferida',
    file_derived: 'derivada de un archivo',
  };
  const confidenceLabels: Record<AgentMemory['confidence'], string> = {
    confirmed: 'confirmada',
    hypothesis: 'hipótesis',
  };
  return memories.map((memory) => {
    const origin = memory.originRef ? `; origen: ${memory.originRef}` : '';
    const scope = memory.projectId ? 'proyecto actual' : 'global';
    return [
      `--- inicio memoria (${confidenceLabels[memory.confidence]}; ${sourceLabels[memory.sourceKind]}; alcance: ${scope}${origin}) ---`,
      memory.content,
      '--- fin memoria ---',
    ].join('\n');
  }).join('\n\n');
}

function inspectAttachments(attachments: Attachment[]): ContextInspectionInput['attachments'] {
  return attachments.map((attachment) => {
    if (!attachment.dataBase64) {
      return {
        name: attachment.name, kind: attachment.kind, status: 'excluded' as const,
        reason: 'missing_data' as const, truncated: false,
      };
    }
    if (attachment.kind === 'file') {
      const chars = Buffer.from(attachment.dataBase64, 'base64').toString('utf8').length;
      const truncated = chars > MAX_ATTACHMENT_TEXT_CHARS;
      return {
        name: attachment.name, kind: attachment.kind, status: 'included' as const,
        ...(truncated ? { reason: 'truncated_for_limit' as const } : {}), truncated,
      };
    }
    return { name: attachment.name, kind: attachment.kind, status: 'included' as const, truncated: false };
  });
}

export interface RunControllerDeps {
  gateway: ModelGateway;
  tools: ToolRegistry;
  /** Un ToolProtocol por transporte (ADR-6, doc 04 §4); RunController elige según EffectiveConfig.transport. */
  toolProtocols: { native: ToolProtocol; text: ToolProtocol };
  permissions: PermissionEngine;
  checkpoints: CheckpointService;
  context: ContextBuilder;
  taskManager: TaskManager;
  events: EventStore;
  runs: RunRepository;
  chats: ChatRepository;
  messages: MessageRepository;
  toolCalls: ToolCallRepository;
  checkpointRepo?: CheckpointRepository;
  agents: AgentConfigResolver;
  /** Memorias ya autorizadas por el host para este agente y proyecto. El controlador no decide
   * alcance: sólo las agrega como datos etiquetados si el perfil permite leer memoria. */
  agentMemories?: AgentMemoryPort;
  orphanDiagnostics?: OrphanDiagnostics;
  /** WorkspaceFs no es responsabilidad de este módulo (vive en packages/runtime/src/tools/); si no se
   *  provee, cualquier tool cuyo handler use `ctx.fs` fallará explícitamente (ver deviations). */
  workspaceFs?: WorkspaceFs;
  clock: Clock;
  ids: IdGenerator;
  /** Inyectable para que los tests no dependan de temporizadores reales (doc 10: backoff 2s
   *  connection_refused/stream_cut, 3s server_busy). */
  delay?: (ms: number) => Promise<void>;
  /** Timeout por defecto para invocar un `handler` de tool (doc 04 §4 ToolContext.timeoutMs). */
  defaultToolTimeoutMs?: number;
  /** projectRoot pasado a cada ToolContext (doc 04 §4); un único proyecto por RunController en el MVP. */
  projectRoot: string;
  /** Integración del MVP: `ContextBuilder.build` recibe el repo map ya renderizado (doc 04 §8), así
   *  que alguien tiene que pedírselo al indexer antes de armar el prefijo (doc 07 §2). Opcional: sin
   *  esto el run sigue funcionando con `repoMap: ''` (comportamiento previo a la integración). */
  repoMap?: RepoMapClient;
  /** `settings.toolTransportOverrides` (columna vertebral §9): mapa "prefijo del nombre del modelo"
   *  -> transporte, aplicado solo cuando el agente pide `toolTransport: 'auto'`. MEDIDO 2026-09-18:
   *  qwen2.5-coder:7b declara `tools` pero responde en texto plano, así que su override es 'text'. */
  toolTransportOverrides?: Record<string, ToolTransport>;
  /** Doc 16 §4 ítem 1 ("allow_always no persiste"): si se provee, `allow_always`/`deny` con
   *  "recordar" pasan por acá (persisten en `permission_rules`) y las reglas de proyecto/global ya
   *  persistidas se cargan al iniciar cada run (`start`/`continueRun`/tras rehidratar). Opcional:
   *  sin esto, el comportamiento es el previo (nada persiste entre runs). */
  permissionMemory?: PermissionMemory;
  /** Id del proyecto abierto (doc 03 `permission_rules.project_id`); solo hace falta si se provee
   *  `permissionMemory` — sin `projectId`, las reglas `scope: 'project'` no tienen a qué proyecto
   *  atarse y se omiten (documentado como límite conocido, no un fallo). */
  projectId?: string;
  /** Doc 16 §4 ítem 5 (ADR-7): capea `EffectiveConfig.numCtx` contra el `contextMax` real del
   *  modelo (`/api/show`) al entrar en `preparing`, con `run_adjustments` + evento `run.adjustment`.
   *  Opcional: sin esto, `numCtx` se toma tal cual de `ContextPolicy` (comportamiento previo). */
  modelContextProbe?: ModelContextProbe;
  /** Tarea "carga de modelo/oom_load": puerto opcional para conocer `block_count` real del modelo y
   *  poder calcular ~75%/~50% de capas en GPU al reintentar tras un `oom_load` (ver `ports.ts` y
   *  `handleOomLoad`). Opcional: sin esto, el reintento de `oom_load` salta directo a un único
   *  intento con `numGpu: 0` (CPU pura) en vez de una escalera de tres pasos. */
  modelLayerCountProbe?: ModelLayerCountProbe;
  /** Doc 19 §2.5 (E3a delegación): permite crear un worker efímero (`owner_kind: 'worker'`) cuando
   *  `delegate` no trae `targetAgentId` (ver `AgentProfilePort`, ports.ts). Opcional: sin esto,
   *  delegar sin destino explícito falla con un `ToolResult` de error en vez de romper el run. */
  agentProfiles?: AgentProfilePort;
  /** Selección persistida de colaboradores del chat. Al estar presente, una delegación sólo puede
   * apuntar a uno de esos agentes; sin el puerto se conserva el flujo legado de workers efímeros. */
  chatCollaborators?: ChatCollaboratorPort;
  /** Resolución de `modelMode: auto` provista por el host. Recibe por separado la selección explícita
   * del chat para que siempre tenga precedencia. El adaptador debe ofrecer únicamente modelos locales. */
  resolveModelRef?: (
    agent: AgentConfig, chatModelRef?: ModelRef,
  ) => Promise<ModelRef | { ref: ModelRef; resolution: ModelResolution }>;
  /** Punto 10 del encargo (feedback real v0.2.1): permite emitir `run.smallModelWarning` una sola
   *  vez por run cuando el modelo tiene < ~7B parámetros y `mode === 'agent'`. Opcional: sin esto,
   *  el aviso nunca se emite (comportamiento previo — no existía). */
  modelParameterSizeProbe?: ModelParameterSizeProbe;
  /** Punto 1c/9 del encargo (feedback real v0.2.1): permite validar `ModelCapabilities.vision` antes
   *  de aceptar un adjunto de imagen — sin este puerto, cualquier adjunto de imagen falla con un
   *  error accionable (conservador: nunca se asume soporte de visión sin poder confirmarlo). */
  modelVisionProbe?: ModelVisionProbe;
  /** Cambio aditivo mínimo (encargo de apps/desktop, punto 5: "numCtx por defecto por modelo desde
   *  Ajustes debe llegar al runtime"; packages/runtime no es zona de ese encargo — documentado acá y
   *  en docs/architecture/16-estado-de-implementacion.md). Se consulta en `prepareAndQueue` ANTES del
   *  capado de `capNumCtxAgainstModel`, así que una preferencia manual que exceda el `contextMax` real
   *  del modelo se sigue capeando igual. Opcional: sin esto, `numCtx` sigue viniendo de `ContextPolicy`
   *  (comportamiento previo), mismo criterio que `modelContextProbe`. */
  numCtxForModel?: (ref: EffectiveConfig['model']) => Promise<number | undefined> | number | undefined;
  /** Doc 16 §4 ítem 16 / doc 10 §3 (ver `LastReadHashes` en ports.ts): permite que
   *  `executeOneToolCall` escriba `tool_calls.expected_pre_hash` en el mismo alta "write-ahead" que
   *  `tool.registered`, para `edit_file`/`write_file`/`delete_file`. Opcional: sin esto,
   *  `expected_pre_hash` queda `NULL` (comportamiento previo). */
  readHashes?: LastReadHashes;
  /** Doc 16 §4 ítem 9: ventana de agrupación de `message.delta` (ms). Por defecto 30 (ver
   *  `MessageDeltaBatcher`); se expone para tests que quieran una ventana distinta, no para uso real
   *  variable entre runs. */
  messageDeltaBatchMs?: number;
}

interface LiveRun {
  runId: string; chatId: string; agent: AgentConfig; mode: Mode;
  effectiveConfig: EffectiveConfig; iteration: number; state: RunState;
  abort: AbortController;
  loopDetector: LoopDetector;
  history: ChatMessage[];
  contextAttachmentsKnown: boolean;
  contextAttachments: ContextInspectionInput['attachments'];
  contextAttachmentMessageId?: string;
  /** Resuelve cuando llega `answerPermission` para el toolCallId pendiente. */
  pendingPermission?: { toolCallId: string; resolve: (answer: PermissionAnswer) => void };
  cancelRequested: boolean;
  formatRetries: number;
  /** Una única corrección interna para el caso estrecho de un modelo text que pide el contenido de
   * una ruta que read_file puede leer. No es un reintento general ni altera permisos. */
  textMutationCorrections: number;
  /** Una única corrección interna cuando el modo Plan termina en prosa sin un checklist explícito.
   * Nunca convierte esa prosa en tareas: le pide al modelo una lista concreta una sola vez. */
  planCorrections: number;
  /** Respuestas completas producidas por el modelo en este run. El guard de TextToolProtocol sólo
   * puede actuar sobre la primera; un parse retry o cualquier turno posterior queda excluido. */
  generatedResponses: number;
  /** Paths ya escritos/borrados por este run (hallazgo #1/#4): se pasa a `PermissionEngine.evaluate`
   *  como `touchedPaths` para que `isBlockedByDefault` pueda excusar un `git reset --hard`/`checkout`
   *  sobre algo que el run mismo tocó (doc 06 §5). Se completa en `runHandler` tras cada tool mutante
   *  que declare `classification.paths` y termine sin error. */
  touchedPaths: Set<string>;
  /** Turnos transcurridos desde la última compactación (doc 07 §7.1 punto 2, doc 16 §4 ítem 5);
   *  se resetea a 0 cada vez que `ContextBuilder.build` compacta. */
  turnsSinceCompaction: number;
  /** PRIORIDAD CERO (bloqueo real reportado por el usuario tras instalar v0.1, punto 2): cuenta
   *  reintentos SEGUIDOS de `connection_refused` ("Ollama no responde"). Antes de este campo,
   *  `retryOrFail` reintentaba ESTE código para siempre cada 2s sin límite — con Ollama apagado, el
   *  run quedaba "Generando…" de forma indefinida, nunca llegaba a `fail()` (el veredicto de
   *  `LoopDetector.recordError` solo controla el mensaje de "nudge", nunca la decisión de
   *  reintentar/fallar). Se resetea a 0 apenas se recibe cualquier chunk real del provider (la
   *  conexión funcionó), para no penalizar un corte transitorio aislado en medio de una sesión larga. */
  connectionErrorStreak: number;
  /** Reintentos consecutivos de `server_busy`. Es independiente de `connectionErrorStreak` para
   * que un 429 transitorio no convierta un problema de conexión posterior (o viceversa) en un fallo
   * prematuro. Ambos contadores se limpian cuando llega un chunk real del provider. */
  serverBusyErrorStreak: number;
  /** Tarea "carga de modelo/oom_load": último `numGpu` aplicado tras un reintento de `oom_load`
   *  (`undefined` = automático de Ollama, comportamiento previo). Persiste para TODOS los turnos de
   *  ESTE run (`buildChatRequest` lo repite en cada `ChatRequest.options.numGpu`) — una vez que el
   *  modelo entró con menos capas, no tiene sentido volver a intentar el default en el turno
   *  siguiente. "Reversible" (doc de la tarea): un run/chat nuevo (`continueRun`/`start`) arranca con
   *  `numGpuOverride: undefined` de nuevo, sin que este ajuste quede pegado para siempre. */
  numGpuOverride?: number;
  /** Paso actual de la escalera de reintento de `oom_load` (0 = todavía no se intentó bajar
   *  `numGpu`). Ver `handleOomLoad`. */
  oomGpuRetryStep: number;
  /** `block_count` del modelo, consultado una sola vez por run vía `modelLayerCountProbe` (si está
   *  disponible) la primera vez que aparece un `oom_load`; `undefined` si el puerto no está
   *  inyectado o no pudo resolverlo (la escalera cae entonces a un único paso con `numGpu: 0`). */
  oomBlockCount?: number;
  /** Doc 19 §2.1/§2.5 (E3a delegación): copia en memoria de `runs.delegation_depth` (0 = run normal;
   *  1 = run hijo de una delegación). Se fija una sola vez al construir el `LiveRun` en `start()`/
   *  `continueRun()`, a partir de si `chats.origin_run_id` está seteado para este chat. */
  delegationDepth: number;
  enabledCollaboratorIds?: Set<string>;
  childRunIds: Set<string>;
}

type TurnOutcome = 'continue' | 'completed' | 'failed' | 'cancelled';

export class RunController implements RunControllerContract {
  private readonly live = new Map<string, LiveRun>();
  private readonly delegatedIterationBudgets = new Map<string, number>();
  /** Reserva síncrona alrededor de las altas derivadas para que dos clicks de regenerar no pasen
   * juntos el chequeo asíncrono de runs activos antes de que exista la primera fila. */
  private readonly startingChats = new Set<string>();
  private readonly stateMachine = new RunStateMachine();

  constructor(private readonly deps: RunControllerDeps) {}

  // ── API pública (doc 04 §5) ────────────────────────────────────────────

  async start(chatId: string, text: string, mode: Mode, attachments?: Attachment[]): Promise<{ runId: string }> {
    const chat = await this.deps.chats.get(chatId);
    if (!chat) throw new Error(`Chat inexistente: ${chatId}`);
    this.assertChatBelongsToProject(chat, 'iniciar el run');

    const activeRuns = await this.deps.runs.listActive();
    if (activeRuns.some((r) => r.chatId === chatId)) {
      throw new Error(`El chat ${chatId} ya tiene un run activo (un chat = un run a la vez, doc 05 §2.1)`);
    }

    const baseResolvedAgent = await this.resolveProjectAgent(chat.agentId);
    const delegatedMaxIterations = this.delegatedIterationBudgets.get(chatId);
    const resolvedAgent = delegatedMaxIterations === undefined
      ? baseResolvedAgent
      : { ...baseResolvedAgent, maxIterations: Math.min(baseResolvedAgent.maxIterations, delegatedMaxIterations) };
    // El modelo efectivo del run sale del chat cuando el chat tiene uno elegido (doc 03 §4.1
    // `chats.model_ref_json`); si no, del agente. Antes de la integración el chat.modelRef se perdía.
    // Sólo un chat marcado explícitamente como automático omite el override. Filas legacy sin el
    // marcador siguen siendo explícitas, incluso cuando su agente hoy tiene `modelMode: auto`.
    const chatModelOverride = chat.modelSelection === 'auto' ? undefined : chat.modelRef;
    const resolvedSelection = this.deps.resolveModelRef
      ? await this.deps.resolveModelRef(resolvedAgent, chatModelOverride)
      : (chatModelOverride ?? resolvedAgent.model);
    const selectedModel = isResolvedModelSelection(resolvedSelection) ? resolvedSelection.ref : resolvedSelection;
    const modelResolution = isResolvedModelSelection(resolvedSelection)
      ? resolvedSelection.resolution
      : inferLegacyModelResolution(resolvedAgent, chatModelOverride);
    const withModel: AgentConfig = { ...resolvedAgent, model: selectedModel };
    const collaborators = this.deps.chatCollaborators
      ? await this.deps.chatCollaborators.listEnabled(chatId)
      : undefined;
    const promptedAgent = collaborators && resolvedAgent.role === 'lead' ? withCollaboratorPrompt(withModel, collaborators) : withModel;
    const agent = this.applyChatPermissionPreset(this.applyChatEffort(await this.withPersistedRules(promptedAgent), chat), chat);

    // Punto 1c/9 del encargo: se valida ANTES de crear la fila del run (nunca queda un run
    // 'created' colgado por un adjunto rechazado). 'ask'/errores de capability nunca son silenciosos
    // (regla 6 de la columna): si no se puede CONFIRMAR que el modelo tiene vision, se rechaza.
    const imageAttachments = (attachments ?? []).filter((a) => a.kind === 'image');
    if (imageAttachments.length > 0) {
      const hasVision = await this.deps.modelVisionProbe?.hasVision(agent.model);
      if (hasVision !== true) {
        throw new Error(
          `saurio: el modelo "${agent.model.name}" no confirma soporte de imágenes (vision) — no se puede adjuntar una imagen a este chat con este modelo.`,
        );
      }
    }
    const runId = this.deps.ids.next();

    // Doc 19 §2.1/§2.5 (E3a delegación): un chat CREADO POR `delegate` trae `chats.origin_run_id`
    // apuntando al run PADRE — la profundidad de ESTE run nuevo es la del padre + 1. Un chat normal
    // (comportamiento previo, sin cambios) no tiene `originRunId` y queda en profundidad 0.
    let parentRunId: string | undefined;
    let delegationDepth = 0;
    if (chat.originRunId) {
      parentRunId = chat.originRunId;
      const parentRun = await this.deps.runs.get(chat.originRunId);
      delegationDepth = (parentRun?.delegationDepth ?? 0) + 1;
    }

    await this.deps.runs.create({
      id: runId, chatId, agentId: agent.id, mode, state: 'created', iteration: 0,
      lastEventSeq: 0, createdAt: this.deps.clock.now(), ownerSessionId: 'local', heartbeatAt: this.deps.clock.now(),
      parentRunId, delegationDepth,
    });
    // Hallazgo #5: sin esto el mensaje del usuario no aparece en el chat hasta el primer
    // message.delta del assistant (runStore.reduceRunEvent solo agrega a messagesByChat en
    // message.done). Se reutiliza el schema existente en vez de sumar un tipo de evento nuevo
    // (RunEventSchema vive en @saurio/shared, fuera del alcance de esta tarea) — `metrics` es
    // obligatorio en ResponseMetricsSchema, así que se marca `quality: 'unavailable'`.
    // Hallazgo E2E (2026-09-18, eval/harness.ts paso (b)): NO se llama `this.deps.messages.append`
    // acá además de esto — `message.done` ya persiste el mensaje vía la proyección de events/
    // (`applyToMessages`, doc 03 §4.3: "`message.done` de un turno del asistente pasa por
    // SqliteEventStore.append, no por [MessageRepository.append]"). Llamar a ambos insertaba la
    // misma fila `messages.id` dos veces y violaba la UNIQUE constraint en la primera SQLite real
    // contra la que corrió un run completo; los tests unitarios no lo detectaban porque no cruzan
    // EventStore real + MessageRepository real en el mismo run.
    // Punto 1c/9 del encargo: adjuntos de texto se insertan como bloque de contexto acotado (con
    // nombre y truncado, `buildAttachmentContextBlock`); imágenes van al campo `images` (formato
    // Ollama-nativo, `gateway/providers/ollama/mappers.ts`) — openai-compat/Anthropic no mapean
    // `ChatMessage.images` hoy (sus `mappers.ts` no lo leen); documentado como límite conocido en vez
    // de mandar la imagen y que se pierda en silencio.
    const attachmentBlock = buildAttachmentContextBlock(attachments ?? []);
    const userMessage: ChatMessage = {
      id: this.deps.ids.next(), originRunId: runId, role: 'user', content: `${text}${attachmentBlock}`,
      ...(imageAttachments.length > 0 ? { images: imageAttachments.map((a) => a.dataBase64).filter((d): d is string => Boolean(d)) } : {}),
    };
    this.deps.events.append({
      runId, chatId, ts: this.deps.clock.now(), type: 'message.done',
      message: userMessage, metrics: { quality: 'unavailable' },
    });

    const live: LiveRun = {
      runId, chatId, agent, mode, effectiveConfig: buildPlaceholderConfig(agent, modelResolution),
      iteration: 0, state: 'created', abort: new AbortController(),
      loopDetector: new LoopDetector(), history: await this.deps.messages.listByChat(chatId),
      contextAttachmentsKnown: true, contextAttachments: inspectAttachments(attachments ?? []),
      contextAttachmentMessageId: userMessage.id,
      cancelRequested: false, formatRetries: 0, textMutationCorrections: 0, planCorrections: 0, generatedResponses: 0, touchedPaths: new Set(), turnsSinceCompaction: 0,
      connectionErrorStreak: 0, serverBusyErrorStreak: 0, oomGpuRetryStep: 0, delegationDepth,
      enabledCollaboratorIds: collaborators ? new Set(collaborators.map((item) => item.id)) : undefined,
      childRunIds: new Set(),
    };
    this.live.set(runId, live);
    await this.prepareAndQueue(live);

    // corre en background; start() devuelve apenas el run queda encolado (doc 05 §2.1-2.2).
    void this.runLoop(live).catch((err) => this.failUnexpected(live, err));

    return { runId };
  }

  async cancel(runId: string): Promise<void> {
    const live = this.live.get(runId);
    if (!live) return; // ya no está vivo en este proceso (terminal, o run rehidratado tras reinicio)
    live.cancelRequested = true;
    if (CANCELLABLE_STATES.has(live.state)) {
      this.transition(live, 'cancelling');
      await this.persistRunState(live);
    }
    live.abort.abort();
    await Promise.all([...live.childRunIds].map((childRunId) => this.cancel(childRunId)));
    if (live.pendingPermission) {
      // doc 10 caso (7): toda fila pending/approved/awaiting_permission pasa a cancelled de inmediato.
      const { toolCallId, resolve } = live.pendingPermission;
      live.pendingPermission = undefined;
      const record = await this.deps.toolCalls.get(toolCallId);
      if (record) {
        await this.deps.toolCalls.upsert({ ...record, status: 'cancelled', finishedAt: this.deps.clock.now() });
        this.emitToolStatus(live, toolCallId, 'cancelled');
      }
      resolve({ toolCallId, answer: 'deny', reason: 'run cancelado' });
    }
  }

  /** Cancela una delegación puntual iniciada por la persona. La relación persistida es la autoridad:
   *  un id de otro run del mismo proyecto tampoco alcanza. `cancel()` ya propaga hacia abajo, por lo
   *  que este camino corta al hijo y sus descendientes sin tocar al padre ni a sus otros hijos. */
  async cancelChild(parentRunId: string, childRunId: string): Promise<void> {
    await this.assertRunBelongsToProject(parentRunId, 'detener una delegación hija');
    await this.assertRunBelongsToProject(childRunId, 'detener una delegación hija');
    const child = await this.deps.runs.get(childRunId);
    if (!child || child.parentRunId !== parentRunId) {
      throw new Error(`No se puede detener el run ${childRunId}: no es hijo del run ${parentRunId}.`);
    }
    await this.cancel(childRunId);
  }

  async continueRun(runId: string, extraIterations?: number): Promise<{ runId: string }> {
    const prev = await this.deps.runs.get(runId);
    if (!prev) throw new Error(`Run inexistente: ${runId}`);
    if (!TERMINAL_STATES.has(prev.state)) {
      throw new Error(`No se puede continuar el run ${runId}: todavía está activo; sólo se continúan ejecuciones terminales.`);
    }
    return this.withInactiveChat(prev, 'continuar', async () => this.createDerivedRun(
      prev, await this.deps.messages.listByChat(prev.chatId), extraIterations,
      prev.effectiveConfig?.regenerationSourceMessageId,
    ));
  }

  async regenerate(runId: string): Promise<{ runId: string }> {
    const prev = await this.deps.runs.get(runId);
    if (!prev) throw new Error(`Run inexistente: ${runId}`);
    if (!TERMINAL_STATES.has(prev.state)) {
      throw new Error(`No se puede regenerar el run ${runId}: todavía está activo; sólo se regeneran ejecuciones terminales.`);
    }
    if (!prev.effectiveConfig) {
      throw new Error(`No se puede regenerar el run ${runId}: no quedó persistido el modelo efectivo que produjo la respuesta original.`);
    }
    return this.withInactiveChat(prev, 'regenerar', async () => {
      const { history, sourceMessageId } = await this.regenerationHistory(prev);
      return await this.createDerivedRun(prev, history, undefined, sourceMessageId);
    });
  }

  private async withInactiveChat<T>(
    prev: RunRecord, action: 'continuar' | 'regenerar', task: () => Promise<T>,
  ): Promise<T> {
    const chat = await this.deps.chats.get(prev.chatId);
    if (!chat) throw new Error(`Chat inexistente para el run ${prev.id}: ${prev.chatId}`);
    this.assertChatBelongsToProject(chat, `${action} el run ${prev.id}`);
    if (this.startingChats.has(prev.chatId)) {
      throw new Error(`No se puede ${action} el run ${prev.id}: el chat ${prev.chatId} ya está iniciando otra ejecución.`);
    }
    this.startingChats.add(prev.chatId);
    try {
      const activeRuns = await this.deps.runs.listActive();
      if (activeRuns.some((active) => active.chatId === prev.chatId)) {
        throw new Error(`No se puede ${action} el run ${prev.id}: el chat ${prev.chatId} ya tiene un run activo.`);
      }
      return await task();
    } finally {
      this.startingChats.delete(prev.chatId);
    }
  }

  /** Camino común de continue/regenerate: resuelve agente/configuración, crea el nuevo run y usa
   * el loop normal. La única diferencia entre ambas operaciones es el historial que reciben. */
  private async createDerivedRun(
    prev: RunRecord, history: ChatMessage[], extraIterations?: number, regenerationSourceMessageId?: string,
  ): Promise<{ runId: string }> {
    const chatForPreset = await this.deps.chats.get(prev.chatId);
    if (!chatForPreset) throw new Error(`Chat inexistente para el run ${prev.id}: ${prev.chatId}`);
    this.assertChatBelongsToProject(chatForPreset, `continuar el run ${prev.id}`);
    const baseAgent = await this.resolveProjectAgent(prev.agentId);
    const withModel: AgentConfig = {
      ...baseAgent,
      // El run nuevo hereda el modelo efectivo del run anterior (doc 05 §2.10 "run:continue crea un
      // run nuevo"): el usuario no volvió a elegir modelo entre uno y otro.
      ...(prev.effectiveConfig ? { model: prev.effectiveConfig.model } : {}),
      maxIterations: baseAgent.maxIterations + (extraIterations ?? 0),
    };
    const collaborators = this.deps.chatCollaborators
      ? await this.deps.chatCollaborators.listEnabled(prev.chatId)
      : undefined;
    const promptedAgent = collaborators && baseAgent.role === 'lead' ? withCollaboratorPrompt(withModel, collaborators) : withModel;
    const agent = this.applyChatPermissionPreset(
      this.applyChatEffort(await this.withPersistedRules(promptedAgent), chatForPreset), chatForPreset,
    );

    const newRunId = this.deps.ids.next();
    await this.deps.runs.create({
      id: newRunId, chatId: prev.chatId, agentId: agent.id, mode: prev.mode, state: 'created',
      iteration: 0, lastEventSeq: 0, createdAt: this.deps.clock.now(),
      ownerSessionId: 'local', heartbeatAt: this.deps.clock.now(), parentRunId: prev.parentRunId,
      // Doc 19 §2.1: run:continue crea un run nuevo del MISMO chat — hereda la profundidad del
      // anterior (un chat hijo de delegación sigue siendo hijo tras un continue).
      delegationDepth: prev.delegationDepth ?? 0,
    });

    const live: LiveRun = {
      runId: newRunId, chatId: prev.chatId, agent, mode: prev.mode,
      effectiveConfig: {
        ...buildPlaceholderConfig(agent, prev.effectiveConfig?.modelResolution
          ? { ...prev.effectiveConfig.modelResolution, inheritedFromRunId: prev.id }
          : undefined),
        ...(regenerationSourceMessageId ? { regenerationSourceMessageId } : {}),
      },
      iteration: 0, state: 'created',
      abort: new AbortController(), loopDetector: new LoopDetector(),
      history,
      contextAttachmentsKnown: false, contextAttachments: [],
      cancelRequested: false, formatRetries: 0, textMutationCorrections: 0, planCorrections: 0, generatedResponses: 0, touchedPaths: new Set(), turnsSinceCompaction: 0,
      connectionErrorStreak: 0, serverBusyErrorStreak: 0, oomGpuRetryStep: 0, delegationDepth: prev.delegationDepth ?? 0,
      enabledCollaboratorIds: collaborators ? new Set(collaborators.map((item) => item.id)) : undefined,
      childRunIds: new Set(),
    };
    this.live.set(newRunId, live);
    await this.prepareAndQueue(live);

    void this.runLoop(live).catch((err) => this.failUnexpected(live, err));
    return { runId: newRunId };
  }

  /** Recupera el pedido exacto desde el evento del run origen porque `messages` no conserva las
   * imágenes. El corte por id mantiene el historial visible en SQLite pero excluye del prompt la
   * respuesta y cualquier tool posterior al pedido que se está repitiendo. */
  private async regenerationHistory(prev: RunRecord): Promise<{ history: ChatMessage[]; sourceMessageId: string }> {
    const persisted = await this.deps.messages.listByChat(prev.chatId);
    let sourceMessageId = prev.effectiveConfig?.regenerationSourceMessageId;

    if (!sourceMessageId) {
      // La primera respuesta cerrada fija el límite temporal del run. Buscar simplemente el último
      // user del chat adivinaría mal al regenerar una respuesta vieja después de turnos nuevos.
      // Un run que cortó el stream puede tener sólo `message.delta` más un fragmento directo en
      // messages; ese messageId también alcanza para fijar el corte. Sin done ni delta no hay
      // respuesta observable y no se intenta adivinar qué user le correspondía.
      const firstResponseEvent = this.deps.events.since(prev.id, 0).find((event) => (
        event.type === 'message.delta'
        || (event.type === 'message.done' && event.message.role === 'assistant')
      ));
      const firstResponseMessageId = firstResponseEvent?.type === 'message.delta'
        ? firstResponseEvent.messageId
        : firstResponseEvent?.type === 'message.done'
          ? firstResponseEvent.message.id
          : undefined;
      if (!firstResponseMessageId) {
        throw new Error(
          `No se puede regenerar el run ${prev.id}: terminó antes de persistir una respuesta que permita asociar su pedido original.`,
        );
      }
      const responseIndex = persisted.findIndex((message) => message.id === firstResponseMessageId);
      if (responseIndex < 0) {
        throw new Error(`No se puede regenerar el run ${prev.id}: su primera respuesta ya no está en el historial persistido.`);
      }
      sourceMessageId = persisted.slice(0, responseIndex).findLast((message) => message.role === 'user')?.id;
      if (!sourceMessageId) {
        throw new Error(`No se puede regenerar el run ${prev.id}: no hay un pedido de usuario verificable antes de su respuesta.`);
      }
    }

    const sourceIndex = persisted.findIndex((message) => message.id === sourceMessageId);
    if (sourceIndex < 0) {
      throw new Error(`No se puede regenerar el run ${prev.id}: el mensaje original ya no está en el historial persistido.`);
    }
    const persistedSource = persisted[sourceIndex]!;
    if (persistedSource.role !== 'user') {
      throw new Error(`No se puede regenerar el run ${prev.id}: la correlación persistida no apunta a un pedido de usuario.`);
    }
    const sourceRunId = persistedSource.originRunId;
    const sourceEvent = sourceRunId
      ? this.deps.events.since(sourceRunId, 0).find((event): event is Extract<RunEvent, { type: 'message.done' }> => (
          event.type === 'message.done' && event.message.role === 'user' && event.message.id === sourceMessageId
        ))
      : undefined;
    if (!sourceEvent) {
      throw new Error(
        `No se puede regenerar el run ${prev.id}: el pedido original es legacy o incompleto y sus adjuntos no se pueden restaurar de forma segura.`,
      );
    }
    if (sourceEvent.message.images?.some((image) => Buffer.byteLength(image, 'base64') === 0)) {
      throw new Error(
        `No se puede regenerar el run ${prev.id}: al menos una imagen adjunta del pedido original no tiene datos restaurables.`,
      );
    }
    return {
      sourceMessageId,
      history: [
        ...persisted.slice(0, sourceIndex),
        { ...sourceEvent.message, originRunId: sourceEvent.message.originRunId ?? sourceRunId },
      ],
    };
  }

  async recover(): Promise<RecoverResult> {
    return recoverRuns({
      runs: this.deps.runs,
      toolCalls: this.deps.toolCalls,
      messages: this.deps.messages,
      checkpoints: this.deps.checkpointRepo,
      events: this.deps.events,
      diagnostics: this.deps.orphanDiagnostics,
      clock: this.deps.clock,
    });
  }

  /** No forma parte de la interfaz `RunController` de doc 04 §5 (esa firma solo lista start/cancel/
   *  continueRun/recover): el canal IPC `permission:answer` no es un método de ese contrato. Se agrega
   *  acá porque algo tiene que resolver la espera de doc 05 §2.6 paso 28 dentro de este proceso — ver
   *  deviations en la salida estructurada. Solo resuelve runs vivos EN ESTE proceso; un run rehidratado
   *  tras un reinicio (doc 10 §5.2) necesita que la UI vuelva a llamar `start`/una vía de reanudación
   *  que no está en el alcance de este módulo (no hay ToolProtocol ni ContextBuilder "reanudables" sin
   *  volver a llamar al modelo, y ese flujo completo queda fuera de esta tarea). */
  async answerPermission(toolCallId: string, answer: PermissionAnswer): Promise<void> {
    // Hallazgo #1/#4: red de seguridad si `toolCallId` llega vacío (p. ej. un cliente viejo que
    // todavía lee `request.toolCallId` de un evento generado antes de este fix). Sin este chequeo,
    // el `for` de abajo nunca matchea `pendingPermission.toolCallId === ''` (ver `executeOneToolCall`,
    // que siempre usa `call.id`) y el error genérico de abajo no deja claro por qué.
    if (toolCallId.length === 0) {
      throw new Error('answerPermission: toolCallId vacío (la tool call que originó el pedido de permiso no se identificó correctamente)');
    }
    const record = await this.deps.toolCalls.get(toolCallId);
    if (record) await this.assertRunBelongsToProject(record.runId, 'responder el permiso');
    if (this.tryResolvePending(toolCallId, answer)) return;

    // Doc 16 §4 ítem 2 ("reanudar tras reinicio", doc 10 §5.2): no vive en `this.live` de este
    // proceso — puede ser un run que quedó en `awaiting_permission` antes de cerrar la app. Se
    // rehidrata desde `run_events`/`tool_calls` (sin re-ejecutar nada que ya corrió) y se reintenta
    // una vez. Esto mantiene sin cambios el contrato IPC `permission:answer` (apps/desktop no
    // necesita saber que el run se rehidrató).
    if (record && record.status === 'awaiting_permission') {
      const resumed = await this.resumeAfterRestart(record.runId);
      if (resumed && this.tryResolvePending(toolCallId, answer)) return;
    }
    throw new Error(`No hay un run en este proceso esperando la tool call ${toolCallId}`);
  }

  private tryResolvePending(toolCallId: string, answer: PermissionAnswer): boolean {
    for (const live of this.live.values()) {
      if (live.pendingPermission?.toolCallId === toolCallId) {
        const resolve = live.pendingPermission.resolve;
        live.pendingPermission = undefined;
        resolve(answer);
        return true;
      }
    }
    return false;
  }

  /** Cambio aditivo mínimo (encargo de apps/desktop, punto 5: "reanudar permisos pendientes tras
   *  reinicio en la UI — tarjeta de permiso rehidratada"; packages/runtime no es zona de ese encargo,
   *  documentado acá y en docs/architecture/16-estado-de-implementacion.md). A diferencia de
   *  `resumeAfterRestart` (abajo), esto NO arma ningún `LiveRun` ni deja nada esperando: es una
   *  lectura pura para que el host pueda mostrar de nuevo la tarjeta de permiso apenas arranca la app,
   *  ANTES de que el usuario responda (que es cuando `resumeAfterRestart` corre de verdad, vía
   *  `answerPermission`, sin cambios). Reusa exactamente la misma reconstrucción de `PermissionRequest`
   *  que ya usa `resumeAfterRestart` (evento `tool.permission` persistido, o el fallback mínimo). */
  async pendingPermissionRequests(): Promise<{ runId: string; chatId: string; request: PermissionRequest }[]> {
    const activeRuns = await this.deps.runs.listActive();
    const awaiting = activeRuns.filter((r) => r.state === 'awaiting_permission' && !this.live.has(r.id));
    const results: { runId: string; chatId: string; request: PermissionRequest }[] = [];
    for (const run of awaiting) {
      const chat = await this.deps.chats.get(run.chatId);
      if (!chat || !this.chatBelongsToProject(chat)) continue;
      const calls = await this.deps.toolCalls.listByRun(run.id);
      const pendingRecord = calls.find((c) => c.status === 'awaiting_permission');
      if (!pendingRecord) continue;
      const call: ToolCall = {
        id: pendingRecord.id, name: pendingRecord.toolName, args: pendingRecord.args, transport: pendingRecord.transport,
      };
      const classification = this.classify(call);
      const request = (await this.findPermissionRequest(run.id, pendingRecord.id))
        ?? buildFallbackPermissionRequest(pendingRecord.id, call.name, classification);
      results.push({ runId: run.id, chatId: run.chatId, request });
    }
    return results;
  }

  /** Doc 10 §5.2 / doc 16 §4 ítem 2: reconstruye el `LiveRun` mínimo necesario para que la tool call
   *  `awaiting_permission` de `runId` pueda resolverse en ESTE proceso, sin repetir ninguna
   *  ejecución (la tool pasa `approved -> running` "por primera vez", tal como pide el documento).
   *  No hace nada si el run ya está vivo, si no está en `awaiting_permission`, o si no hay ninguna
   *  tool call realmente pendiente (estado inconsistente — se deja para diagnóstico manual). */
  async resumeAfterRestart(runId: string): Promise<boolean> {
    const run = await this.deps.runs.get(runId);
    if (!run) return false;
    const chatForPreset = await this.deps.chats.get(run.chatId);
    if (!chatForPreset) throw new Error(`Chat inexistente para el run ${runId}: ${run.chatId}`);
    this.assertChatBelongsToProject(chatForPreset, `reanudar el run ${runId}`);
    if (this.live.has(runId)) return true;
    if (run.state !== 'awaiting_permission') return false;

    const calls = await this.deps.toolCalls.listByRun(runId);
    const pendingRecord = calls.find((c) => c.status === 'awaiting_permission');
    if (!pendingRecord) return false;

    const baseAgent = await this.resolveProjectAgent(run.agentId);
    const collaborators = this.deps.chatCollaborators
      ? await this.deps.chatCollaborators.listEnabled(run.chatId)
      : undefined;
    const resumedBase = run.effectiveConfig ? { ...baseAgent, model: run.effectiveConfig.model } : baseAgent;
    const agent = this.applyChatPermissionPreset(
      this.applyChatEffort(
        await this.withPersistedRules(
          collaborators && baseAgent.role === 'lead' ? withCollaboratorPrompt(resumedBase, collaborators) : resumedBase,
        ),
        chatForPreset,
      ),
      chatForPreset,
    );
    const effectiveConfig = run.effectiveConfig ?? buildPlaceholderConfig(agent);
    const history = await this.deps.messages.listByChat(run.chatId);
    const persistedOomAdjustments = effectiveConfig.adjustments.filter(
      (adjustment) => adjustment.param === 'numGpu' && typeof adjustment.applied === 'number',
    );
    const lastPersistedNumGpu = persistedOomAdjustments.at(-1)?.applied;

    const live: LiveRun = {
      runId, chatId: run.chatId, agent, mode: run.mode, effectiveConfig,
      iteration: run.iteration, state: 'awaiting_permission', abort: new AbortController(),
      loopDetector: new LoopDetector(), history, cancelRequested: false, formatRetries: 0, textMutationCorrections: 0, planCorrections: 0, generatedResponses: 0,
      contextAttachmentsKnown: false, contextAttachments: [],
      // Doc 10 §5.2 nota: la comparación de conflicto ya no depende de esto (usa
      // `tool_calls.expected_pre_hash`, persistido); se deja vacío como límite conocido documentado
      // — un `git reset`/`checkout` sobre un path tocado antes del reinicio no se reconoce como
      // "tocado por este run" tras rehidratar.
      touchedPaths: new Set(), turnsSinceCompaction: 0, connectionErrorStreak: 0, serverBusyErrorStreak: 0,
      numGpuOverride: typeof lastPersistedNumGpu === 'number' ? lastPersistedNumGpu : undefined,
      oomGpuRetryStep: persistedOomAdjustments.length,
      delegationDepth: run.delegationDepth ?? 0,
      enabledCollaboratorIds: collaborators ? new Set(collaborators.map((item) => item.id)) : undefined,
      childRunIds: new Set(),
    };
    this.live.set(runId, live);

    const call: ToolCall = {
      id: pendingRecord.id, name: pendingRecord.toolName, args: pendingRecord.args,
      transport: pendingRecord.transport,
    };
    const classification = this.classify(call);
    const request = (await this.findPermissionRequest(runId, pendingRecord.id))
      ?? buildFallbackPermissionRequest(pendingRecord.id, call.name, classification);

    void (async () => {
      try {
        const answer = await new Promise<PermissionAnswer>((resolve) => {
          live.pendingPermission = { toolCallId: pendingRecord.id, resolve };
        });
        if (live.cancelRequested) { await this.finishCancelled(live); return; }
        const outcome = await this.afterPermissionAnswered(live, call, pendingRecord, classification, request, answer);
        if (outcome === 'cancelled') { await this.finishCancelled(live); return; }
        live.iteration += 1;
        await this.deps.runs.update(live.runId, { iteration: live.iteration });
        this.returnToQueue(live);
        await this.persistRunState(live);
        void this.runLoop(live).catch((err) => this.failUnexpected(live, err));
      } catch (err) {
        await this.failUnexpected(live, err);
      }
    })();

    return true;
  }

  /** Busca el `PermissionRequest` completo tal como quedó persistido en el evento `tool.permission`
   *  (doc 10 §5.2: "la PermissionRequest ya está completa en el evento... la UI la re-renderiza sin
   *  volver a llamar al modelo"). Usado por `resumeAfterRestart` para poder pasarle a
   *  `PermissionMemory.recordAnswer` el mismo `rememberOptions.suggestedPattern` que vio el usuario. */
  private async findPermissionRequest(runId: string, toolCallId: string): Promise<PermissionRequest | undefined> {
    const events = this.deps.events.since(runId, 0);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (ev?.type === 'tool.permission' && ev.request.toolCallId === toolCallId) return ev.request;
    }
    return undefined;
  }

  /** Resuelve la configuración global del agente para la raíz a la que pertenece este controlador. */
  private async resolveProjectAgent(agentId: string): Promise<AgentConfig> {
    const agent = await this.deps.agents.resolve(agentId);
    // El agente es global y su workingDir persistido puede ser userData o un proyecto anterior.
    // Cada controlador ya está ligado al WorkspaceFs de esta raíz; el prompt debe usar la misma.
    return { ...agent, workingDir: this.deps.projectRoot };
  }

  private chatBelongsToProject(chat: { projectId: string }): boolean {
    return this.deps.projectId === undefined || chat.projectId === this.deps.projectId;
  }

  private assertChatBelongsToProject(
    chat: { id: string; projectId: string }, operation: string,
  ): void {
    if (this.chatBelongsToProject(chat)) return;
    throw new Error(
      `No se puede ${operation}: el chat ${chat.id} pertenece al proyecto ${chat.projectId}, ` +
      `pero este runtime está ligado al proyecto ${this.deps.projectId}.`,
    );
  }

  private async assertRunBelongsToProject(runId: string, operation: string): Promise<void> {
    const run = await this.deps.runs.get(runId);
    if (!run) throw new Error(`Run inexistente: ${runId}`);
    const chat = await this.deps.chats.get(run.chatId);
    if (!chat) throw new Error(`Chat inexistente para el run ${runId}: ${run.chatId}`);
    this.assertChatBelongsToProject(chat, `${operation} del run ${runId}`);
  }

  /** Reglas persistidas de proyecto/global (doc 16 §4 ítem 1: "allow_always... se aplica en el
   *  siguiente run: hoy no persiste"). Se concatenan con las reglas propias del agente —
   *  `PermissionEngine.evaluate` ya resuelve precedencia por `rule.scope`, así que el orden de la
   *  lista no importa (doc 06 §6). Sin `permissionMemory`/`projectId`, devuelve `agent` sin tocar. */
  private async withPersistedRules(agent: AgentConfig): Promise<AgentConfig> {
    if (!this.deps.permissionMemory || !this.deps.projectId) return agent;
    const persisted = await this.deps.permissionMemory.loadRules(this.deps.projectId);
    if (persisted.length === 0) return agent;
    return { ...agent, permissions: { ...agent.permissions, rules: [...agent.permissions.rules, ...persisted] } };
  }

  /** Feedback real v0.2.1, punto 1a/8: `Chat.permissionPreset` (canal `chat:setPermissionPreset`,
   *  @saurio/shared) manda por sobre el preset del AGENTE para ESTE run — es una elección explícita
   *  del usuario en el chat, más específica que la config general del agente. Sin
   *  `chat.permissionPreset` (chats creados antes de esta migración, o que nunca lo tocaron), el
   *  comportamiento es el previo: se usa el preset que ya traía `agent.permissions`. */
  private applyChatPermissionPreset(agent: AgentConfig, chat: { permissionPreset?: ChatPermissionPreset }): AgentConfig {
    if (!chat.permissionPreset) return agent;
    return { ...agent, permissions: { ...agent.permissions, preset: chat.permissionPreset } };
  }

  /** Punto 1b del encargo (feedback real v0.2.1): `Chat.effort` mapea a think off/on (equivalente
   *  binario de "off/low/high" para providers cuyo `think` es booleano, como Ollama con qwen3 — no
   *  hay chequeo de `ModelCapabilities.thinking` acá: si el modelo no soporta thinking, `think`
   *  simplemente no tiene efecto en la respuesta, comportamiento ya existente con `agent.thinking`),
   *  numPredict (`ContextPolicy.reserveForResponse`, lo que `buildChatRequest` usa como numPredict) y
   *  maxIterations. 'balanced'/sin effort: sin cambios (comportamiento previo a esta tarea). */
  private applyChatEffort(agent: AgentConfig, chat: { effort?: Effort }): AgentConfig {
    if (!chat.effort || chat.effort === 'balanced') return agent;
    if (chat.effort === 'fast') {
      return {
        ...agent,
        thinking: 'off',
        maxIterations: Math.max(5, Math.round(agent.maxIterations * 0.6)),
        contextPolicy: { ...agent.contextPolicy, reserveForResponse: Math.max(256, Math.round(agent.contextPolicy.reserveForResponse * 0.6)) },
      };
    }
    return {
      ...agent,
      thinking: 'on',
      maxIterations: Math.round(agent.maxIterations * 1.5),
      contextPolicy: { ...agent.contextPolicy, reserveForResponse: Math.round(agent.contextPolicy.reserveForResponse * 1.5) },
    };
  }

  // ── Preparación (doc 05 §2.2) ───────────────────────────────────────────

  private async prepareAndQueue(live: LiveRun): Promise<void> {
    // No se emite run.state para el pseudo-edge [*] -> created (doc 05 §1): solo created -> preparing
    // en adelante tiene un `from: RunState` real.
    this.transition(live, 'preparing');
    await this.persistRunState(live);

    const regenerationSourceMessageId = live.effectiveConfig.regenerationSourceMessageId;
    const effectiveConfig = this.buildEffectiveConfig(live.agent, live.mode, live.effectiveConfig.modelResolution);
    if (regenerationSourceMessageId) effectiveConfig.regenerationSourceMessageId = regenerationSourceMessageId;
    await this.applyNumCtxOverride(effectiveConfig);
    await this.capNumCtxAgainstModel(live, effectiveConfig);
    live.effectiveConfig = effectiveConfig;
    for (const adj of effectiveConfig.adjustments) {
      this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'run.adjustment', adjustment: adj });
    }
    await this.deps.runs.update(live.runId, { effectiveConfig });

    await this.maybeWarnSmallModel(live);

    this.transition(live, 'queued');
    await this.persistRunState(live);
  }

  /** Punto 10 del encargo: aviso no bloqueante de "modelo chico" en modo agente. Se evalúa una sola
   *  vez por run (acá, en `prepareAndQueue`, que corre una única vez al preparar el run — nunca en
   *  cada turno del loop). `parseParameterSizeBillions` devuelve `undefined` ante cualquier formato
   *  que no reconozca (nunca afirma "es chico" sin evidencia, regla 6 de la columna). */
  private async maybeWarnSmallModel(live: LiveRun): Promise<void> {
    if (live.mode !== 'agent' || !this.deps.modelParameterSizeProbe) return;
    const raw = await this.deps.modelParameterSizeProbe.getParameterSize(live.effectiveConfig.model).catch(() => undefined);
    if (raw === undefined) return;
    const billions = parseParameterSizeBillions(raw);
    if (billions === undefined || billions >= SMALL_MODEL_THRESHOLD_B) return;
    this.deps.events.append({
      runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'run.smallModelWarning',
      modelRef: live.effectiveConfig.model, parameterSize: raw,
    });
  }

  /** ADR-7 / doc 05 §2.2 paso 7 / doc 16 §4 ítem "capado automático de numCtx": único ajuste
   *  automático del MVP. Sin `modelContextProbe` (opcional, ver deps), no hace nada — comportamiento
   *  previo. Muta `effectiveConfig.numCtx`/`adjustments` in-place: lo llama `prepareAndQueue` antes
   *  de persistir/emitir los `run_adjustments` ya existentes, así que no duplica ese mecanismo. */
  /** Ver `RunControllerDeps.numCtxForModel` (aditivo). Muta `effectiveConfig.numCtx` in-place antes
   *  del capado automático de `capNumCtxAgainstModel`, para que ese capado siga aplicando aunque la
   *  preferencia manual venga de acá en vez de `ContextPolicy`. */
  private async applyNumCtxOverride(effectiveConfig: EffectiveConfig): Promise<void> {
    if (!this.deps.numCtxForModel) return;
    const override = await this.deps.numCtxForModel(effectiveConfig.model);
    if (override !== undefined && override > 0) effectiveConfig.numCtx = override;
  }

  private async capNumCtxAgainstModel(live: LiveRun, effectiveConfig: EffectiveConfig): Promise<void> {
    effectiveConfig.contextLimitSource = 'provisional';
    if (!this.deps.modelContextProbe) return;
    let contextMax: number | undefined;
    try {
      contextMax = await this.deps.modelContextProbe.getContextMax(effectiveConfig.model);
    } catch (err) {
      console.warn('[RunController] no se pudo consultar contextMax del modelo; no se capea numCtx', err);
      return;
    }
    if (contextMax === undefined || !Number.isSafeInteger(contextMax) || contextMax <= 0) return;
    effectiveConfig.contextLimitSource = 'reported';
    if (contextMax >= effectiveConfig.numCtx) return;
    const requested = effectiveConfig.numCtx;
    effectiveConfig.numCtx = contextMax;
    effectiveConfig.adjustments.push({
      param: 'numCtx', requested, applied: contextMax,
      reason: `numCtx pedido (${requested}) excede el contextMax real del modelo (${contextMax}, /api/show) — capeado hacia abajo (ADR-7).`,
      source: 'auto',
    });
  }

  // ── Loop principal (doc 05 §2.3-2.13) ──────────────────────────────────

  private async runLoop(live: LiveRun): Promise<void> {
    while (true) {
      if (live.cancelRequested) { await this.finishCancelled(live); return; }
      if (live.iteration >= live.agent.maxIterations) {
        await this.fail(live, { code: 'max_iterations', message: `Se alcanzó agent.maxIterations (${live.agent.maxIterations}, doc 05 §2.12 paso 38).` });
        return;
      }

      // Construcción del contexto (doc 05 §2.3): ocurre todavía en 'queued', antes de generar. Puede
      // tardar segundos (y hasta llamar al modelo para compactar), así que hallazgo #2 exige revisar
      // `cancelRequested` después de cada await largo: sin esto, un cancel() durante esta ventana deja
      // `live.state === 'cancelling'` (RUN_TRANSITIONS['cancelling'] solo permite -> 'cancelled') y el
      // intento de abajo de pasar a 'generating' lanzaría InvalidTransitionError.
      const repoMap = await this.buildRepoMap(live);
      if (live.cancelRequested) { await this.finishCancelled(live); return; }

      const projectInstructions = await this.loadProjectInstructions();
      if (live.cancelRequested) { await this.finishCancelled(live); return; }

      // Las memorias del agente nunca se leen directamente desde el runtime: el adaptador del host
      // aplica el alcance del perfil y el proyecto activo. Si el perfil no las habilita, tampoco se
      // consulta el puerto. El bloque queda separado de SAURIO.md en ContextBuilder.
      let agentMemory: string | undefined;
      let agentMemoryReason: ContextInspectionInput['agentMemoryReason'];
      if (!live.agent.memory.readProjectMemory) {
        agentMemoryReason = 'disabled';
      } else if (!this.deps.agentMemories || !this.deps.projectId) {
        agentMemoryReason = 'not_configured';
      } else {
        agentMemory = formatAgentMemoryForContext(
          await this.deps.agentMemories.listForRun(live.agent.id, this.deps.projectId),
        );
        if (!agentMemory) agentMemoryReason = 'empty';
      }
      if (live.cancelRequested) { await this.finishCancelled(live); return; }

      // Tools renderizadas ANTES de context.build (doc 16 §4 ítem 5): ContextBudgetReport.used.tools
      // necesita su texto para estimar tokens reales; antes build() no recibía nada de esto.
      const protocol = this.protocolFor(live);
      const availableTools = this.deps.tools.list({ names: live.effectiveConfig.tools, mode: live.mode });
      const rendered = protocol.renderTools(availableTools);
      const toolsText = rendered.apiTools ? JSON.stringify(rendered.apiTools) : (rendered.systemSuffix ?? '');

      // Doc 07 §7.1/§7.2, doc 16 §4 ítem 5: si esta vuelta va a compactar, se anuncia la transición
      // ANTES de llamar a build() (que puede tardar — nivel 2 le pide un resumen al modelo, ocupando
      // un slot real de inferencia), para que la UI muestre "compactando" mientras corre esa llamada.
      // Doc 07 §7.1 "nunca dispara durante un reintento de formato": `formatRetries > 0` significa
      // que esta vuelta del loop es un reintento del mismo turno tras un error de parseo (se resetea
      // a 0 después de un parseo exitoso, ver más abajo) — se le pasa `turnsSinceCompaction:
      // -Infinity`-equivalente apagando el chequeo por completo para esta vuelta puntual.
      const buildInput = {
        agent: live.agent, mode: live.mode, history: live.history, repoMap: repoMap.text,
        toolsText, agentMemory, projectMemory: projectInstructions.text,
        turnsSinceCompaction: live.turnsSinceCompaction,
        allowCompaction: live.formatRetries === 0,
        // Feedback real v0.2.1, punto 1e/7: numCtx REAL ya capeado contra el modelo
        // (capNumCtxAgainstModel, más abajo en prepareAndQueue) — puede diferir de
        // `live.agent.contextPolicy.numCtx` si el cap solo tocó `effectiveConfig`.
        effectiveNumCtx: live.effectiveConfig.numCtx,
        // Punto 3 del encargo: carpeta de trabajo/SO/shell reales. `buildEnvironmentPrompt` no hace
        // I/O (la detección de shell está cacheada a nivel de módulo en run_command.ts), así que
        // recalcularlo en cada vuelta del loop es barato — no hace falta memoizarlo en `live`.
        environmentInfo: buildEnvironmentPrompt(live.agent.workingDir),
        inspection: {
          projectRoot: this.deps.projectRoot,
          repoMapReason: repoMap.reason,
          projectMemoryReason: projectInstructions.reason,
          agentMemoryReason,
          attachmentsKnown: live.contextAttachmentsKnown,
          attachments: live.contextAttachments,
          attachmentMessageId: live.contextAttachmentMessageId,
        },
      };
      const willCompact = this.deps.context.willCompact(buildInput);
      if (willCompact) {
        this.transition(live, 'compacting');
        this.emitActivity(live, 'compacting', 'Resumiendo la conversación para hacer lugar…');
        await this.persistRunState(live);
      }

      const built = await this.deps.context.build(buildInput);
      if (live.cancelRequested) { await this.finishCancelled(live); return; }

      // Conserva la primera razón de exclusión para vueltas posteriores: después de compactar el
      // id del mensaje original ya no está en `history`, pero no debe degradarse a "budget".
      if (built.report.inspection) live.contextAttachments = built.report.inspection.attachments;

      if (built.compaction) {
        await this.applyCompaction(live, built.compaction);
      } else {
        live.turnsSinceCompaction += 1;
      }
      if (willCompact) {
        // build() puede terminar decidiendo no compactar (p. ej. si `history` cambió entre el chequeo
        // y la llamada real, aunque en este loop no puede pasar porque no hay await entre medio) —
        // de cualquier forma, siempre hay que volver a 'queued' antes de 'generating'.
        this.returnToQueue(live);
        await this.persistRunState(live);
      }

      const contextReport = {
        ...built.report,
        contextLimitSource: live.effectiveConfig.contextLimitSource ?? 'provisional',
        ...(built.report.inspection ? {
          inspection: {
            ...built.report.inspection,
            limitSource: live.effectiveConfig.contextLimitSource ?? 'provisional',
          },
        } : {}),
      };
      this.deps.events.append({
        runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'context.built',
        budget: contextReport, modelResolution: live.effectiveConfig.modelResolution,
      });
      if (!contextReport.fits) {
        await this.fail(live, { code: 'context_overflow', message: 'El contexto no entra ni tras compactar (doc 05 §2.3 paso 12).' });
        return;
      }

      const request = this.buildChatRequest(live, built.messages, rendered);

      if (live.cancelRequested) { await this.finishCancelled(live); return; }
      this.transition(live, 'generating');
      this.emitActivity(live, 'thinking', 'Pensando…');
      await this.persistRunState(live);

      let chatResult: { assistantMessage: ChatMessage } | 'failed' | 'cancelled';
      while (true) {
        const attempt = await this.streamChat(live, request);
        if (attempt === 'retry') continue;
        chatResult = attempt;
        break;
      }
      if (chatResult === 'cancelled') { await this.finishCancelled(live); return; }
      if (chatResult === 'failed') return; // fail() ya se llamó dentro de streamChat

      const { assistantMessage } = chatResult;
      live.generatedResponses += 1;
      live.history.push(assistantMessage);

      this.transition(live, 'parsing');
      await this.persistRunState(live);

      const parsed = protocol.parse(assistantMessage, availableTools);
      if (parsed.parseErrors.length > 0) {
        const failed = await this.handleParseError(live, parsed.parseErrors);
        if (failed) return;
        this.returnToQueue(live);
        await this.persistRunState(live);
        continue;
      }
      // Se captura antes del reset: el fallback de modo Plan no debe convertir una recuperación de
      // formato en otra generación adicional.
      const recoveredFromFormatError = live.formatRetries > 0;
      // Doc 07 §7.1 ("nunca dispara durante un reintento de formato"): sin resetear esto tras un
      // parseo exitoso, `live.formatRetries` quedaba en >0 para siempre tras el primer error de
      // formato del run (nunca se reseteaba), lo cual habría bloqueado la compactación en todos los
      // turnos siguientes si se hubiera usado como guarda — se resetea acá para que el contador
      // siga significando "reintentos del turno actual", no "hubo algún reintento en el run".
      live.formatRetries = 0;

      // Frontera de seguridad del runtime: el provider puede devolver tool_calls nativas que nunca
      // fueron anunciadas, y el transporte text también puede inventar un bloque para una tool que
      // no pertenece al perfil. Prompt y parser mejoran el comportamiento del modelo, pero no son
      // autorización. Se valida el conjunto efectivo de ESTE run (perfil + modo + registry) antes
      // de los atajos de finish/delegate, de registrar permisos o de ejecutar cualquier handler.
      const allowedToolNames = new Set(availableTools.map((tool) => tool.name));
      const forbiddenToolNames = [...new Set(parsed.toolCalls
        .map((call) => call.name)
        .filter((name) => !allowedToolNames.has(name)))];
      if (forbiddenToolNames.length > 0) {
        const quotedNames = forbiddenToolNames.map((name) => `"${name}"`).join(', ');
        await this.fail(live, {
          code: 'format',
          message: `El modelo intentó usar ${forbiddenToolNames.length === 1 ? 'una herramienta no habilitada' : 'herramientas no habilitadas'} para este agente y modo: ${quotedNames}. No se solicitó permiso ni se ejecutó la acción.`,
        });
        return;
      }

      if (this.correctMissingTextTool(live, parsed.toolCalls, parsed.text, availableTools)) {
        this.returnToQueue(live);
        await this.persistRunState(live);
        continue;
      }

      if (this.correctMissingPlan(live, parsed.toolCalls, parsed.text, recoveredFromFormatError)) {
        this.returnToQueue(live);
        await this.persistRunState(live);
        continue;
      }

      const finishCall = parsed.toolCalls.find((c) => c.name === 'finish');
      if (finishCall) { await this.runFinish(live, protocol, finishCall); return; }

      const outcome = await this.handleToolCalls(live, parsed.toolCalls, parsed.text);
      if (outcome === 'completed' || outcome === 'failed') return;
      if (outcome === 'cancelled') { await this.finishCancelled(live); return; }
      // outcome === 'continue': handleToolCalls ya dejó al run en 'queued' (returnToQueue).
    }
  }

  private protocolFor(live: LiveRun): ToolProtocol {
    return live.effectiveConfig.transport === 'text' ? this.deps.toolProtocols.text : this.deps.toolProtocols.native;
  }

  /** Doc 07 §7.2/§7.4, doc 16 §4 ítem 5: persiste el mensaje-resumen (si lo hay), emite
   *  `context.compacted` con datos reales y — clave para que la compactación no se dispare de nuevo
   *  cada turno — reemplaza `live.history` por `compaction.historyAfter`, así el próximo `build()`
   *  arranca desde el historial ya reducido en vez de recalcular sobre el original sin comprimir. */
  private async applyCompaction(live: LiveRun, compaction: CompactionResult): Promise<void> {
    if (compaction.summaryMessage) {
      await this.deps.messages.append(live.chatId, compaction.summaryMessage);
      this.deps.events.append({
        runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'context.compacted',
        summaryMessageId: compaction.summaryMessage.id, tokensBefore: compaction.tokensBefore,
        tokensAfter: compaction.tokensAfter, replacedMessageIds: compaction.replacedMessageIds,
      });
    } else {
      // Plan B de nivel 1 puro (doc 07 §7.3): sin resumen, no hay `summaryMessageId` que marcar en
      // `compacted_by` — el evento igual se emite (tokensBefore/tokensAfter reales) para que el
      // panel de rendimiento/diagnóstico vea que hubo una compactación esta vuelta.
      this.deps.events.append({
        runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'context.compacted',
        tokensBefore: compaction.tokensBefore, tokensAfter: compaction.tokensAfter,
      });
    }
    live.history = compaction.historyAfter;
    live.turnsSinceCompaction = 0;
  }

  // ── Inferencia con streaming (doc 05 §2.4) ─────────────────────────────

  private async streamChat(
    live: LiveRun, request: ChatRequest,
  ): Promise<{ assistantMessage: ChatMessage } | 'retry' | 'failed' | 'cancelled'> {
    const degeneration = new DegenerationDetector();
    const assistantMessageId = this.deps.ids.next();
    let content = '';
    let thinking = '';
    const toolCalls: ToolCall[] = [];
    // Doc 16 §4 ítem 9: agrupa los `message.delta` de ESTE turno en ventanas de ~30 ms antes de
    // persistirlos como eventos — menos filas en `run_events` por el mismo streaming, mismo contenido
    // y mismo orden relativo por `field`. `content`/`thinking` (las variables de arriba) siguen
    // acumulando CADA chunk de inmediato, sin esperar al batcher: lo único que se retrasa es cuándo
    // se emite el evento, nunca el cómputo del mensaje final (`message.done`) ni el detector de
    // degeneración (que necesita ver cada chunk en el momento en que llega, no en lotes).
    const deltaBatcher = new MessageDeltaBatcher({
      intervalMs: this.deps.messageDeltaBatchMs,
      emit: (field, text) => this.deps.events.append({
        runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'message.delta',
        messageId: assistantMessageId, field, text,
      }),
    });

    try {
      for await (const chunk of this.deps.gateway.chat(
        live.effectiveConfig.model, request,
        {
          runId: live.runId, signal: live.abort.signal, authorizedLocality: [live.effectiveConfig.model.locality],
          // Doc 19 §2.5 (E3a delegación): un run hijo de delegación pide prioridad 'subagent' —
          // activa el orden de PRIORITY_ORDER que el Scheduler ya implementa (código muerto hasta
          // esta tarea), sin tocar Scheduler.ts/ModelGateway.ts. Con 1 slot medido, padre e hijo ya
          // están serializados por construcción; esto importa recién cuando haya más slots o varias
          // delegaciones encoladas (doc 19 §2.5 nota final).
          priority: live.delegationDepth > 0 ? 'subagent' : 'interactive',
        },
      )) {
        if (live.cancelRequested) { deltaBatcher.flush(); return 'cancelled'; }

        // PRIORIDAD CERO punto 2: llegó un chunk que NO es 'error' -> la conexión funciona de
        // verdad (Ollama respondió contenido real); se resetea la racha de `connection_refused` para
        // no arrastrar un conteo viejo de un corte aislado hacia una sesión larga y exitosa después.
        // A propósito NO se resetea para `chunk.type === 'error'` (si no, un `connection_refused`
        // repetido nunca acumularía racha: cada chunk de error la resetearía a 0 antes de que
        // `retryOrFail` la incremente a 1, y el tope de `MAX_CONNECTION_RETRIES` nunca se alcanzaría).
        if (chunk.type !== 'error') {
          live.connectionErrorStreak = 0;
          live.serverBusyErrorStreak = 0;
        }

        if (chunk.type === 'content') {
          if (content.length === 0 && chunk.text.length > 0) this.emitActivity(live, 'answering', 'Redactando la respuesta…');
          content += chunk.text;
          deltaBatcher.push('content', chunk.text);
          if (degeneration.push(chunk.text)) {
            deltaBatcher.flush();
            await this.fail(live, { code: 'format', message: 'Degeneración detectada: ventana de 50 caracteres repetida 4+ veces (doc 05 §2.4 paso 18).' });
            return 'failed';
          }
        } else if (chunk.type === 'thinking') {
          thinking += chunk.text;
          deltaBatcher.push('thinking', chunk.text);
        } else if (chunk.type === 'tool_call') {
          toolCalls.push(chunk.call);
        } else if (chunk.type === 'error') {
          deltaBatcher.flush();
          await this.persistTruncatedMessage(live, assistantMessageId, content, thinking);
          return this.retryOrFail(live, chunk.code ?? 'unknown', chunk.message, request);
        } else if (chunk.type === 'done') {
          // El contenido/thinking pendiente del batcher tiene que llegar a `run_events` ANTES que
          // `message.done` (mismo orden que antes de este cambio: todo el streaming, después el
          // cierre del turno) — de lo contrario un cliente que solo escucha eventos en vivo vería
          // `message.done` sin haber recibido el texto completo en `message.delta`.
          deltaBatcher.flush();
          const assistantMessage: ChatMessage = {
            id: assistantMessageId, originRunId: live.runId, role: 'assistant', content, thinking: thinking || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            // Punto 4 del encargo (doc 16 §10.4/§10.9, migración 0003): el modelo que EFECTIVAMENTE
            // generó este mensaje, no el que el chat tenga vigente más adelante — así el badge NUBE
            // por mensaje deja de depender de que el chat nunca haya cambiado de modelo.
            modelRef: live.effectiveConfig.model,
          };
          // Hallazgo E2E (2026-09-18): igual que en `start()`, `message.done` ya persiste el mensaje
          // vía la proyección de events/ — no duplicar con `this.deps.messages.append` acá (mismo
          // `messages.id` dos veces -> UNIQUE constraint failed contra SQLite real, ver arriba).
          this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'message.done', message: assistantMessage, metrics: chunk.metrics as ResponseMetrics });
          return { assistantMessage };
        }
      }
      // el stream terminó sin un chunk 'done' -> Ollama cortó la conexión (doc 10 caso 3).
      deltaBatcher.flush();
      await this.persistTruncatedMessage(live, assistantMessageId, content, thinking);
      return this.retryOrFail(live, 'stream_cut', 'El stream terminó sin un chunk done.', request);
    } catch (err) {
      deltaBatcher.flush();
      if (live.cancelRequested || live.abort.signal.aborted) return 'cancelled';
      await this.persistTruncatedMessage(live, assistantMessageId, content, thinking);
      return this.retryOrFail(live, 'stream_cut', err instanceof Error ? err.message : String(err), request);
    }
  }

  /** Doc 10 §6 caso (3) / doc 07 §4.5, doc 16 §4 ítem 5: persiste el fragmento parcial recibido
   *  hasta el corte como un mensaje `truncated: true` — "lo hecho hasta acá está guardado", visible
   *  de inmediato en el chat. Se usa `MessageRepository.append` (vía directa fuera del EventStore,
   *  igual que otros mensajes que no son el cierre de un turno con métricas reales del provider) en
   *  vez de un evento `message.done`: fabricar un `ResponseMetrics` para un fragmento cortado
   *  violaría "nunca inventar un dato medido" (doc 08 §5.4). El reintento INMEDIATO del mismo turno
   *  (`retryOrFail` -> 'retry') nunca agrega este mensaje a `live.history` — por eso queda excluido
   *  del contexto de ese reintento sin necesitar una rama especial (doc 07 §4.5 caso 1); un
   *  `run:continue` posterior sí lo recarga vía `messages.listByChat` y `ContextBuilder` le antepone
   *  "[respuesta cortada]" (doc 07 §4.5 caso 2, context-builder.ts). No hace nada si no llegó a
   *  generarse texto todavía (`content` vacío): no tiene sentido un mensaje vacío marcado cortado. */
  private async persistTruncatedMessage(live: LiveRun, id: string, content: string, thinking: string): Promise<void> {
    if (content.length === 0 && thinking.length === 0) return;
    try {
      await this.deps.messages.append(live.chatId, {
        id, originRunId: live.runId, role: 'assistant', content, thinking: thinking || undefined, truncated: true,
        modelRef: live.effectiveConfig.model,
      });
    } catch (err) {
      console.warn('[RunController] no se pudo persistir el mensaje truncado (doc 10 caso 3)', err);
    }
  }

  private async retryOrFail(
    live: LiveRun, code: string, message: string, request: ChatRequest,
  ): Promise<'retry' | 'failed' | 'cancelled'> {
    const verdict = live.loopDetector.recordError(code);
    if (verdict === 'nudge') this.pushNudge(live, `Reintento tras error ${code}: probá un enfoque distinto si vuelve a pasar.`);
    // Tarea "carga de modelo/oom_load": antes de cualquier otra cosa, si el modelo no entró en la
    // memoria del equipo se reintenta con menos capas en GPU (ver `handleOomLoad`) en vez de fallar
    // directo — esto es justamente lo que distingue `oom_load` de un error "normal" sin reintento.
    if (code === 'oom_load') return this.handleOomLoad(live, request, message);
    // PRIORIDAD CERO punto 2: `connection_refused` ("Ollama no responde") tenía reintento sin límite
    // acá abajo (`MUTATING_ERROR_RETRY_CODES.has(code)` es true para este código y nunca se volvía a
    // evaluar nada más) — con el provider caído, el run quedaba "Generando…" para siempre. Ahora se
    // cuentan los reintentos SEGUIDOS de este código puntual y, al llegar al máximo, se falla con
    // `provider_down` en vez de seguir reintentando (fail-fast real, no solo declarado en el nombre
    // de la constante). `stream_cut` (corte de stream ya en curso, típicamente transitorio) conserva
    // el reintento sin este límite adicional — doc 10 caso 3 lo trata distinto de "provider caído".
    if (code === 'connection_refused') {
      live.connectionErrorStreak += 1;
      if (live.connectionErrorStreak > MAX_CONNECTION_RETRIES) {
        await this.fail(live, {
          code: 'provider_down',
          message: `${message} (Ollama no respondió tras ${MAX_CONNECTION_RETRIES} reintentos de ~2s cada uno)`,
        });
        return 'failed';
      }
      await this.delay(2000);
      return 'retry';
    }
    if (MUTATING_ERROR_RETRY_CODES.has(code)) { await this.delay(2000); return 'retry'; }
    if (code === BUSY_RETRY_CODE) {
      live.serverBusyErrorStreak += 1;
      if (live.serverBusyErrorStreak > MAX_SERVER_BUSY_RETRIES) {
        await this.fail(live, {
          code: 'server_busy',
          message: `${message} (el proveedor siguió ocupado tras ${MAX_SERVER_BUSY_RETRIES} reintentos de ~3s cada uno)`,
        });
        return 'failed';
      }
      await this.delay(3000);
      if (live.cancelRequested || live.abort.signal.aborted) return 'cancelled';
      return 'retry';
    }
    await this.fail(live, { code: mapProviderErrorCode(code), message });
    return 'failed';
  }

  /** Tarea "carga de modelo/oom_load": el modelo no entró en la memoria del equipo. En vez de fallar
   *  directo, se reintenta con menos capas offloadeadas a GPU (`ChatRequest.options.numGpu`) — la
   *  primera vez se consulta `block_count` real (`modelLayerCountProbe`, opcional) para poder hablar
   *  en términos de "~75%/~50% de las capas"; sin esa información, un único intento con `numGpu: 0`
   *  (CPU pura, más lento pero siempre válido) es la única opción honesta. Cada paso se registra como
   *  `Adjustment`/`run.adjustment` (visible en la UI, doc de la tarea: "run_adjustment visible y
   *  reversible") y queda pegado a ESTE run (`live.numGpuOverride`, ver `buildChatRequest`) — un
   *  run/chat nuevo vuelve a `numGpu` automático, así que el ajuste nunca queda "para siempre". */
  private async handleOomLoad(live: LiveRun, request: ChatRequest, message: string): Promise<'retry' | 'failed'> {
    if (live.oomBlockCount === undefined && this.deps.modelLayerCountProbe) {
      try {
        live.oomBlockCount = await this.deps.modelLayerCountProbe.getBlockCount(live.effectiveConfig.model);
      } catch (err) {
        console.warn('[RunController] no se pudo consultar block_count del modelo; el reintento de oom_load va directo a CPU', err);
      }
    }
    const ratios = live.oomBlockCount !== undefined ? OOM_GPU_RATIOS : [0];
    if (live.oomGpuRetryStep >= ratios.length) {
      await this.fail(live, {
        code: 'oom_load',
        message: `${message} (se reintentó bajando las capas en GPU hasta usar solo CPU y el modelo tampoco entró — probá con un modelo más chico)`,
      });
      return 'failed';
    }
    const ratio = ratios[live.oomGpuRetryStep]!;
    const newNumGpu = live.oomBlockCount !== undefined ? Math.max(0, Math.round(live.oomBlockCount * ratio)) : 0;
    const requested = live.numGpuOverride ?? 'auto';
    live.numGpuOverride = newNumGpu;
    request.options.numGpu = newNumGpu;
    live.oomGpuRetryStep += 1;
    const adjustment: Adjustment = {
      param: 'numGpu',
      requested,
      applied: newNumGpu,
      reason: newNumGpu === 0
        ? 'El modelo no entró en la memoria de la GPU (oom_load); se reintenta solo con CPU — va a ser mucho más lento. Ajuste vale solo para este run.'
        : `El modelo no entró en la memoria de la GPU (oom_load); se reintenta con ~${Math.round(ratio * 100)}% de las capas en GPU (${newNumGpu}/${live.oomBlockCount}). Ajuste vale solo para este run.`,
      source: 'auto',
    };
    live.effectiveConfig.adjustments.push(adjustment);
    this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'run.adjustment', adjustment });
    // El ajuste es estado operativo del run: si la app se reinicia durante un permiso posterior,
    // `resumeAfterRestart` debe retomar con las mismas capas y el siguiente paso de la escalera.
    await this.deps.runs.update(live.runId, { effectiveConfig: live.effectiveConfig });
    await this.delay(500);
    return 'retry';
  }

  private delay(ms: number): Promise<void> {
    return (this.deps.delay ?? ((n: number) => new Promise<void>((resolve) => setTimeout(resolve, n))))(ms);
  }

  // ── finish (doc 05 §2.5 "alt finish() o respuesta final") ─────────────

  private async runFinish(live: LiveRun, protocol: ToolProtocol, call: ToolCall): Promise<void> {
    this.emitActivity(live, 'answering', 'Cerrando la respuesta…', call.id);
    const def = this.toolDef('finish');
    if (def) {
      const ctx = this.makeToolContext(live, call.id, noopCheckpointHandle());
      const result = await def.handler(call.args, ctx).catch((err): ToolResult => ({
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true,
      }));
      live.history.push(protocol.renderResult(call, result));

      // Doc 16 §4 ítem 6 ("verificá que quedan tasks persistidas"): en modo plan, `finish(summary,
      // tasks?)` puede traer el checklist directamente sin que el modelo haya llamado `task_update`
      // antes (el system suffix de modo plan, context-builder.ts, se lo pide explícitamente, pero
      // un modelo de 7-8B no siempre obedece dos tool calls en el orden pedido) — se persiste acá
      // también, de forma defensiva, para que "el plan quedó en tasks" no dependa únicamente de que
      // el modelo haya llamado task_update por su cuenta.
      const structured = result.structured as { tasks?: { title: string; status: string }[] } | undefined;
      if (structured?.tasks && structured.tasks.length > 0) {
        const tasks = structured.tasks.map((t, ord) => ({
          id: `${live.chatId}:task:${ord}`, ord, title: t.title,
          status: t.status as 'pending' | 'in_progress' | 'done' | 'skipped',
        }));
        await this.deps.taskManager.update(live.chatId, live.runId, tasks);
      }
    }
    await this.finishCompleted(live);
  }

  // ── Tool calls: permisos, checkpoint, ejecución (doc 05 §2.5-2.9) ──────

  /**
   * Corrige una sola vez el rechazo estrecho observado en modelos con TextToolProtocol: el usuario
   * pidió modificar una ruta concreta, pero la primera respuesta le solicita el contenido que
   * `read_file` puede obtener. La corrección es un mensaje system efímero y describe honestamente
   * la intervención del runtime; no suplanta al usuario ni concede permisos a ninguna tool.
   */
  private correctMissingTextTool(
    live: LiveRun,
    calls: ToolCall[],
    assistantText: string,
    availableTools: ToolDefinition[],
  ): boolean {
    if (
      live.mode !== 'agent'
      || live.effectiveConfig.transport !== 'text'
      || live.generatedResponses !== 1
      || live.iteration !== 0
      || live.textMutationCorrections >= 1
      || calls.length !== 0
      || !availableTools.some((tool) => tool.name === 'read_file')
    ) return false;

    const userMessage = [...live.history].reverse().find((message) => (
      message.role === 'user'
      && message.ephemeral !== true
      && !message.content.trimStart().startsWith('<tool_result')
    ));
    if (!userMessage) return false;

    const correction = textMutationCorrectionFor(userMessage.content, assistantText);
    if (!correction) return false;

    live.textMutationCorrections += 1;
    live.history.push({
      id: this.deps.ids.next(),
      role: 'system',
      ephemeral: true,
      content: [
        'Corrección interna del runtime:',
        `la respuesta anterior dejó pendiente obtener el contenido de "${correction.path}", aunque read_file está disponible.`,
        'El usuario ya indicó una modificación concreta. No inventes el contenido ni pidas confirmación:',
        'llamá ahora a read_file con esa ruta. Esta corrección no concede permisos;',
        'la llamada seguirá la política normal de permisos de la aplicación.',
      ].join(' '),
    });
    return true;
  }

  /**
   * El contrato del modo Plan exige pasos concretos. Si una respuesta final llega como prosa sin
   * `task_update`, `finish.tasks` ni una lista Markdown explícita, se pide el checklist una sola vez.
   * La prosa nunca se transforma en tareas; si el segundo intento tampoco trae pasos, el cierre
   * informa un error explícito. Un plan sin tareas no se presenta como completado.
   */
  private correctMissingPlan(
    live: LiveRun,
    calls: ToolCall[],
    assistantText: string,
    recoveredFromFormatError: boolean,
  ): boolean {
    const finishesWithoutTasks = calls.length > 0 && calls.every((call) => {
      if (call.name !== 'finish') return false;
      const tasks = (call.args as { tasks?: unknown } | undefined)?.tasks;
      return !Array.isArray(tasks) || tasks.length === 0;
    });
    if (
      live.mode !== 'plan'
      || recoveredFromFormatError
      || live.planCorrections >= 1
      || (calls.length !== 0 && !finishesWithoutTasks)
      || planStepsFromText(assistantText).length > 0
      || this.deps.events.since(live.runId, 0).some((event) => event.type === 'tasks.updated')
    ) return false;

    live.planCorrections += 1;
    live.history.push({
      id: this.deps.ids.next(),
      // Algunas plantillas locales (Qwen3) omiten system intermedios: el recordatorio debe entrar
      // como mensaje de conversación. Se identifica como interno y no se persiste como pedido humano.
      role: 'user',
      ephemeral: true,
      content: [
        'Corrección interna del runtime: la respuesta anterior no incluyó un plan explícito.',
        'Seguís en modo PLAN. Convertí tu análisis anterior en pasos concretos pendientes, uno por línea: 1. ..., 2. ..., 3. ...',
        'La respuesta debe contener el plan; no puede quedar vacía. No ejecutes el plan ni repitas sólo la explicación del problema.',
      ].join(' '),
    });
    return true;
  }

  private async handleToolCalls(live: LiveRun, calls: ToolCall[], text: string): Promise<TurnOutcome> {
    // Feedback real v0.2.1 (usuario, modo Agente): "a 'Hola' el run hizo 8+ turnos... y respondió DOS
    // veces". Antes esto nudgeaba hasta 2 veces ("Elegí una tool o llamá a finish") antes de cerrar en
    // el 3er turno sin tool call — cada nudge generaba una respuesta más del modelo, visible para el
    // usuario, antes del cierre real (de ahí las "dos respuestas"). Ahora: una respuesta de texto sin
    // tool calls ES la respuesta final (finish implícito), sin excepción — ver punto 2 del encargo
    // ("saludos y preguntas conversacionales no deben disparar tools", reforzado también en el system
    // prompt, agent/defaults.ts). `finishWithText` no vuelve a emitir el texto: `assistantMessage` ya
    // se emitió como `message.done` en `streamChat` antes de llegar acá, así que nunca hay una segunda
    // respuesta final por run.
    if (calls.length === 0) {
      this.emitActivity(live, 'answering', 'Redactando la respuesta…');
      await this.finishWithText(live, text || '(sin respuesta)');
      return 'completed';
    }

    const protocol = this.protocolFor(live);
    const classified = calls.map((call) => ({ call, classification: this.classify(call) }));
    const mutatingIndex = classified.findIndex((c) => this.toolDef(c.call.name)?.mutating === true);
    const toExecute = mutatingIndex === -1 ? classified : [classified[mutatingIndex]!];
    const deferred = mutatingIndex === -1 ? [] : classified.filter((_, i) => i !== mutatingIndex);

    for (const { call } of deferred) {
      live.history.push(protocol.renderResult(call, {
        content: [{ type: 'text', text: 'Pendiente: solo se ejecuta una tool mutante por turno (doc 05 §2.5 paso 25).' }],
        isError: false,
      }));
    }

    for (const { call, classification } of toExecute) {
      if (live.cancelRequested) return 'cancelled';
      const outcome = await this.executeOneToolCall(live, call, classification);
      if (outcome === 'failed' || outcome === 'cancelled') return outcome;
    }

    live.iteration += 1;
    await this.deps.runs.update(live.runId, { iteration: live.iteration });
    this.returnToQueue(live);
    await this.persistRunState(live);
    return 'continue';
  }

  private toolDef(name: string): ToolDefinition | undefined {
    return this.deps.tools.get(name);
  }

  private classify(call: ToolCall): ToolClassification {
    const def = this.toolDef(call.name);
    if (def?.classify) return def.classify(call.args);
    return { category: def?.category ?? 'read', risk: 'low', summary: call.name };
  }

  /** Registro (write-ahead, doc 10 §3) + LoopDetector + permisos + (si allow) ejecución. */
  private async executeOneToolCall(
    live: LiveRun, call: ToolCall, classification: ToolClassification,
  ): Promise<'ok' | 'failed' | 'cancelled'> {
    const protocol = this.protocolFor(live);
    const argsHash = hashArgs(call.name, call.args);
    let record: ToolCallRecord = {
      id: call.id, runId: live.runId, iteration: live.iteration, toolName: call.name, args: call.args,
      argsHash, category: classification.category, risk: classification.risk,
      transport: live.effectiveConfig.transport, status: 'pending',
    };
    // Doc 10 §3 ("expected_pre_hash... escrita en el mismo INSERT que produce tool.registered") / doc
    // 16 §4 ítem 16: para las tres tools mutantes de archivo, se completa acá con el último hash que
    // ESTE run vio para ese path (`LastReadHashes`, ports.ts) — o `undefined` si nunca lo leyó. Sin
    // `readHashes` (opcional), queda `undefined` y el comportamiento es el previo a esta tarea.
    if (MUTATING_FILE_TOOLS.has(call.name) && this.deps.readHashes && classification.paths?.length === 1) {
      record = { ...record, expectedPreHash: this.deps.readHashes.lastHash(live.runId, classification.paths[0]!) };
    }
    // Hallazgo E2E (2026-09-18, eval/harness.ts): NO se llama `this.deps.toolCalls.upsert(record)`
    // acá además de emitir el evento — `tool.registered` ya inserta la fila "write-ahead" vía su
    // proyección (events/projections/toolCalls.ts `onRegistered`, un INSERT simple, no upsert).
    // Llamar a ambos insertaba la misma `tool_calls.id` dos veces (UNIQUE constraint failed) en la
    // primera corrida contra SQLite real; los tests unitarios no lo detectaban por la misma razón
    // que el bug análogo en `start()` (ver más arriba).
    this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'tool.registered', call: record });

    // La proyección de `tool.registered` (events/projections/toolCalls.ts, fuera de esta zona) hace el
    // INSERT "write-ahead" real, pero no escribe `expected_pre_hash` (columna reservada desde la
    // migración 1, doc 10 §3, nunca completada hasta esta tarea). Se completa con un UPDATE puntual
    // inmediatamente después de que la fila ya existe (mismo patrón que
    // `MessageRepository.markCompacted` para `messages.compacted_by`): `upsert()` cae en la rama
    // `ON CONFLICT(id) DO UPDATE`, nunca en un INSERT nuevo, así que no repite el bug de arriba.
    if (record.expectedPreHash !== undefined) {
      await this.deps.toolCalls.upsert(record);
    }

    const loopVerdict = live.loopDetector.recordToolCall(call.name, argsHash);
    if (loopVerdict === 'nudge') this.pushNudge(live, `Repetiste "${call.name}" con los mismos argumentos; probá algo distinto.`);
    if (loopVerdict === 'abort') {
      await this.fail(live, { code: 'loop', message: `Loop detectado en "${call.name}" (doc 05 §2.10 / doc 10 caso 10).` });
      return 'failed';
    }

    // Hallazgo #1/#4: sin `toolCallId: call.id` acá, `DefaultPermissionEngine.buildRequest` (engine.ts)
    // rellena `toolCallId: call.toolCallId ?? ''` y el evento `tool.permission` viaja al renderer con
    // request.toolCallId === '' — la PermissionCard nunca se renderiza (runStore/ChatMessageList
    // indexan por ese id) y el run queda colgado en awaiting_permission. También se pasan los paths
    // que el run ya tocó, que `isBlockedByDefault` usa para permitir un git reset/checkout sobre algo
    // que el propio run escribió (doc 06 §5).
    // Variable intermedia (no literal directo): `PermissionEngine.evaluate` solo tipa su parámetro
    // como `ToolClassification & { toolName: string }`, y un objeto literal con `toolCallId`/
    // `touchedPaths` extra fallaría el chequeo de "excess property" de TS aunque el motor real
    // (EvaluateCall en permissions/engine.ts) los declare opcionales.
    const evaluateCall = { ...classification, toolName: call.name, toolCallId: call.id, touchedPaths: live.touchedPaths };
    const decision = this.deps.permissions.evaluate(evaluateCall, live.mode, live.agent.permissions);

    if (decision.decision === 'deny') {
      record = { ...record, status: 'denied' };
      await this.deps.toolCalls.upsert(record);
      this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'tool.decision', toolCallId: call.id, decision });
      live.history.push(protocol.renderResult(call, { content: [{ type: 'text', text: `acción no permitida: ${decision.reason}` }], isError: true }));
      return 'ok';
    }

    if (decision.decision === 'ask') {
      record = { ...record, status: 'awaiting_permission' };
      await this.deps.toolCalls.upsert(record);
      // Preparar la espera antes de publicar: una respuesta inmediata no se pierde.
      const pendingAnswer = new Promise<PermissionAnswer>((resolve) => {
        live.pendingPermission = { toolCallId: call.id, resolve };
      });
      this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'tool.permission', request: decision.request });
      this.transition(live, 'awaiting_permission');
      this.emitActivity(live, 'waiting_permission', `Esperando permiso para "${call.name}"…`, call.id);
      await this.persistRunState(live);

      const answer = await pendingAnswer;
      if (live.cancelRequested) return 'cancelled';

      return this.afterPermissionAnswered(live, call, record, classification, decision.request, answer);
    }

    this.transition(live, 'executing_tool');
    const activity = this.activityForTool(call.name, call.args);
    if (activity) this.emitActivity(live, activity.phase, activity.label, call.id);
    await this.persistRunState(live);
    return this.runHandler(live, call, record, classification);
  }

  /** Continuación común tras responder una `PermissionRequest` en `ask` (doc 05 §2.6 paso 28): la
   *  usan tanto el camino en vivo (`executeOneToolCall`, arriba) como `resumeAfterRestart` (doc 10
   *  §5.2, run rehidratado tras un reinicio). Persiste la decisión, y si corresponde ("recordar"),
   *  la regla vía `PermissionMemory` (doc 16 §4 ítem 1). */
  private async afterPermissionAnswered(
    live: LiveRun, call: ToolCall, record: ToolCallRecord, classification: ToolClassification,
    request: PermissionRequest, answer: PermissionAnswer,
  ): Promise<'ok' | 'cancelled'> {
    const protocol = this.protocolFor(live);
    this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'tool.decision', toolCallId: call.id, decision: answer });

    if (this.deps.permissionMemory) {
      try {
        await this.deps.permissionMemory.recordAnswer(request, answer, this.deps.projectId, call.id);
      } catch (err) {
        // No perder el run por un fallo de auditoría/memoria de permisos (doc 10 §1 "nunca perder
        // trabajo" pesa más acá que registrar la regla): se loguea y se sigue con allow_once.
        console.warn('[RunController] no se pudo persistir la decisión de permiso', err);
      }
    }

    if (answer.answer === 'deny') {
      record = { ...record, status: 'denied' };
      await this.deps.toolCalls.upsert(record);
      live.history.push(protocol.renderResult(call, { content: [{ type: 'text', text: `acción no permitida: ${answer.reason ?? 'denegado por el usuario'}` }], isError: true }));
      this.transition(live, 'parsing');
      await this.persistRunState(live);
      return 'ok';
    }
    record = { ...record, status: 'approved' };
    await this.deps.toolCalls.upsert(record);
    this.transition(live, 'executing_tool');
    const activity = this.activityForTool(call.name, call.args);
    if (activity) this.emitActivity(live, activity.phase, activity.label, call.id);
    await this.persistRunState(live);
    return this.runHandler(live, call, record, classification);
  }

  private async runHandler(
    live: LiveRun, call: ToolCall, record: ToolCallRecord, classification: ToolClassification,
  ): Promise<'ok' | 'cancelled'> {
    const protocol = this.protocolFor(live);
    const def = this.toolDef(call.name);
    if (!def) {
      live.history.push(protocol.renderResult(call, { content: [{ type: 'text', text: `tool desconocida: ${call.name}` }], isError: true }));
      return 'ok';
    }

    // Doc 19 §2.5: `delegate` se intercepta ANTES del despacho genérico (mismo patrón que `finish`,
    // `runFinish` más arriba) — su orquestación real necesita crear un run/chat hijo y llamar
    // `this.start()` recursivamente, algo que el `handler` genérico de la tool (tools/builtin/
    // delegate.ts) no puede hacer con el `ToolContext` estándar.
    if (call.name === 'delegate') {
      const runningRecord: ToolCallRecord = { ...record, status: 'running', startedAt: this.deps.clock.now() };
      await this.deps.toolCalls.upsert(runningRecord);
      this.emitToolStatus(live, call.id, 'running');
      return this.runDelegateTool(live, call, runningRecord, classification);
    }

    let checkpointHandle: CheckpointHandle | undefined;
    if (def.mutating) {
      // Hallazgo E2E (2026-09-18): `checkpoints.begin()` solo reserva el id en memoria — la fila de
      // `checkpoints` recién se inserta en `checkpoints.commit()`, más abajo. Escribir acá
      // `tool_calls.checkpoint_id = checkpointHandle.checkpointId` violaba la FK
      // `tool_calls.checkpoint_id REFERENCES checkpoints(id)` (esa fila todavía no existe) contra
      // SQLite real, con foreign_keys=ON (driver.ts). El evento `checkpoint.created` (abajo, tras el
      // commit) ya deja `tool_calls.checkpoint_id` seteado vía su proyección (`onCreated`, doc 03
      // §6) una vez que el checkpoint existe, así que no hace falta duplicarlo acá.
      checkpointHandle = await this.deps.checkpoints.begin(live.runId, call.id, classification.paths ?? []);
    }

    record = { ...record, status: 'running', startedAt: this.deps.clock.now() };
    await this.deps.toolCalls.upsert(record);
    this.emitToolStatus(live, call.id, 'running');

    const toolCtx = this.makeToolContext(live, call.id, checkpointHandle ?? noopCheckpointHandle());

    let result: ToolResult;
    try {
      result = await this.invokeHandlerWithTimeout(def, call, toolCtx);
    } catch (err) {
      if (live.cancelRequested) {
        await this.deps.toolCalls.upsert({ ...record, status: 'cancelled', finishedAt: this.deps.clock.now() });
        this.emitToolStatus(live, call.id, 'cancelled');
        return 'cancelled';
      }
      result = { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }

    // Doc 16 §4 ("robustez con modelos chicos"; medido: qwen3:8b repitiendo un edit_file ambiguo 4
    // veces seguidas sin cambiar nada, doc 16 §6, hasta que el LoopDetector abortó el run). A partir
    // del SEGUNDO error idéntico de esta tool en el run, se le agrega al modelo una pista concreta
    // (no solo el error crudo repetido) ANTES de que `recordToolCall`/`recordError` disparen el abort
    // real más adelante — le da al modelo una oportunidad más de corregir el enfoque en vez de
    // limitarse a ver el mismo texto de error una y otra vez.
    if (result.isError) {
      const errorText = errorTextOf(result);
      if (errorText !== undefined) {
        const repeatCount = live.loopDetector.recordToolResultError(call.name, errorText);
        if (repeatCount >= 2) result = withRepeatedErrorHint(result, call.name, repeatCount);
      }
    } else {
      live.loopDetector.clearToolResultError(call.name);
    }

    if (checkpointHandle) {
      const checkpoint = await this.deps.checkpoints.commit(checkpointHandle);
      // Feedback real v0.2.1, punto 5: "cada tool call (incluso run_command y list_files) genera un
      // Checkpoint vacío '0 archivo(s) +0 −0'". `list_files`/`task_update` ya no llegan acá (no son
      // `mutating`); pero `run_command` sí lo es (para reversibilidad futura si algún día detecta
      // paths) y hoy nunca puebla `classification.paths`, así que `checkpoint.files` queda `[]` en
      // cada corrida — sin este gate se emitía `checkpoint.created` igual, vacío, cada vez. Ahora solo
      // se registra el checkpoint (evento + fila `checkpoints`) cuando de verdad hubo archivos
      // tocados; si no, `record.checkpointId` queda sin setear (comportamiento equivalente a "esta
      // tool call no tiene checkpoint asociado").
      if (checkpoint.files.length > 0) {
        this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'checkpoint.created', checkpoint });
        record = { ...record, checkpointId: checkpoint.id };
      }
      // Si quedó vacío (típicamente `run_command`, que nunca puebla `classification.paths`), no se
      // emite `checkpoint.created` ni se setea `checkpointId` — la advertencia de "esto pudo cambiar
      // archivos y el revert no lo cubre" la agrega la tool misma cuando tiene evidencia real (ver
      // `tools/builtin/run_command.ts`, comparación de `git status --porcelain` antes/después).
    }

    const finalStatus = result.isError ? 'failed' : 'done';
    record = { ...record, status: finalStatus, finishedAt: this.deps.clock.now(), resultPreview: previewOf(result), resultIsError: result.isError };
    await this.deps.toolCalls.upsert(record);
    this.emitToolStatus(live, call.id, finalStatus, previewOf(result));

    live.history.push(protocol.renderResult(call, result));

    if (call.name === 'task_update' && result.structured) {
      // Hallazgo (doc 16 §4 ítem 6, "verificá que quedan tasks persistidas"): `task_update` devuelve
      // `{ steps: {title,status}[] }` (tools/builtin/task_update.ts), no un `Omit<Task,'chatId'>[]`
      // directo — el cast anterior (`result.structured as Parameters<TaskManager['update']>[2]`)
      // pasaba el objeto envoltorio tal cual a `TaskManager.update`, que hace `tasks.map(...)` sobre
      // eso y explota (`{steps:[...]}.map is not a function`) en la primera llamada real a
      // `task_update` contra un modelo real — nunca se había ejercitado contra SQLite+modelo real.
      // `id` se ancla a `chatId` (no a `runId`): el checklist es del chat, no de un run puntual —
      // varias llamadas a `task_update` en el mismo run, o un `run:continue` posterior, deben
      // actualizar las mismas filas (ON CONFLICT(id) DO UPDATE, persistence/repositories/task.ts)
      // en vez de duplicar tareas con cada llamada.
      const steps = (result.structured as { steps?: { title: string; status: string }[] }).steps ?? [];
      const tasks = steps.map((s, ord) => ({
        id: `${live.chatId}:task:${ord}`, ord, title: s.title,
        status: s.status as 'pending' | 'in_progress' | 'done' | 'skipped',
      }));
      await this.deps.taskManager.update(live.chatId, live.runId, tasks);
    }

    // Hallazgo #1/#4: paths tocados por esta tool, para excusar un git reset/checkout posterior del
    // propio run (doc 06 §5). Solo si terminó sin error: un write que falló no "tocó" el archivo.
    if (def.mutating && !result.isError && classification.paths) {
      for (const p of classification.paths) live.touchedPaths.add(p);
    }

    return 'ok';
  }

  // ── delegate (doc 19 §2.5, E3a) ─────────────────────────────────────────

  /** Orquesta una delegación completa: valida el pedido, aplica los límites de profundidad/cantidad,
   *  resuelve el destino (agente existente o worker efímero), crea el chat/run hijo, espera a que
   *  termine y traduce su resultado a `DelegationResultSchema`. Nunca lanza: cualquier problema se
   *  devuelve como un `ToolResult` (con `isError` cuando corresponde) para que el modelo padre pueda
   *  reaccionar, igual que cualquier otra tool. */
  private async runDelegateTool(
    live: LiveRun, call: ToolCall, record: ToolCallRecord, _classification: ToolClassification,
  ): Promise<'ok' | 'cancelled'> {
    const protocol = this.protocolFor(live);
    const finish = async (result: ToolResult, structured?: DelegationResult): Promise<'ok'> => {
      const finalStatus: ToolCallRecord['status'] = result.isError ? 'failed' : 'done';
      const finalRecord: ToolCallRecord = {
        ...record, status: finalStatus, finishedAt: this.deps.clock.now(),
        resultPreview: previewOf(result), resultIsError: result.isError,
      };
      await this.deps.toolCalls.upsert(finalRecord);
      this.emitToolStatus(live, call.id, finalStatus, previewOf(result));
      live.history.push(protocol.renderResult(call, { ...result, structured }));
      return 'ok';
    };
    const failWith = (text: string): Promise<'ok'> => finish({ content: [{ type: 'text', text }], isError: true });

    const parsedArgs = DelegationRequestSchema.safeParse(call.args);
    if (!parsedArgs.success) {
      return failWith(`delegate: argumentos inválidos (${parsedArgs.error.issues.map((i) => i.message).join('; ')}).`);
    }
    const args: DelegationRequest = parsedArgs.data;

    // Paso 1 (doc 19 §2.5): profundidad máxima — un run que ya es hijo de otra delegación no delega
    // de nuevo. Error de `ToolResult`, no excepción: el run padre sigue vivo y puede reaccionar.
    if (live.delegationDepth >= MAX_DELEGATION_DEPTH) {
      return failWith('delegate: profundidad máxima de delegación alcanzada (este run ya es hijo de otra delegación).');
    }
    // Paso 2: máximo N delegaciones por run — cuenta las tool calls `delegate` YA registradas para
    // este run (sin contar la actual, todavía no cerrada).
    const priorDelegations = (await this.deps.toolCalls.listByRun(live.runId))
      .filter((c) => c.toolName === 'delegate' && c.id !== call.id);
    if (priorDelegations.length >= MAX_DELEGATIONS_PER_RUN) {
      return failWith(`delegate: límite de delegaciones por run alcanzado (máximo ${MAX_DELEGATIONS_PER_RUN}).`);
    }

    // Paso 3: resuelve destino — agente personal existente por targetAgentId, o un worker efímero
    // (owner_kind: 'worker', doc 19 §0) si no se indica ninguno. El modelo NUNCA debe poder inventar
    // un targetAgentId que no exista: se verifica contra el resolver real antes de seguir.
    let targetAgentId = args.targetAgentId;
    if (live.enabledCollaboratorIds) {
      if (!targetAgentId) {
        return failWith('delegate: elegí un targetAgentId de la lista de colaboradores habilitados para este chat.');
      }
      if (!live.enabledCollaboratorIds.has(targetAgentId)) {
        return failWith(`delegate: el agente "${targetAgentId}" no está habilitado como colaborador de este chat.`);
      }
    }
    if (targetAgentId) {
      const exists = await this.deps.agents.resolve(targetAgentId).catch(() => undefined);
      if (!exists) return failWith(`delegate: no existe el agente "${targetAgentId}".`);
    } else {
      if (!this.deps.agentProfiles) {
        return failWith('delegate: no se indicó targetAgentId y este runtime no puede crear un worker temporal (agentProfiles no está inyectado).');
      }
      const worker = await this.deps.agentProfiles.createProfile({
        name: `Worker temporal (${args.role ?? 'custom'})`,
        role: args.role ?? 'custom',
        modelMode: 'fixed',
        model: live.effectiveConfig.model,
        permissionPreset: toAgentLevelPreset(live.agent.permissions.preset),
        memoryScope: 'global',
      }, 'worker');
      targetAgentId = worker.id;
    }

    // Paso 4: chat hijo en el mismo proyecto del padre, con origin_run_id -> este run.
    const parentChat = await this.deps.chats.get(live.chatId);
    const now = this.deps.clock.now();
    const childChatId = this.deps.ids.next();
    await this.deps.chats.create({
      id: childChatId, projectId: parentChat?.projectId ?? '', agentId: targetAgentId,
      mode: 'agent', createdAt: now, updatedAt: now, archived: false, originRunId: live.runId,
    });

    // Paso 5: arranca el run hijo. `this.start()` deriva `delegationDepth = padre+1` por sí solo a
    // partir de `chats.origin_run_id` (ver `start()` más arriba) — no hace falta pasarlo acá.
    if (args.budget?.maxIterations !== undefined) {
      this.delegatedIterationBudgets.set(childChatId, Math.max(1, Math.floor(args.budget.maxIterations)));
    }
    let childRunId: string;
    try {
      ({ runId: childRunId } = await this.start(childChatId, buildDelegationPrompt(args), 'agent'));
    } finally {
      this.delegatedIterationBudgets.delete(childChatId);
    }
    live.childRunIds.add(childRunId);

    this.deps.events.append({
      runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'run.delegated',
      parentRunId: live.runId, childRunId, childChatId, targetAgentId, task: args.task, toolCallId: call.id,
    });

    // Paso 6: espera a que el hijo termine (doc 19 §2.5: "el loop de tools ya es síncrono dentro de
    // una iteración; no se introduce concurrencia nueva" — con 1 slot medido, padre e hijo ya están
    // serializados por el Scheduler; este polling solo detecta CUÁNDO terminó, no agrega una segunda
    // inferencia en paralelo). Presupuesto de tiempo opcional (`budget.timeoutMs`); si se agota, se
    // cancela el hijo en vez de dejarlo corriendo indefinidamente.
    const timeoutMs = args.budget?.timeoutMs ?? this.deps.defaultToolTimeoutMs ?? 120_000;
    const finalRun = await this.waitForRunTerminal(childRunId, timeoutMs);
    live.childRunIds.delete(childRunId);
    if (live.cancelRequested) return 'cancelled';

    const delegationResult = await this.buildDelegationResult(childChatId, finalRun);
    return finish(
      { content: [{ type: 'text', text: JSON.stringify(delegationResult) }], isError: delegationResult.status === 'failed' },
      delegationResult,
    );
  }

  /** Sondea `this.live` hasta que el run hijo salga de memoria (terminó, en este proceso) o se agote
   *  `timeoutMs`, en cuyo caso lo cancela. Usa `this.delay()` (inyectable) para no depender de
   *  temporizadores reales en los tests. */
  private async waitForRunTerminal(runId: string, timeoutMs: number): Promise<RunRecord | undefined> {
    const deadline = this.deps.clock.now() + Math.max(0, timeoutMs);
    while (this.live.has(runId)) {
      if (this.deps.clock.now() >= deadline) {
        await this.cancel(runId);
        // Margen corto para que cancel() termine de resolver el hijo antes de leer su estado final
        // (cancel() solo pide la cancelación; el propio loop del hijo es quien la resuelve).
        for (let i = 0; i < 20 && this.live.has(runId); i += 1) await this.delay(50);
        break;
      }
      await this.delay(50);
    }
    return this.deps.runs.get(runId);
  }

  /** Doc 19 §2.5 paso 6: intenta parsear el `finish(summary)` del hijo como `DelegationResultSchema`
   *  (reusa el mismo criterio que el protocolo de tool-calling en texto: el JSON puede venir dentro
   *  del `summary` de la tool call `finish`, no en el `content` plano del mensaje). Si el run hijo no
   *  terminó en `completed`, o no hay ningún `finish` registrado, o el JSON no valida, degrada a un
   *  resultado envuelto en vez de fallar la delegación completa (nunca revienta el run padre por un
   *  formato imperfecto de un modelo de 8B). */
  private async buildDelegationResult(childChatId: string, finalRun: RunRecord | undefined): Promise<DelegationResult> {
    if (finalRun && finalRun.state !== 'completed') {
      return {
        status: 'failed',
        summary: finalRun.error?.message ?? `el run del worker terminó en estado "${finalRun.state}" sin completar la tarea.`,
        uncertainties: ['el run hijo no llegó a completed'],
      };
    }
    const messages = await this.deps.messages.listByChat(childChatId);
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    const finishMsg = [...assistantMessages].reverse().find((m) => m.toolCalls?.some((tc) => tc.name === 'finish'));
    const finishCall = finishMsg?.toolCalls?.find((tc) => tc.name === 'finish');
    const finishArgs = finishCall?.args as Record<string, unknown> | undefined;
    const workerContent = finishMsg?.content.trim();
    const rawText = typeof finishArgs?.['summary'] === 'string'
      ? finishArgs['summary'] as string
      : assistantMessages[assistantMessages.length - 1]?.content;

    if (!rawText || rawText.trim().length === 0) {
      return { status: 'needs_input', summary: 'el worker no dejó ninguna respuesta final.', uncertainties: ['sin mensaje de finish'] };
    }
    try {
      const parsed = DelegationResultSchema.safeParse(JSON.parse(rawText));
      if (parsed.success) {
        const summary = workerContent && workerContent !== parsed.data.summary.trim()
          ? `${parsed.data.summary.trim()}\n\nEntregable del worker:\n${workerContent}`
          : parsed.data.summary;
        const verified = await this.verifyDelegationArtifacts(parsed.data.artifacts);
        const uncertainties = [...(parsed.data.uncertainties ?? []), ...verified.uncertainties];
        return {
          ...parsed.data,
          summary,
          artifacts: verified.artifacts.length > 0 ? verified.artifacts : undefined,
          uncertainties: uncertainties.length > 0 ? [...new Set(uncertainties)] : undefined,
        };
      }
    } catch {
      // no era JSON — cae a la degradación de texto crudo de abajo.
    }
    const summary = workerContent && workerContent !== rawText.trim()
      ? `${rawText.trim()}\n\nEntregable del worker:\n${workerContent}`
      : rawText;
    return { status: 'completed', summary, uncertainties: ['formato no estructurado'] };
  }

  /** Un artifact declarado por el modelo sólo vuelve al padre si existe como archivo dentro de la
   *  raíz real del proyecto. `WorkspaceFs.resolve` rechaza absolutos/`..`; `realpath` evita aceptar un
   *  symlink que lexicalmente está adentro pero apunta afuera. Un path no verificable se excluye y se
   *  explica como incertidumbre: nunca se afirma que el worker creó algo que no existe. */
  private async verifyDelegationArtifacts(
    artifacts: DelegationResult['artifacts'],
  ): Promise<{ artifacts: NonNullable<DelegationResult['artifacts']>; uncertainties: string[] }> {
    const verified: NonNullable<DelegationResult['artifacts']> = [];
    const uncertainties: string[] = [];
    if (!artifacts || artifacts.length === 0) return { artifacts: verified, uncertainties };

    for (const artifact of artifacts) {
      const accepted = await this.classifyWorkspaceFile(artifact.path) === 'safe';
      if (accepted) verified.push(artifact);
      if (!accepted) {
        uncertainties.push(`artifact excluido porque no se pudo verificar dentro del proyecto: "${artifact.path}"`);
      }
    }
    return { artifacts: verified, uncertainties };
  }

  /** Verifica la ruta canónica antes de leer/afirmar un archivo. `WorkspaceFs.resolve` por sí solo
   * sólo confina lexicalmente: un symlink o junction con nombre inocuo puede apuntar fuera de la
   * raíz o a `.git`. Este helper también reevalúa rutas protegidas sobre el destino real. */
  private async classifyWorkspaceFile(relPath: string): Promise<'safe' | 'missing' | 'unsafe'> {
    const workspaceFs = this.deps.workspaceFs;
    if (!workspaceFs || workspaceFs.isProtected(relPath)) return 'unsafe';
    try {
      const rootReal = await realpath(this.deps.projectRoot);
      const targetReal = await realpath(workspaceFs.resolve(relPath));
      const relativeToRoot = relative(rootReal, targetReal);
      const insideRoot = relativeToRoot === ''
        || (!isAbsolute(relativeToRoot) && relativeToRoot !== '..' && !relativeToRoot.startsWith(`..${sep}`));
      if (!insideRoot || workspaceFs.isProtected(relativeToRoot)) return 'unsafe';
      return (await stat(targetReal)).isFile() ? 'safe' : 'unsafe';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
    }
  }

  /** Hallazgo #3 (parcial, dentro del alcance de agent/): sin esto, un handler colgado (p. ej.
   *  run_command si `taskkill` falla y `spawnAndCollect` nunca ve 'close') deja el run en
   *  'executing_tool' para siempre. La mitad de la corrección que vive en
   *  packages/runtime/src/tools/builtin/run_command.ts (timer de gracia tras killTree) queda FUERA
   *  del alcance de esta tarea (solo packages/runtime/src/agent) — ver skipped en la salida
   *  estructurada. */
  private invokeHandlerWithTimeout(def: ToolDefinition, call: ToolCall, toolCtx: ToolContext): Promise<ToolResult> {
    const handlerPromise = def.handler(call.args, toolCtx);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          content: [{ type: 'text', text: `la tool "${call.name}" excedió el timeout de ${toolCtx.timeoutMs}ms (doc 04 §4 ToolContext.timeoutMs) y se marcó como fallida` }],
          isError: true,
        });
      }, toolCtx.timeoutMs);
    });
    return Promise.race([handlerPromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
      // Si el timeout ganó la carrera, `handlerPromise` puede resolver o rechazar más tarde sin que
      // nadie más la mire: se la silencia acá para no dejar un unhandledRejection.
      handlerPromise.catch(() => {});
    });
  }

  private makeToolContext(live: LiveRun, toolCallId: string, checkpoint: CheckpointHandle): ToolContext {
    return {
      projectRoot: this.deps.projectRoot, cwd: this.deps.projectRoot, runId: live.runId, toolCallId,
      signal: live.abort.signal, timeoutMs: this.deps.defaultToolTimeoutMs ?? 120_000,
      fs: this.deps.workspaceFs ?? unavailableWorkspaceFs(),
      checkpoint,
      emit: (ev) => this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'tool.progress', toolCallId: ev.toolCallId, text: ev.text }),
      log: () => {},
    };
  }

  private async handleParseError(live: LiveRun, errors: string[]): Promise<boolean> {
    live.formatRetries += 1;
    if (live.formatRetries > MAX_FORMAT_RETRIES) {
      await this.fail(live, { code: 'format', message: `Parseo de tool call inválido tras ${MAX_FORMAT_RETRIES} reintentos: ${errors.join('; ')}` });
      return true;
    }
    this.pushNudge(live, `Error de formato en la tool call: ${errors.join('; ')}. Reintento ${live.formatRetries}/${MAX_FORMAT_RETRIES}.`);
    return false;
  }

  // ── Cierre de run (doc 05 §2.14, doc 10 §5.6) ──────────────────────────

  private async finishCompleted(live: LiveRun): Promise<void> {
    if (live.mode === 'plan' && !this.deps.events.since(live.runId, 0).some((event) =>
      event.type === 'tasks.updated' && event.tasks.length > 0)) {
      await this.fail(live, {
        code: 'format',
        message: 'El modelo no produjo un plan con pasos concretos. No se guardaron tareas de este pedido. Podés volver a pedir el plan o elegir otro modelo.',
      });
      return;
    }
    this.transition(live, 'completed');
    await this.persistRunState(live);
    this.live.delete(live.runId);
  }

  private async finishWithText(live: LiveRun, text: string): Promise<void> {
    if (live.mode === 'plan' && !this.deps.events.since(live.runId, 0).some((event) => event.type === 'tasks.updated')) {
      const steps = planStepsFromText(text);
      if (steps.length > 0) {
        await this.deps.taskManager.update(live.chatId, live.runId, steps.map((step, ord) => ({
          ...step, id: `${live.chatId}:task:${ord}`, ord,
        })));
      }
    }
    await this.finishCompleted(live);
  }

  private async finishCancelled(live: LiveRun): Promise<void> {
    await this.synthesizeOpenToolMessages(live);
    if (live.state !== 'cancelling') { this.transition(live, 'cancelling'); await this.persistRunState(live); }
    this.transition(live, 'cancelled');
    await this.persistRunState(live);
    this.live.delete(live.runId);
  }

  private async fail(live: LiveRun, error: RunErrorShared): Promise<void> {
    await this.synthesizeOpenToolMessages(live);
    this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'run.error', error, recoverable: false });
    const to: RunState = live.state === 'cancelling' ? 'cancelled' : 'failed';
    this.transition(live, to);
    if (to === 'failed') await this.deps.runs.update(live.runId, { error });
    await this.persistRunState(live);
    this.live.delete(live.runId);
  }

  private async failUnexpected(live: LiveRun, err: unknown): Promise<void> {
    if (!this.live.has(live.runId)) return; // ya se cerró por otra vía
    await this.fail(live, { code: 'unknown', message: err instanceof Error ? err.message : String(err) });
  }

  private async synthesizeOpenToolMessages(live: LiveRun): Promise<void> {
    const openCalls = await this.deps.toolCalls.listByRun(live.runId);
    for (const call of openCalls) {
      if (call.status === 'pending' || call.status === 'approved' || call.status === 'awaiting_permission') {
        const updated: ToolCallRecord = { ...call, status: 'cancelled', finishedAt: this.deps.clock.now() };
        await this.deps.toolCalls.upsert(updated);
        this.emitToolStatus(live, call.id, 'cancelled');
        await this.deps.messages.append(live.chatId, synthesizeInterruptedResultMessage(updated, 'closed'));
      }
    }
  }

  // ── Helpers de transición / persistencia (doc 05 §1, doc 10 §2) ───────

  private transition(live: LiveRun, to: RunState): void {
    const from = live.state;
    if (from === to) return;
    this.stateMachine.assert(from, to);
    live.state = to;
    this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'run.state', from, to });
  }

  /** Doc 16 §4 ítem 7: `RUN_TRANSITIONS` ahora tiene la arista `parsing -> queued` (doc 05 §2.5
   *  pasos 23-25: reintento de parseo, "elegí una tool o llamá a finish", permiso denegado — todos
   *  vuelven a encolar el turno sin pasar por `executing_tool`), así que ya no hace falta el bypass
   *  que escribía el evento a mano: `transition()` valida y persiste igual que cualquier otra arista. */
  private returnToQueue(live: LiveRun): void {
    if (live.state === 'queued') return;
    this.transition(live, 'queued');
  }

  private async persistRunState(live: LiveRun): Promise<void> {
    await this.deps.runs.update(live.runId, {
      state: live.state, iteration: live.iteration, lastEventSeq: this.deps.events.lastSeq(live.runId),
      heartbeatAt: this.deps.clock.now(),
    });
  }

  private emitToolStatus(live: LiveRun, toolCallId: string, status: ToolCallRecord['status'], resultPreview?: string): void {
    this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'tool.status', toolCallId, status, resultPreview });
  }

  /** Punto 1d del encargo (feedback real v0.2.1): línea de estado simple ("¿qué está haciendo el
   *  agente ahora?"). Reusa RunEvent (@saurio/shared, commit de contrato) — puramente informativo
   *  para la UI, no mueve ningún estado real. */
  private emitActivity(live: LiveRun, phase: RunActivityPhase, label: string, toolCallId?: string): void {
    this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'run.activity', phase, label, toolCallId });
  }

  /** Mapea el nombre de una tool call a una fase de actividad + label en español. `undefined` para
   *  `finish`/`task_update`/`delegate` (tienen su propio punto de emisión más específico, o no
   *  ameritan una línea de estado propia). */
  private activityForTool(name: string, args: unknown): { phase: RunActivityPhase; label: string } | undefined {
    switch (name) {
      case 'read_file': {
        const p = (args as { path?: string } | undefined)?.path;
        return { phase: 'reading', label: p ? `Leyendo ${p}…` : 'Leyendo archivo…' };
      }
      case 'list_files': return { phase: 'reading', label: 'Explorando carpetas…' };
      case 'search_code': return { phase: 'searching', label: 'Buscando en el código…' };
      case 'write_file': case 'edit_file': case 'delete_file': case 'make_dir': {
        const p = (args as { path?: string; paths?: string[] } | undefined);
        const target = p?.path ?? p?.paths?.[0];
        return { phase: 'editing', label: target ? `Editando ${target}…` : 'Editando archivos…' };
      }
      case 'run_command': {
        const cmd = (args as { command?: string } | undefined)?.command;
        return { phase: 'running_command', label: cmd ? `Ejecutando: ${cmd}` : 'Ejecutando comando…' };
      }
      default: return undefined;
    }
  }

  private pushNudge(live: LiveRun, text: string): void {
    live.history.push({ id: this.deps.ids.next(), role: 'user', content: text, ephemeral: true });
  }

  /** Repo map del turno (doc 07 §2): se pide al indexer con el presupuesto de la ContextPolicy.
   *  Nunca hace fallar el run — si el indexer falla, se sigue con un repo map vacío. */
  private async buildRepoMap(live: LiveRun): Promise<{
    text: string;
    reason?: ContextInspectionInput['repoMapReason'];
  }> {
    if (!this.deps.repoMap) return { text: '', reason: 'not_configured' };
    try {
      const effectivePolicy = contextPolicyForNumCtx(live.effectiveConfig.numCtx, live.agent.contextPolicy);
      const { text } = await this.deps.repoMap.build(this.deps.projectRoot, {
        budgetTokens: effectivePolicy.repoMapTokens,
        mentioned: [],
        touched: [],
      });
      return text.trim().length > 0 ? { text } : { text: '', reason: 'empty' };
    } catch (error) {
      console.warn('[RunController] no se pudo construir el repo map; se sigue sin él', error);
      return { text: '', reason: 'build_failed' };
    }
  }

  /** Lee las instrucciones de raíz con el mismo WorkspaceFs confinado y limitado que usan las
   * tools. `not_found` es ausencia comprobada; cualquier otra falla se informa sin exponer paths ni
   * mensajes internos en el evento de contexto. */
  private async loadProjectInstructions(): Promise<{
    text?: string;
    reason?: ContextInspectionInput['projectMemoryReason'];
  }> {
    if (!this.deps.workspaceFs) return { reason: 'not_connected' };
    const classification = await this.classifyWorkspaceFile('SAURIO.md');
    if (classification === 'missing') return { reason: 'empty' };
    if (classification !== 'safe') {
      console.warn('[RunController] SAURIO.md no pasó la validación de confinamiento; se ignora');
      return { reason: 'build_failed' };
    }
    try {
      const { content } = await this.deps.workspaceFs.readFile('SAURIO.md');
      return content.trim().length > 0 ? { text: content } : { reason: 'empty' };
    } catch (error) {
      if (error instanceof ToolExecutionError && error.code === 'not_found') return { reason: 'empty' };
      console.warn('[RunController] no se pudo leer SAURIO.md; se sigue sin instrucciones de proyecto', error);
      return { reason: 'build_failed' };
    }
  }

  /** `toolTransport: 'auto'` (doc 04 §5): nativo salvo que `settings.toolTransportOverrides` diga
   *  otra cosa para ese modelo (coincidencia por prefijo del nombre, p. ej. "qwen2.5-coder"). */
  private resolveAutoTransport(modelName: string): ToolTransport {
    const overrides = this.deps.toolTransportOverrides ?? {};
    for (const [prefix, transport] of Object.entries(overrides)) {
      if (modelName.startsWith(prefix)) return transport;
    }
    return 'native';
  }

  private buildEffectiveConfig(
    agent: AgentConfig, mode: Mode, modelResolution?: ModelResolution,
  ): EffectiveConfig {
    const adjustments: Adjustment[] = [];
    const transport: EffectiveConfig['transport'] = agent.toolTransport === 'auto'
      ? this.resolveAutoTransport(agent.model.name)
      : agent.toolTransport;
    const think = agent.thinking === 'on';
    const tools = this.deps.tools.list({ names: agent.allowedTools, mode }).map((t) => t.name);
    return {
      model: agent.model, numCtx: agent.contextPolicy.numCtx, think, tools, transport,
      contextLimitSource: 'provisional',
      promptHash: agent.systemPromptHash, profileId: agent.profileId, adjustments,
      ...(modelResolution ? { modelResolution } : {}),
    };
  }

  /** Hallazgo #6: recibe el `{ apiTools, systemSuffix, stop }` completo de `protocol.renderTools()`
   *  (antes solo se propagaban `apiTools`/`systemSuffix`) y setea `options.stop`. Sin esto, el
   *  `stop: ['</tool_call>']` que `TextToolProtocol.renderTools` devuelve para el transporte 'text'
   *  se perdía: con qwen2.5-coder:7b (override medido a 'text') el modelo seguía generando después
   *  de `</tool_call>` y solía alucinar el `<tool_result>` del turno siguiente. */
  private buildChatRequest(
    live: LiveRun, messages: ChatMessage[],
    rendered: { apiTools?: JsonSchemaTool[]; systemSuffix?: string; stop?: string[] },
  ): ChatRequest {
    const withSuffix = rendered.systemSuffix
      ? messages.map((m) => (m.role === 'system' ? { ...m, content: `${m.content}\n${rendered.systemSuffix}` } : m))
      : messages;
    const effectivePolicy = contextPolicyForNumCtx(live.effectiveConfig.numCtx, live.agent.contextPolicy);
    return {
      model: live.effectiveConfig.model.name,
      messages: withSuffix,
      tools: live.effectiveConfig.transport === 'native' ? rendered.apiTools : undefined,
      options: {
        numCtx: live.effectiveConfig.numCtx,
        temperature: live.agent.temperature,
        numPredict: effectivePolicy.reserveForResponse,
        stop: rendered.stop,
        // Tarea "carga de modelo/oom_load": si un turno anterior de ESTE run ya tuvo que bajar
        // `numGpu` tras un oom_load, se repite en todos los turnos siguientes (el modelo no entra
        // más en la próxima llamada si no entró en esta) — ver LiveRun.numGpuOverride.
        numGpu: live.numGpuOverride,
      },
      think: live.effectiveConfig.think,
      keepAlive: '5m',
    };
  }
}

function buildPlaceholderConfig(agent: AgentConfig, modelResolution?: ModelResolution): EffectiveConfig {
  return {
    model: agent.model, numCtx: agent.contextPolicy.numCtx, think: false, tools: [],
    transport: 'native', promptHash: agent.systemPromptHash, adjustments: [], contextLimitSource: 'provisional',
    ...(modelResolution ? { modelResolution } : {}),
  };
}

function isResolvedModelSelection(
  value: ModelRef | { ref: ModelRef; resolution: ModelResolution },
): value is { ref: ModelRef; resolution: ModelResolution } {
  return 'ref' in value && 'resolution' in value;
}

/** Un resolver legado devuelve sólo ModelRef. Se registra procedencia únicamente cuando puede
 * deducirse sin adivinar qué rama automática eligió. */
function inferLegacyModelResolution(
  agent: AgentConfig, chatModelRef: ModelRef | undefined,
): ModelResolution | undefined {
  if (chatModelRef) return { source: 'chat_override' };
  if (agent.modelMode !== 'auto') return { source: 'agent_fixed' };
  return undefined;
}

function withCollaboratorPrompt(agent: AgentConfig, collaborators: AgentConfig[]): AgentConfig {
  const roster = collaborators.length === 0
    ? '- No hay colaboradores habilitados. Resolvé la tarea directamente y no uses delegate.'
    : collaborators.map((item) => `- ${item.name} — ${item.role} — ID: ${item.id}`).join('\n');
  const systemPrompt = `${agent.systemPrompt}\n\nColaboradores habilitados para este chat:\n${roster}\n` +
    'Si delegás, usá exactamente uno de esos IDs como targetAgentId. No inventes agentes ni delegues a otros perfiles.';
  return { ...agent, systemPrompt, systemPromptHash: hashSystemPrompt(systemPrompt) };
}

/** Doc 19 §2.5: el primer mensaje del chat hijo — le pide al worker que cierre con `finish` cuyo
 *  `summary` sea el JSON de `DelegationResultSchema` (así `buildDelegationResult` puede parsearlo
 *  directo, sin depender de que el modelo hable en el `content` plano del mensaje). */
function buildDelegationPrompt(args: DelegationRequest): string {
  return [
    `Tarea delegada: ${args.task}`,
    `Entregable esperado: ${args.expectedDeliverable}`,
    'Cuando termines (o si no podés completarla), llamá a la tool `finish` pasando como `summary` ' +
      'EXACTAMENTE un JSON (sin texto adicional antes o después) con esta forma: ' +
      '{"status":"completed"|"failed"|"needs_input","summary":"texto breve del resultado",' +
      '"artifacts":[{"path":"...","description":"..."}],"uncertainties":["..."],"nextAction":"..."} ' +
      '(los campos "artifacts"/"uncertainties"/"nextAction" son opcionales). ' +
      'El campo "summary" debe incluir el entregable concreto completo, no sólo decir que lo hiciste. ' +
      'Incluí un artifact únicamente si realmente creaste ese archivo dentro del proyecto y confirmaste que existe; no inventes paths.',
  ].join('\n\n');
}

function mapProviderErrorCode(code: string): RunErrorShared['code'] {
  switch (code) {
    case 'oom_load': return 'oom_load';
    case 'oom_generate': return 'oom_generate';
    case 'connection_refused': return 'provider_down';
    case 'stream_cut': return 'provider_lost';
    case 'server_busy': return 'server_busy';
    case 'timeout': return 'timeout';
    case 'no_tools_support': return 'format';
    case 'context_too_large': return 'context_overflow';
    default: return 'unknown';
  }
}

function previewOf(result: ToolResult): string | undefined {
  const text = result.content.find((c) => c.type === 'text');
  return text && text.type === 'text' ? text.text.slice(0, 500) : undefined;
}

/** Texto completo (sin truncar a 500 chars como `previewOf`) del primer content de tipo texto — se
 *  usa para comparar identidad de error (doc 16 §4, "robustez con modelos chicos"), no para mostrar. */
function errorTextOf(result: ToolResult): string | undefined {
  const text = result.content.find((c) => c.type === 'text');
  return text && text.type === 'text' ? text.text : undefined;
}

/** Agrega una pista concreta al ToolResult (no solo el error crudo) cuando la MISMA tool ya falló con
 *  el mismo texto de error `repeatCount` veces seguidas en este run (doc 16 §4). Se anexa al primer
 *  content de texto en vez de reemplazarlo: el modelo sigue viendo el error real, más la instrucción
 *  de qué hacer distinto. */
function withRepeatedErrorHint(result: ToolResult, toolName: string, repeatCount: number): ToolResult {
  const idx = result.content.findIndex((c) => c.type === 'text');
  if (idx === -1) return result;
  const original = result.content[idx];
  if (!original || original.type !== 'text') return result;
  const hint = `\n\n[pista: "${toolName}" ya falló con este mismo error ${repeatCount} veces seguidas en este run — repetir la misma llamada no lo va a resolver; cambiá algo concreto (los argumentos, la ruta, o releé el archivo con read_file) antes de volver a intentarlo]`;
  const content = [...result.content];
  content[idx] = { ...original, text: original.text + hint };
  return { ...result, content };
}

/** `ToolContext.fs` no es responsabilidad de este módulo (WorkspaceFs vive en packages/runtime/src/
 *  tools/, fuera de agent/ + tasks/); este stub solo existe para que el tipo cierre cuando
 *  `RunControllerDeps.workspaceFs` no se provee — ver deviations en la salida estructurada. */
function unavailableWorkspaceFs(): WorkspaceFs {
  const fail = (): never => { throw new Error('WorkspaceFs no inyectado en RunControllerDeps (fuera del alcance de packages/runtime/src/agent).'); };
  return {
    readFile: async () => fail(), writeFileAtomic: async () => fail(), deleteFile: async () => fail(),
    makeDir: async () => fail(),
    listDir: async () => fail(), isProtected: () => false, isIgnored: () => false, resolve: (p: string) => p,
  };
}

function noopCheckpointHandle(): CheckpointHandle {
  return { checkpointId: '', before: async () => {}, after: async () => {} };
}

/** Último recurso para `resumeAfterRestart` (doc 10 §5.2): si por algún motivo el evento
 *  `tool.permission` original no está en `run_events` (no debería pasar — se persiste siempre antes
 *  de entrar en `awaiting_permission`), se arma un `PermissionRequest` mínimo a partir de lo que sí
 *  quedó en `tool_calls` para no bloquear la reanudación. `rememberOptions: []` porque sin el
 *  `suggestedPattern` original no hay un patrón razonable que ofrecer para "permitir siempre". */
function buildFallbackPermissionRequest(toolCallId: string, toolName: string, classification: ToolClassification): PermissionRequest {
  return {
    toolCallId, toolName, category: classification.category, risk: classification.risk,
    summary: classification.summary, triggeredBy: 'reanudado tras reinicio (evento tool.permission no encontrado)',
    preview: { command: classification.command, paths: classification.paths },
    rememberOptions: [],
  };
}
