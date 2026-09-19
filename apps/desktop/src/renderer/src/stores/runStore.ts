// runStore: reduce RunEvent (doc 04 §6, doc 05 flujo de ejecución, doc 01 §4.1 "runStore reduce
// RunEvent") — apps/desktop/src/renderer/src/stores/runStore.ts.
// Único slice que consume el stream `runtime:event` (batched 30 ms, doc 01 §6); todo lo demás en
// el renderer es derivado de acá o de `chat:history` (doc 01 §4.1 "todo derivado, reconstruible").
import { create } from 'zustand';
import type {
  Adjustment, ChatMessage, Checkpoint, ModelRef, PermissionRequest, ResponseMetrics, RunError, Task,
  ToolCallRecord,
} from '@saurio/shared';
import type { ContextBudgetReport, RunActivityPhase, RunEvent, RunState } from '@saurio/shared';

/** Última "línea viva" conocida de un run (`run.activity`, contrato aditivo del feedback real
 *  v0.2.1 punto 1d: "el agente ya la calcula del lado del runtime — Leyendo X, Ejecutando Y..." —
 *  antes esto no existía y la UI no tenía de dónde sacar una sola línea de estado sin traducir
 *  RunState/tool.status a mano). `ActivityBlock` (features/chat) la usa para la línea plegada. */
export interface RunActivity {
  phase: RunActivityPhase;
  label: string;
  toolCallId: string | undefined;
  ts: number;
}

/** Aviso "modelo chico para modo Agente" (`run.smallModelWarning`, feedback real v0.2.1 punto 10):
 *  guardado por run porque el runtime lo emite una sola vez por run, no repetido en cada iteración. */
export interface SmallModelWarning {
  modelRef: ModelRef;
  parameterSize: string | undefined;
}

/** Estado de un run interrumpido (doc 05 §1 `run.recovered`): tool calls que quedaron
 *  `running -> orphaned` o `pending/approved -> abandoned` cuando la app se reinició a mitad de
 *  ejecución. La tarjeta de "run interrumpido" (doc 05 §1 nota `awaiting_permission`, doc 10) usa
 *  esto para ofrecer "reanudar" (`run:continue`, doc 04 §16). */
export interface InterruptedInfo {
  runId: string;
  chatId: string;
  orphaned: ToolCallRecord[];
  abandoned: ToolCallRecord[];
}

/** Mensaje en construcción por streaming (`message.delta`, doc 04 §6): el contenido y el
 *  `thinking` colapsable (doc 01 §4.1, feature chat) se van concatenando hasta `message.done`. */
export interface StreamingMessage {
  id: string;
  chatId: string;
  runId: string;
  content: string;
  thinking: string;
}

