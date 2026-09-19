// Lista de mensajes: UN bloque "Actividad" por run (turnos internos, thinking, tool calls y
// checkpoints agrupados, en su lugar cronológico) + el texto final limpio de cada turno — rediseño
// del chat (feedback real v0.2.1: "el chat es confuso y muy cargado"; burbujas "AGENTE" vacías;
// tarjetas de tool/checkpoint amontonadas al final en vez de en orden). apps/desktop/src/renderer/
// src/features/chat/ChatMessageList.tsx.
import { useEffect, useMemo, useRef } from 'react';
import type { ChatMessage, Checkpoint, Locality, PermissionAnswer, ToolCallRecord } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { useRunStore } from '../../stores/runStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { PermissionCard } from '../permissions/PermissionCard.js';
import { MessageBubble } from './MessageBubble.js';
import { ActivityBlock } from './ActivityBlock.js';
import { RunCheckpointCard } from './RunCheckpointCard.js';
import { SmallModelWarningBanner } from './SmallModelWarningBanner.js';
import { InterruptedRunCard } from './InterruptedRunCard.js';
import { OomLoadCard } from './OomLoadCard.js';
import { groupMessagesIntoTurns, countTurnSteps, turnElapsedMs, type ActivityStep, type ChatTurn } from './activityGrouping.js';
import { mergeRunCheckpoints } from './runCheckpoints.js';
import { turnSummaryLabel, toolStepLabel } from './stepLabel.js';

const TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed', 'interrupted']);

// Referencias estables para "sin mensajes"/"sin checkpoints" (mismo bug que ChatCenter.tsx: un
// `[]` inline en el selector de Zustand rompe useSyncExternalStore y causa un loop infinito).
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_CHECKPOINTS: Checkpoint[] = [];

export interface ChatMessageListProps {
  chatId: string;
  onOpenDiff: (checkpointId: string, relPath: string) => void;
  /** Locality del modelo VIGENTE de este chat: fallback del badge NUBE por mensaje para mensajes
   *  de antes de la migración 0003 (doc 16 §10.4/§10.9, punto 4 del encargo) que no tienen
   *  `message.modelRef` propio — ver MessageBubble.tsx, que ahora prefiere ese dato histórico real
   *  cuando existe. */
  currentModelLocality?: Locality;
  /** Nombre del modelo activo del chat, solo para el copy de `OomLoadCard` ("el modelo (X) no
   *  entró..."); `undefined` no rompe nada, la tarjeta lo omite. */
  currentModelName?: string;
}

