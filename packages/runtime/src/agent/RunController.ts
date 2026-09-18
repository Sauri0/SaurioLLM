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
  RunError as RunErrorShared, ResponseMetrics, ToolTransport,
} from '@saurio/shared';
import type { ModelGateway, ChatRequest, JsonSchemaTool } from '../gateway/types.js';
import type {
  ToolRegistry, ToolProtocol, ToolDefinition, ToolContext, CheckpointHandle, ToolClassification,
  WorkspaceFs,
} from '../tools/types.js';
import type { PermissionEngine } from '../permissions/types.js';
import type { PermissionMemory } from '../permissions/memory.js';
import type { CheckpointService } from '../checkpoint/types.js';
import type { ContextBuilder, RepoMapClient, CompactionResult } from '../context/types.js';
import type {
  EventStore, ChatRepository, MessageRepository, ToolCallRepository, CheckpointRepository,
} from '../persistence/types.js';
import type { TaskManager } from '../tasks/types.js';
import type {
  AgentConfig, EffectiveConfig, RunController as RunControllerContract, ToolCallRecord, Adjustment,
} from './types.js';
import type {
  RunRepository, AgentConfigResolver, Clock, IdGenerator, OrphanDiagnostics, ModelContextProbe,
  LastReadHashes,
} from './ports.js';
import { RunStateMachine } from './RunStateMachine.js';
import { LoopDetector } from './LoopDetector.js';
import { DegenerationDetector } from './DegenerationDetector.js';
import { MessageDeltaBatcher } from './deltaBatcher.js';
import { hashArgs } from './hash.js';
import { recover as recoverRuns, synthesizeInterruptedResultMessage, type RecoverResult } from './recover.js';

const MUTATING_ERROR_RETRY_CODES = new Set(['connection_refused', 'stream_cut']);
const BUSY_RETRY_CODE = 'server_busy';
const MAX_FORMAT_RETRIES = 2;
/** Doc 09 §2.3: únicas tools con `mutating: true` sobre el filesystem en el MVP — las únicas cuyo
 *  `tool_calls.expected_pre_hash` importa (doc 10 §3, ítem 16 de doc 16 §4). */
const MUTATING_FILE_TOOLS = new Set(['edit_file', 'write_file', 'delete_file']);
/** Estados desde los que RUN_TRANSITIONS permite -> cancelling (doc 10 §2; `compacting` se agregó
 *  en esta tarea, ver nota de cabecera del archivo). */
const CANCELLABLE_STATES = new Set<RunState>(['queued', 'generating', 'parsing', 'awaiting_permission', 'executing_tool', 'compacting']);

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
  /** Resuelve cuando llega `answerPermission` para el toolCallId pendiente. */
  pendingPermission?: { toolCallId: string; resolve: (answer: PermissionAnswer) => void };
  cancelRequested: boolean;
  formatRetries: number;
  /** Paths ya escritos/borrados por este run (hallazgo #1/#4): se pasa a `PermissionEngine.evaluate`
   *  como `touchedPaths` para que `isBlockedByDefault` pueda excusar un `git reset --hard`/`checkout`
   *  sobre algo que el run mismo tocó (doc 06 §5). Se completa en `runHandler` tras cada tool mutante
   *  que declare `classification.paths` y termine sin error. */
  touchedPaths: Set<string>;
  /** Turnos transcurridos desde la última compactación (doc 07 §7.1 punto 2, doc 16 §4 ítem 5);
   *  se resetea a 0 cada vez que `ContextBuilder.build` compacta. */
  turnsSinceCompaction: number;
}

type TurnOutcome = 'continue' | 'completed' | 'failed' | 'cancelled';

export class RunController implements RunControllerContract {
  private readonly live = new Map<string, LiveRun>();
  private readonly stateMachine = new RunStateMachine();

  constructor(private readonly deps: RunControllerDeps) {}

  // ── API pública (doc 04 §5) ────────────────────────────────────────────