export interface RunStoreState {
  /** Estado de máquina de cada run (doc 05 §1), por `runId`. */
  runStates: Record<string, RunState>;
  /** `ts` (evento) del primer `run.state` visto de cada run — ver `reduceRunEvent`, "Cargando
   *  modelo… mm:ss" (tarea "carga de modelo/oom_load"). No se borra en `clearChat` a propósito: es
   *  información liviana y un run viejo no vuelve a usarse como referencia de tiempo activo. */
  runStartedAt: Record<string, number>;
  /** `chatId` de cada run visto (para poder derivar qué chat corresponde a un runId suelto). */
  runChatIds: Record<string, string>;
  /** Mensajes ya cerrados (`message.done`) por chat, en orden de llegada. */
  messagesByChat: Record<string, ChatMessage[]>;
  /** Métricas por mensaje (`ResponseMetrics`, doc 14 §5 "por respuesta"), para la fila bajo cada
   *  mensaje (tokens, tok/s, carga, cache — cada uno con su `quality`). */
  metricsByMessage: Record<string, ResponseMetrics>;
  /** Mensaje assistant en curso de streaming, por `messageId`. */
  streaming: Record<string, StreamingMessage>;
  /** Tool calls registradas (`tool.registered`/`tool.status`), por `toolCallId`. */
  toolCalls: Record<string, ToolCallRecord>;
  /** Tool calls agrupadas por run, en orden de aparición (para pintar las tarjetas en el chat). */
  toolCallOrderByRun: Record<string, string[]>;
  /** Solicitudes de permiso pendientes (bloqueantes, doc 06 §8), por `toolCallId`; se borran al
   *  llegar `tool.decision` para ese `toolCallId`. */
  pendingPermissions: Record<string, PermissionRequest>;
  /** Checkpoints creados (doc 04 §9), por chat, en orden. */
  checkpointsByChat: Record<string, Checkpoint[]>;
  /** Checklist de tasks vigente por chat (`tasks.updated` reemplaza el array completo). */
  tasksByChat: Record<string, Task[]>;
  /** Ajustes automáticos (`run.adjustment`, doc 04 §5 — en el MVP, solo capear `num_ctx`). */
  adjustmentsByRun: Record<string, Adjustment[]>;
  /** Errores de run (`run.error`). */
  errorsByRun: Record<string, RunError[]>;
  /** Runs interrumpidos detectados por `run.recovered`, por `runId`. */
  interrupted: Record<string, InterruptedInfo>;
  /** Último `seq` de evento aplicado, por run (para detectar huecos/duplicados si hiciera falta). */
  lastSeqByRun: Record<string, number>;
  /** Doc 19 §2.6 (E3a delegación): runs hijo creados por `delegate`, por run PADRE (`run.delegated`).
   *  `DelegationCard` los usa para saber a qué `childRunId`/`childChatId` corresponde una tool call
   *  de categoría `delegate`. */
  childRunsByParent: Record<string, string[]>;
  /** `childChatId` de cada `childRunId` visto en `run.delegated` — `DelegationCard` lo necesita para
   *  el link "ver conversación completa" sin escanear el stream de eventos del hijo. */
  childChatIdByRun: Record<string, string>;
  /** Última `run.activity` de cada run — línea viva del bloque "Actividad" (rediseño del chat,
   *  feedback real v0.2.1: "una sola línea plegable que va contando qué hace"). */
  activityByRun: Record<string, RunActivity>;
  /** `run.smallModelWarning` visto por run — un único aviso no bloqueante por run (punto 6 del
   *  rediseño), nunca repetido aunque el runtime lo reemita en cada iteración de ese mismo run. */
  smallModelWarningByRun: Record<string, SmallModelWarning>;
  /** Último `context.built` por CHAT — `effectiveNumCtx` es el numCtx REAL (rediseño del chat,
   *  punto 1: "indicador de contexto REAL, nunca el máximo teórico del modelo"). */
  contextBudgetByChat: Record<string, ContextBudgetReport>;

  applyEvents: (events: RunEvent[]) => void;
  clearChat: (chatId: string) => void;
  dismissInterrupted: (runId: string) => void;
  /** Punto 5 del encargo ("reanudar permisos pendientes tras reinicio — tarjeta de permiso
   *  rehidratada"): siembra `pendingPermissions`/`runChatIds`/`runStates`/`toolCalls` a partir de
   *  `permission:pending` (RunController.pendingPermissionRequests(), cambio aditivo de esta tarea en
   *  packages/runtime), sin esperar a que llegue un evento en vivo — que nunca llega solo tras un
   *  reinicio real (doc 10 §5.2, `resumeAfterRestart` recién corre cuando el usuario responde). El
   *  `ToolCallRecord` sintetizado acá es mínimo (solo lo que el propio store necesita para el filtro
   *  "¿es de este run activo?", `PermissionCard` en sí solo usa `request`): campos que
   *  `PermissionRequest` no trae (`args`/`argsHash`/`iteration`/`transport`) quedan con un valor
   *  placeholder documentado, nunca inventados como si fueran reales.
   */
  hydratePendingPermissions: (pending: { runId: string; chatId: string; request: PermissionRequest }[]) => void;
}

function upsertToolCallOrder(order: string[], toolCallId: string): string[] {
  return order.includes(toolCallId) ? order : [...order, toolCallId];
}

/** Reducer puro de un único `RunEvent` sobre el estado del slice; separado de `applyEvents` para
 *  poder testearlo sin zustand (ver runStore.test.ts). */