export function ChatMessageList({ chatId, onOpenDiff, currentModelLocality, currentModelName }: ChatMessageListProps): React.JSX.Element {
  const messages = useRunStore((s) => s.messagesByChat[chatId] ?? EMPTY_MESSAGES);
  const metricsByMessage = useRunStore((s) => s.metricsByMessage);
  const toolCalls = useRunStore((s) => s.toolCalls);
  const checkpoints = useRunStore((s) => s.checkpointsByChat[chatId] ?? EMPTY_CHECKPOINTS);
  const streaming = useRunStore((s) => s.streaming);
  const runStates = useRunStore((s) => s.runStates);
  const runChatIds = useRunStore((s) => s.runChatIds);
  const toolCallOrderByRun = useRunStore((s) => s.toolCallOrderByRun);
  const pendingPermissions = useRunStore((s) => s.pendingPermissions);
  const interrupted = useRunStore((s) => s.interrupted);
  const errorsByRun = useRunStore((s) => s.errorsByRun);
  const activityByRun = useRunStore((s) => s.activityByRun);
  const smallModelWarningByRun = useRunStore((s) => s.smallModelWarningByRun);
  // Doc 19 §2.6 (E3a delegación): DelegationCard necesita el childChatId de ESTA tool call puntual
  // para "ver conversación completa" — `run.delegated` no lleva `toolCallId` (doc 19 §2.3, literal),
  // así que se correlaciona por orden de aparición entre las tool calls `delegate` del run y los
  // childRunId que fue emitiendo `run.delegated` para ese mismo run (limitación conocida: documentada
  // en DelegationCard.tsx).
  const childRunsByParent = useRunStore((s) => s.childRunsByParent);
  const childChatIdByRun = useRunStore((s) => s.childChatIdByRun);
  const setCurrentChat = useChatStore((s) => s.setCurrentChat);

  function resolveDelegationChatId(call: ToolCallRecord): string | undefined {
    const orderedIds = (toolCallOrderByRun[call.runId] ?? []).filter((id) => toolCalls[id]?.toolName === 'delegate');
    const delegateIndex = orderedIds.indexOf(call.id);
    const childRunId = delegateIndex >= 0 ? (childRunsByParent[call.runId] ?? [])[delegateIndex] : undefined;
    return childRunId ? childChatIdByRun[childRunId] : undefined;
  }

  const activeRunId = useMemo(() => {
    const candidates = Object.entries(runChatIds).filter(([, c]) => c === chatId).map(([runId]) => runId);
    return candidates.find((runId) => !TERMINAL_STATES.has(runStates[runId] ?? '')) ?? candidates.at(-1);
  }, [runChatIds, runStates, chatId]);
  const isActiveRunLive = activeRunId !== undefined && !TERMINAL_STATES.has(runStates[activeRunId] ?? '');

  const streamingMessage = useMemo(
    () => Object.values(streaming).find((m) => m.chatId === chatId),
    [streaming, chatId],
  );

  const currentRunToolCalls = useMemo(() => {
    if (!activeRunId) return [];
    const order = toolCallOrderByRun[activeRunId] ?? [];
    return order
      .map((id) => toolCalls[id])
      .filter((call): call is NonNullable<typeof call> =>
        call !== undefined && (call.messageId === undefined || call.messageId === streamingMessage?.id));
  }, [activeRunId, toolCallOrderByRun, toolCalls, streamingMessage]);

  const turns = useMemo(
    () => groupMessagesIntoTurns(messages, toolCalls, checkpoints),
    [messages, toolCalls, checkpoints],
  );

  // El turno en curso todavía no pasó por `groupMessagesIntoTurns` (sus tool calls tienen
  // `messageId` sin resolver hasta que el mensaje en streaming cierra) — se le pegan los pasos vivos
  // al ÚLTIMO turno siempre que haya un run activo (caso normal: mismo turno que recién abrió el
  // usuario). Caso real, no tan raro: el turno YA tiene texto final (el modelo escribió algo) pero
  // el run sigue — otra tool call, posiblemente esperando permiso, antes de seguir. Ahí el texto
  // final anterior se DEMUEVE a paso interno (mismo criterio que `groupMessagesIntoTurns` usa para
  // mensajes ya cerrados) y el nuevo texto en vivo (si lo hay) pasa a ser el final visible.
  const lastTurn = turns.at(-1);
  const liveAttachesToLastTurn = isActiveRunLive && lastTurn !== undefined;

  function buildLiveSteps(): ActivityStep[] {
    const steps: ActivityStep[] = [];
    if (streamingMessage?.thinking && streamingMessage.thinking.trim().length > 0) {
      steps.push({ kind: 'thinking', messageId: streamingMessage.id, text: streamingMessage.thinking });
    }
    for (const call of currentRunToolCalls) steps.push({ kind: 'tool', toolCall: call });
    return steps;
  }
  const liveSteps = isActiveRunLive ? buildLiveSteps() : [];

  function liveHeaderLabel(): string {
    if (activeRunId && activityByRun[activeRunId]) return activityByRun[activeRunId]!.label;
    const runningCall = [...currentRunToolCalls].reverse().find((c) => c.status === 'running' || c.status === 'awaiting_permission');
    if (runningCall) return toolStepLabel(runningCall);
    if (streamingMessage?.thinking && !streamingMessage.content) return 'Pensando…';
    return 'Trabajando…';
  }

  const chatInterrupted = useMemo(
    () => Object.values(interrupted).find((i) => i.chatId === chatId),
    [interrupted, chatId],
  );

  // Tarea "carga de modelo/oom_load": el ÚLTIMO run de este chat terminó `failed` con `oom_load`
  // (RunController ya agotó la escalera automática de numGpu antes de llegar acá, ver
  // RunController.handleOomLoad) — se ofrece elegir otro modelo o reintentar desde cero.
  const oomFailure = useMemo(() => {
    if (!activeRunId || runStates[activeRunId] !== 'failed') return undefined;
    const error = (errorsByRun[activeRunId] ?? []).at(-1);
    return error?.code === 'oom_load' ? { runId: activeRunId, error } : undefined;
  }, [activeRunId, runStates, errorsByRun]);

  async function answerPermission(answer: PermissionAnswer): Promise<void> {
    await invoke('permission:answer', answer);
  }

  async function recoverRun(runId: string): Promise<void> {
    await invoke('run:continue', { runId });
    useRunStore.getState().dismissInterrupted(runId);
  }

  async function retryAfterOom(runId: string): Promise<void> {
    await invoke('run:continue', { runId });
  }

  const pendingForActiveRun = Object.values(pendingPermissions).filter((req) => toolCalls[req.toolCallId]?.runId === activeRunId);

  // Scroll automático al fondo (UX estándar de chat): sin esto, un mensaje largo o una tarjeta
  // nueva (tool call, checkpoint, permiso) puede quedar fuera de la vista sin que el usuario note
  // que hay contenido nuevo debajo. El contenedor que hace scroll es `.chat-panel__messages`
  // (feature chat/ChatPanel.tsx); `scrollIntoView` sobre un centinela al final alcanza sin acoplar
  // este componente a esa clase.
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, streamingMessage?.content, currentRunToolCalls.length, checkpoints.length, pendingForActiveRun.length, chatInterrupted, oomFailure]);

  const isEmpty = turns.length === 0 && liveSteps.length === 0 && !streamingMessage
    && pendingForActiveRun.length === 0 && !chatInterrupted && !oomFailure;

  if (isEmpty) {
    return (
      <div className="chat-message-list chat-message-list--empty">
        <p className="saurio-empty">Escribí un mensaje para empezar la conversación.</p>
      </div>
    );
  }

  function renderTurn(turn: ChatTurn, isLastTurn: boolean): React.JSX.Element {
    const attachLive = isLastTurn && liveAttachesToLastTurn;
    // Si el turno YA tenía un texto final (el modelo escribió algo y el run siguió con más tool
    // calls después) ese texto pasa a ser un paso interno más, en su lugar cronológico — el mismo
    // criterio que usa `groupMessagesIntoTurns` para mensajes ya cerrados.
    const priorFinalAsStep: ActivityStep[] = attachLive && turn.finalMessage && turn.finalMessage.content.trim().length > 0
      ? [{ kind: 'text', messageId: turn.finalMessage.id, text: turn.finalMessage.content }]
      : [];
    const steps = attachLive ? [...turn.steps, ...priorFinalAsStep, ...liveSteps] : turn.steps;
    const counts = countTurnSteps(steps);
    const elapsed = turnElapsedMs(steps);
    const headerLabel = attachLive ? liveHeaderLabel() : turnSummaryLabel(counts, elapsed);
    const merged = mergeRunCheckpoints(turn.checkpoints);
    // Mientras el turno está vivo, el texto final visible es el que va llegando por streaming AHORA
    // (con cursor) — si todavía no hay nada nuevo (esperando permiso, pensando), no se muestra
    // ningún texto final hasta que llegue. Si el turno ya cerró, es `turn.finalMessage` tal cual.
    const finalContent = attachLive
      ? (streamingMessage?.content ? { id: streamingMessage.id, role: 'assistant' as const, content: streamingMessage.content } : undefined)
      : turn.finalMessage;
    const turnPending = turn.runId
      ? pendingForActiveRun.filter((req) => toolCalls[req.toolCallId]?.runId === turn.runId)
      : (attachLive ? pendingForActiveRun : []);
    // Punto 6 del rediseño: "modelo chico para modo Agente" — una sola vez por run.
    const turnRunId = turn.runId ?? (attachLive ? activeRunId : undefined);
    const smallModelWarning = turnRunId ? smallModelWarningByRun[turnRunId] : undefined;

    return (
      <div key={turn.id} className="chat-message-list__group">
        {turn.userMessage && (
          <MessageBubble message={turn.userMessage} currentModelLocality={currentModelLocality} />
        )}
        <ActivityBlock
          steps={steps}
          headerLabel={headerLabel}
          live={attachLive}
          resolveDelegationChatId={resolveDelegationChatId}
          onOpenChat={setCurrentChat}
        />
        {smallModelWarning && (
          <SmallModelWarningBanner modelName={smallModelWarning.modelRef.name} parameterSize={smallModelWarning.parameterSize} />
        )}
        {merged && <RunCheckpointCard merged={merged} onOpenDiff={onOpenDiff} />}
        {turnPending.map((request) => (
          <PermissionCard key={request.toolCallId} request={request} onAnswer={(a) => void answerPermission(a)} />
        ))}
        {finalContent && (
          <MessageBubble
            message={finalContent}
            streaming={attachLive}
            metrics={attachLive ? undefined : metricsByMessage[finalContent.id] ?? turn.finalMessage?.metrics}
            currentModelLocality={currentModelLocality}
          />
        )}
      </div>
    );
  }

  // Actividad viva SIN NINGÚN turno donde colgarla — solo pasa si `turns` está vacío (el primer
  // mensaje del usuario todavía no volvió como `message.done`, caso breve al arrancar un chat
  // nuevo). Se muestra aparte, sin burbuja de usuario, al final de la lista.
  const trailingLiveSteps = isActiveRunLive && !liveAttachesToLastTurn ? liveSteps : [];
  const trailingPending = liveAttachesToLastTurn ? [] : pendingForActiveRun;

  return (
    <div className="chat-message-list">
      {turns.map((turn, index) => renderTurn(turn, index === turns.length - 1))}

      {(trailingLiveSteps.length > 0 || trailingPending.length > 0) && (
        <div className="chat-message-list__group">
          {trailingLiveSteps.length > 0 && (
            <ActivityBlock
              steps={trailingLiveSteps}
              headerLabel={liveHeaderLabel()}
              live
              resolveDelegationChatId={resolveDelegationChatId}
              onOpenChat={setCurrentChat}
            />
          )}
          {trailingPending.map((request) => (
            <PermissionCard key={request.toolCallId} request={request} onAnswer={(a) => void answerPermission(a)} />
          ))}
          {streamingMessage?.content && (
            <MessageBubble
              message={{ id: streamingMessage.id, role: 'assistant', content: streamingMessage.content }}
              streaming
              currentModelLocality={currentModelLocality}
            />
          )}
        </div>
      )}

      {chatInterrupted && (
        <InterruptedRunCard
          info={chatInterrupted}
          onRecover={(runId) => void recoverRun(runId)}
          onDismiss={(runId) => useRunStore.getState().dismissInterrupted(runId)}
        />
      )}

      {oomFailure && (
        <OomLoadCard
          runId={oomFailure.runId}
          error={oomFailure.error}
          modelName={currentModelName}
          onRetry={(runId) => void retryAfterOom(runId)}
        />
      )}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