  async start(chatId: string, text: string, mode: Mode): Promise<{ runId: string }> {
    const chat = await this.deps.chats.get(chatId);
    if (!chat) throw new Error(`Chat inexistente: ${chatId}`);

    const activeRuns = await this.deps.runs.listActive();
    if (activeRuns.some((r) => r.chatId === chatId)) {
      throw new Error(`El chat ${chatId} ya tiene un run activo (un chat = un run a la vez, doc 05 §2.1)`);
    }

    const resolvedAgent = await this.deps.agents.resolve(chat.agentId);
    // El modelo efectivo del run sale del chat cuando el chat tiene uno elegido (doc 03 §4.1
    // `chats.model_ref_json`); si no, del agente. Antes de la integración el chat.modelRef se perdía.
    const withModel: AgentConfig = chat.modelRef ? { ...resolvedAgent, model: chat.modelRef } : resolvedAgent;
    const agent = await this.withPersistedRules(withModel);
    const runId = this.deps.ids.next();

    await this.deps.runs.create({
      id: runId, chatId, agentId: agent.id, mode, state: 'created', iteration: 0,
      lastEventSeq: 0, createdAt: this.deps.clock.now(), ownerSessionId: 'local', heartbeatAt: this.deps.clock.now(),
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
    const userMessage: ChatMessage = { id: this.deps.ids.next(), role: 'user', content: text };
    this.deps.events.append({
      runId, chatId, ts: this.deps.clock.now(), type: 'message.done',
      message: userMessage, metrics: { quality: 'unavailable' },
    });

    const live: LiveRun = {
      runId, chatId, agent, mode, effectiveConfig: buildPlaceholderConfig(agent),
      iteration: 0, state: 'created', abort: new AbortController(),
      loopDetector: new LoopDetector(), history: await this.deps.messages.listByChat(chatId),
      cancelRequested: false, formatRetries: 0, touchedPaths: new Set(), turnsSinceCompaction: 0,
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

  async continueRun(runId: string, extraIterations?: number): Promise<{ runId: string }> {
    const prev = await this.deps.runs.get(runId);
    if (!prev) throw new Error(`Run inexistente: ${runId}`);
    const baseAgent = await this.deps.agents.resolve(prev.agentId);
    const withModel: AgentConfig = {
      ...baseAgent,
      // El run nuevo hereda el modelo efectivo del run anterior (doc 05 §2.10 "run:continue crea un
      // run nuevo"): el usuario no volvió a elegir modelo entre uno y otro.
      ...(prev.effectiveConfig ? { model: prev.effectiveConfig.model } : {}),
      maxIterations: baseAgent.maxIterations + (extraIterations ?? 0),
    };
    const agent = await this.withPersistedRules(withModel);

    const newRunId = this.deps.ids.next();
    await this.deps.runs.create({
      id: newRunId, chatId: prev.chatId, agentId: agent.id, mode: prev.mode, state: 'created',
      iteration: 0, lastEventSeq: 0, createdAt: this.deps.clock.now(),
      ownerSessionId: 'local', heartbeatAt: this.deps.clock.now(), parentRunId: prev.parentRunId,
    });

    const live: LiveRun = {
      runId: newRunId, chatId: prev.chatId, agent, mode: prev.mode,
      effectiveConfig: buildPlaceholderConfig(agent), iteration: 0, state: 'created',
      abort: new AbortController(), loopDetector: new LoopDetector(),
      history: await this.deps.messages.listByChat(prev.chatId),
      cancelRequested: false, formatRetries: 0, touchedPaths: new Set(), turnsSinceCompaction: 0,
    };
    this.live.set(newRunId, live);
    await this.prepareAndQueue(live);

    void this.runLoop(live).catch((err) => this.failUnexpected(live, err));
    return { runId: newRunId };
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
    if (this.tryResolvePending(toolCallId, answer)) return;

    // Doc 16 §4 ítem 2 ("reanudar tras reinicio", doc 10 §5.2): no vive en `this.live` de este
    // proceso — puede ser un run que quedó en `awaiting_permission` antes de cerrar la app. Se
    // rehidrata desde `run_events`/`tool_calls` (sin re-ejecutar nada que ya corrió) y se reintenta
    // una vez. Esto mantiene sin cambios el contrato IPC `permission:answer` (apps/desktop no
    // necesita saber que el run se rehidrató).
    const record = await this.deps.toolCalls.get(toolCallId);
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
    if (this.live.has(runId)) return true;
    const run = await this.deps.runs.get(runId);
    if (!run || run.state !== 'awaiting_permission') return false;

    const calls = await this.deps.toolCalls.listByRun(runId);
    const pendingRecord = calls.find((c) => c.status === 'awaiting_permission');
    if (!pendingRecord) return false;

    const baseAgent = await this.deps.agents.resolve(run.agentId);
    const agent = await this.withPersistedRules(
      run.effectiveConfig ? { ...baseAgent, model: run.effectiveConfig.model } : baseAgent,
    );
    const effectiveConfig = run.effectiveConfig ?? buildPlaceholderConfig(agent);
    const history = await this.deps.messages.listByChat(run.chatId);

    const live: LiveRun = {
      runId, chatId: run.chatId, agent, mode: run.mode, effectiveConfig,
      iteration: run.iteration, state: 'awaiting_permission', abort: new AbortController(),
      loopDetector: new LoopDetector(), history, cancelRequested: false, formatRetries: 0,
      // Doc 10 §5.2 nota: la comparación de conflicto ya no depende de esto (usa
      // `tool_calls.expected_pre_hash`, persistido); se deja vacío como límite conocido documentado
      // — un `git reset`/`checkout` sobre un path tocado antes del reinicio no se reconoce como
      // "tocado por este run" tras rehidratar.
      touchedPaths: new Set(), turnsSinceCompaction: 0,
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

  // ── Preparación (doc 05 §2.2) ───────────────────────────────────────────

  private async prepareAndQueue(live: LiveRun): Promise<void> {
    // No se emite run.state para el pseudo-edge [*] -> created (doc 05 §1): solo created -> preparing
    // en adelante tiene un `from: RunState` real.
    this.transition(live, 'preparing');
    await this.persistRunState(live);

    const effectiveConfig = this.buildEffectiveConfig(live.agent, live.mode);
    await this.applyNumCtxOverride(effectiveConfig);
    await this.capNumCtxAgainstModel(live, effectiveConfig);
    live.effectiveConfig = effectiveConfig;
    for (const adj of effectiveConfig.adjustments) {
      this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'run.adjustment', adjustment: adj });
    }
    await this.deps.runs.update(live.runId, { effectiveConfig });

    this.transition(live, 'queued');
    await this.persistRunState(live);
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
    if (!this.deps.modelContextProbe) return;
    let contextMax: number | undefined;
    try {
      contextMax = await this.deps.modelContextProbe.getContextMax(effectiveConfig.model);
    } catch (err) {
      console.warn('[RunController] no se pudo consultar contextMax del modelo; no se capea numCtx', err);
      return;
    }
    if (contextMax === undefined || contextMax >= effectiveConfig.numCtx) return;
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
      const repoMapText = await this.buildRepoMap(live);
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
        agent: live.agent, mode: live.mode, history: live.history, repoMap: repoMapText,
        toolsText, turnsSinceCompaction: live.turnsSinceCompaction,
        allowCompaction: live.formatRetries === 0,
      };
      const willCompact = this.deps.context.willCompact(buildInput);
      if (willCompact) {
        this.transition(live, 'compacting');
        await this.persistRunState(live);
      }

      const built = await this.deps.context.build(buildInput);
      if (live.cancelRequested) { await this.finishCancelled(live); return; }

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

      this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'context.built', budget: built.report });
      if (!built.report.fits) {
        await this.fail(live, { code: 'context_overflow', message: 'El contexto no entra ni tras compactar (doc 05 §2.3 paso 12).' });
        return;
      }

      const request = this.buildChatRequest(live, built.messages, rendered);

      if (live.cancelRequested) { await this.finishCancelled(live); return; }
      this.transition(live, 'generating');
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
      // Doc 07 §7.1 ("nunca dispara durante un reintento de formato"): sin resetear esto tras un
      // parseo exitoso, `live.formatRetries` quedaba en >0 para siempre tras el primer error de
      // formato del run (nunca se reseteaba), lo cual habría bloqueado la compactación en todos los
      // turnos siguientes si se hubiera usado como guarda — se resetea acá para que el contador
      // siga significando "reintentos del turno actual", no "hubo algún reintento en el run".
      live.formatRetries = 0;

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
        { runId: live.runId, signal: live.abort.signal, authorizedLocality: [live.effectiveConfig.model.locality], priority: 'interactive' },
      )) {
        if (live.cancelRequested) { deltaBatcher.flush(); return 'cancelled'; }

        if (chunk.type === 'content') {
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
          return this.retryOrFail(live, chunk.code ?? 'unknown', chunk.message);
        } else if (chunk.type === 'done') {
          // El contenido/thinking pendiente del batcher tiene que llegar a `run_events` ANTES que
          // `message.done` (mismo orden que antes de este cambio: todo el streaming, después el
          // cierre del turno) — de lo contrario un cliente que solo escucha eventos en vivo vería
          // `message.done` sin haber recibido el texto completo en `message.delta`.
          deltaBatcher.flush();
          const assistantMessage: ChatMessage = {
            id: assistantMessageId, role: 'assistant', content, thinking: thinking || undefined,
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
      return this.retryOrFail(live, 'stream_cut', 'El stream terminó sin un chunk done.');
    } catch (err) {
      deltaBatcher.flush();
      if (live.cancelRequested || live.abort.signal.aborted) return 'cancelled';
      await this.persistTruncatedMessage(live, assistantMessageId, content, thinking);
      return this.retryOrFail(live, 'stream_cut', err instanceof Error ? err.message : String(err));
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
        id, role: 'assistant', content, thinking: thinking || undefined, truncated: true,
        modelRef: live.effectiveConfig.model,
      });
    } catch (err) {
      console.warn('[RunController] no se pudo persistir el mensaje truncado (doc 10 caso 3)', err);
    }
  }

  private async retryOrFail(live: LiveRun, code: string, message: string): Promise<'retry' | 'failed'> {
    const verdict = live.loopDetector.recordError(code);
    if (verdict === 'nudge') this.pushNudge(live, `Reintento tras error ${code}: probá un enfoque distinto si vuelve a pasar.`);
    if (MUTATING_ERROR_RETRY_CODES.has(code)) { await this.delay(2000); return 'retry'; }
    if (code === BUSY_RETRY_CODE) { await this.delay(3000); return 'retry'; }
    await this.fail(live, { code: mapProviderErrorCode(code), message });
    return 'failed';
  }

  private delay(ms: number): Promise<void> {
    return (this.deps.delay ?? ((n: number) => new Promise<void>((resolve) => setTimeout(resolve, n))))(ms);
  }

  // ── finish (doc 05 §2.5 "alt finish() o respuesta final") ─────────────

  private async runFinish(live: LiveRun, protocol: ToolProtocol, call: ToolCall): Promise<void> {
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

  private async handleToolCalls(live: LiveRun, calls: ToolCall[], text: string): Promise<TurnOutcome> {
    if (calls.length === 0) {
      const verdict = live.loopDetector.recordNoToolTurn();
      if (verdict === 'force_final') { await this.finishWithText(live, text || '(sin respuesta)'); return 'completed'; }
      this.pushNudge(live, 'Elegí una tool o llamá a finish.');
      this.returnToQueue(live);
      await this.persistRunState(live);
      return 'continue';
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
      this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'tool.permission', request: decision.request });
      this.transition(live, 'awaiting_permission');
      await this.persistRunState(live);

      const answer = await new Promise<PermissionAnswer>((resolve) => {
        live.pendingPermission = { toolCallId: call.id, resolve };
      });
      if (live.cancelRequested) return 'cancelled';

      return this.afterPermissionAnswered(live, call, record, classification, decision.request, answer);
    }

    this.transition(live, 'executing_tool');
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
      this.deps.events.append({ runId: live.runId, chatId: live.chatId, ts: this.deps.clock.now(), type: 'checkpoint.created', checkpoint });
      record = { ...record, checkpointId: checkpoint.id };
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
    this.transition(live, 'completed');
    await this.persistRunState(live);
    this.live.delete(live.runId);
  }

  private async finishWithText(live: LiveRun, _text: string): Promise<void> {
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

  private pushNudge(live: LiveRun, text: string): void {
    live.history.push({ id: this.deps.ids.next(), role: 'user', content: text, ephemeral: true });
  }

  /** Repo map del turno (doc 07 §2): se pide al indexer con el presupuesto de la ContextPolicy.
   *  Nunca hace fallar el run — si el indexer falla, se sigue con un repo map vacío. */
  private async buildRepoMap(live: LiveRun): Promise<string> {
    if (!this.deps.repoMap) return '';
    try {
      const { text } = await this.deps.repoMap.build(this.deps.projectRoot, {
        budgetTokens: live.agent.contextPolicy.repoMapTokens,
        mentioned: [],
        touched: [],
      });
      return text;
    } catch (error) {
      console.warn('[RunController] no se pudo construir el repo map; se sigue sin él', error);
      return '';
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

  private buildEffectiveConfig(agent: AgentConfig, mode: Mode): EffectiveConfig {
    const adjustments: Adjustment[] = [];
    const transport: EffectiveConfig['transport'] = agent.toolTransport === 'auto'
      ? this.resolveAutoTransport(agent.model.name)
      : agent.toolTransport;
    const think = agent.thinking === 'on';
    const tools = this.deps.tools.list({ names: agent.allowedTools, mode }).map((t) => t.name);
    return {
      model: agent.model, numCtx: agent.contextPolicy.numCtx, think, tools, transport,
      promptHash: agent.systemPromptHash, profileId: agent.profileId, adjustments,
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
    return {
      model: live.effectiveConfig.model.name,
      messages: withSuffix,
      tools: live.effectiveConfig.transport === 'native' ? rendered.apiTools : undefined,
      options: {
        numCtx: live.effectiveConfig.numCtx,
        temperature: live.agent.temperature,
        numPredict: live.agent.contextPolicy.reserveForResponse,
        stop: rendered.stop,
      },
      think: live.effectiveConfig.think,
      keepAlive: '5m',
    };
  }
}

function buildPlaceholderConfig(agent: AgentConfig): EffectiveConfig {
  return {
    model: agent.model, numCtx: agent.contextPolicy.numCtx, think: false, tools: [],
    transport: 'native', promptHash: agent.systemPromptHash, adjustments: [],
  };
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