export function reduceRunEvent(state: RunStoreState, event: RunEvent): RunStoreState {
  const runChatIds = { ...state.runChatIds, [event.runId]: event.chatId };

  switch (event.type) {
    case 'run.state': {
      // Tarea "carga de modelo/oom_load", punto "Cargando modelo… mm:ss": se guarda cuándo empezó
      // ESTE run (primer `run.state` que se ve de él) para poder mostrar un cronómetro mientras no
      // llegó ningún `message.delta` todavía — Ollama puede tardar bastante en cargar el modelo antes
      // de emitir el primer token, y para el usuario eso se ve igual que "generando" sin indicación
      // de por qué tarda. No se pisa si ya existía (mismo run, vuelta siguiente del loop).
      const runStartedAt = state.runStartedAt[event.runId] !== undefined
        ? state.runStartedAt
        : { ...state.runStartedAt, [event.runId]: event.ts };
      return {
        ...state,
        runChatIds,
        runStartedAt,
        runStates: { ...state.runStates, [event.runId]: event.to },
      };
    }
    case 'context.built':
      // Rediseño del chat, punto 1 ("indicador de contexto REAL — effectiveNumCtx, nunca el máximo
      // teórico del modelo"): antes el compositor mostraba `activeModelInfo.contextMax` (el máximo
      // que DECLARA el modelo, p.ej. 262k), no el numCtx real que de verdad se le manda al provider
      // tras aplicar el cap (`defaultNumCtxFor`, ver comentario de `effectiveNumCtx` en
      // packages/shared/src/events.ts). Se guarda por CHAT (no por run) para que el compositor lo
      // siga mostrando entre un run y el siguiente, sin volver a mostrar el máximo teórico mientras
      // tanto.
      return { ...state, runChatIds, contextBudgetByChat: { ...state.contextBudgetByChat, [event.chatId]: event.budget } };
    case 'context.usage':
    case 'context.compacted':
      // El MVP muestra el resultado agregado bajo el mensaje (métricas), no cada evento de
      // contexto en vivo; se reconoce el evento para no romper el discriminated union pero no
      // agrega estado propio todavía (doc 14 §6, franja de runtime es responsabilidad de perfStore).
      return { ...state, runChatIds };
    case 'message.delta': {
      const prev = state.streaming[event.messageId];
      const base: StreamingMessage = prev ?? {
        id: event.messageId, chatId: event.chatId, runId: event.runId, content: '', thinking: '',
      };
      const next: StreamingMessage = event.field === 'thinking'
        ? { ...base, thinking: base.thinking + event.text }
        : { ...base, content: base.content + event.text };
      return {
        ...state,
        runChatIds,
        streaming: { ...state.streaming, [event.messageId]: next },
      };
    }
    case 'message.done': {
      const { [event.message.id]: _removed, ...restStreaming } = state.streaming;
      const chatMessages = state.messagesByChat[event.chatId] ?? [];
      const alreadyPresent = chatMessages.some((m) => m.id === event.message.id);
      const nextMessages = alreadyPresent
        ? chatMessages.map((m) => (m.id === event.message.id ? event.message : m))
        : [...chatMessages, event.message];
      return {
        ...state,
        runChatIds,
        streaming: restStreaming,
        messagesByChat: { ...state.messagesByChat, [event.chatId]: nextMessages },
        metricsByMessage: { ...state.metricsByMessage, [event.message.id]: event.metrics },
      };
    }
    case 'tool.registered': {
      const order = state.toolCallOrderByRun[event.runId] ?? [];
      return {
        ...state,
        runChatIds,
        toolCalls: { ...state.toolCalls, [event.call.id]: event.call },
        toolCallOrderByRun: { ...state.toolCallOrderByRun, [event.runId]: upsertToolCallOrder(order, event.call.id) },
      };
    }
    case 'tool.permission': {
      return {
        ...state,
        runChatIds,
        pendingPermissions: { ...state.pendingPermissions, [event.request.toolCallId]: event.request },
      };
    }
    case 'tool.decision': {
      const { [event.toolCallId]: _dropped, ...restPending } = state.pendingPermissions;
      return { ...state, runChatIds, pendingPermissions: restPending };
    }
    case 'tool.status': {
      const existing = state.toolCalls[event.toolCallId];
      if (!existing) {
        return { ...state, runChatIds };
      }
      const updated: ToolCallRecord = {
        ...existing,
        status: event.status,
        resultPreview: event.resultPreview ?? existing.resultPreview,
      };
      return { ...state, runChatIds, toolCalls: { ...state.toolCalls, [event.toolCallId]: updated } };
    }
    case 'tool.progress':
      // Salida en vivo de run_command (doc 04 §6); el MVP no acumula el stream de progreso en el
      // store (el resultado final llega por tool.status -> resultPreview); ver deviations.
      return { ...state, runChatIds };
    case 'checkpoint.created': {
      const list = state.checkpointsByChat[event.chatId] ?? [];
      return {
        ...state,
        runChatIds,
        checkpointsByChat: { ...state.checkpointsByChat, [event.chatId]: [...list, event.checkpoint] },
      };
    }
    case 'checkpoint.reverted':
      // El revert crea a su vez un checkpoint (doc 04 §9); ese llega como otro `checkpoint.created`
      // — acá no hay estado propio que mantener aparte de eso.
      return { ...state, runChatIds };
    case 'tasks.updated': {
      return { ...state, runChatIds, tasksByChat: { ...state.tasksByChat, [event.chatId]: event.tasks } };
    }
    case 'run.adjustment': {
      const list = state.adjustmentsByRun[event.runId] ?? [];
      return { ...state, runChatIds, adjustmentsByRun: { ...state.adjustmentsByRun, [event.runId]: [...list, event.adjustment] } };
    }
    case 'run.error': {
      const list = state.errorsByRun[event.runId] ?? [];
      return { ...state, runChatIds, errorsByRun: { ...state.errorsByRun, [event.runId]: [...list, event.error] } };
    }
    case 'run.recovered': {
      const info: InterruptedInfo = {
        runId: event.runId, chatId: event.chatId, orphaned: event.orphaned, abandoned: event.abandoned,
      };
      return { ...state, runChatIds, interrupted: { ...state.interrupted, [event.runId]: info } };
    }
    case 'run.activity': {
      return {
        ...state,
        runChatIds,
        activityByRun: {
          ...state.activityByRun,
          [event.runId]: { phase: event.phase, label: event.label, toolCallId: event.toolCallId, ts: event.ts },
        },
      };
    }
    case 'run.smallModelWarning': {
      // "una sola vez por run" (doc del punto 6): no se pisa si ya había una para este run.
      if (state.smallModelWarningByRun[event.runId]) return { ...state, runChatIds };
      return {
        ...state,
        runChatIds,
        smallModelWarningByRun: {
          ...state.smallModelWarningByRun,
          [event.runId]: { modelRef: event.modelRef, parameterSize: event.parameterSize },
        },
      };
    }
    case 'run.delegated': {
      const children = state.childRunsByParent[event.parentRunId] ?? [];
      return {
        ...state,
        runChatIds,
        childRunsByParent: {
          ...state.childRunsByParent,
          [event.parentRunId]: children.includes(event.childRunId) ? children : [...children, event.childRunId],
        },
        childChatIdByRun: { ...state.childChatIdByRun, [event.childRunId]: event.childChatId },
      };
    }
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

const initialState: Omit<RunStoreState, 'applyEvents' | 'clearChat' | 'dismissInterrupted' | 'hydratePendingPermissions'> = {
  runStates: {},
  runStartedAt: {},
  runChatIds: {},
  messagesByChat: {},
  metricsByMessage: {},
  streaming: {},
  toolCalls: {},
  toolCallOrderByRun: {},
  pendingPermissions: {},
  checkpointsByChat: {},
  tasksByChat: {},
  adjustmentsByRun: {},
  errorsByRun: {},
  interrupted: {},
  lastSeqByRun: {},
  childRunsByParent: {},
  childChatIdByRun: {},
  activityByRun: {},
  smallModelWarningByRun: {},
  contextBudgetByChat: {},
};

export const useRunStore = create<RunStoreState>((set) => ({
  ...initialState,
  applyEvents: (events) => {
    set((state) => {
      let next = state;
      for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
        next = reduceRunEvent(next, event);
        next = { ...next, lastSeqByRun: { ...next.lastSeqByRun, [event.runId]: event.seq } };
      }
      return next;
    });
  },
  clearChat: (chatId) => {
    set((state) => {
      const { [chatId]: _m, ...restMessages } = state.messagesByChat;
      const { [chatId]: _c, ...restCheckpoints } = state.checkpointsByChat;
      const { [chatId]: _t, ...restTasks } = state.tasksByChat;
      return { ...state, messagesByChat: restMessages, checkpointsByChat: restCheckpoints, tasksByChat: restTasks };
    });
  },
  dismissInterrupted: (runId) => {
    set((state) => {
      const { [runId]: _r, ...rest } = state.interrupted;
      return { ...state, interrupted: rest };
    });
  },
  hydratePendingPermissions: (pending) => {
    if (pending.length === 0) return;
    set((state) => {
      const runChatIds = { ...state.runChatIds };
      const runStates = { ...state.runStates };
      const toolCalls = { ...state.toolCalls };
      const pendingPermissions = { ...state.pendingPermissions };
      for (const { runId, chatId, request } of pending) {
        runChatIds[runId] = chatId;
        // No pisa un estado más específico si por algún motivo ya había uno vivo en memoria.
        if (!runStates[runId]) runStates[runId] = 'awaiting_permission';
        if (!toolCalls[request.toolCallId]) {
          toolCalls[request.toolCallId] = {
            id: request.toolCallId, runId, iteration: 0, toolName: request.toolName,
            args: undefined, argsHash: '', category: request.category, risk: request.risk,
            transport: 'native', status: 'awaiting_permission',
          };
        }
        pendingPermissions[request.toolCallId] = request;
      }
      return { ...state, runChatIds, runStates, toolCalls, pendingPermissions };
    });
  },
}));
