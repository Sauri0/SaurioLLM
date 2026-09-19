// Lista de mensajes: UN bloque "Actividad" por run (turnos internos, thinking, tool calls y
// checkpoints agrupados, en su lugar cronológico) + el texto final limpio de cada turno — rediseño
// del chat (feedback real v0.2.1: "el chat es confuso y muy cargado"; burbujas "AGENTE" vacías;
// tarjetas de tool/checkpoint amontonadas al final en vez de en orden). apps/desktop/src/renderer/
// src/features/chat/ChatMessageList.tsx.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, Checkpoint, Locality, PermissionAnswer, RunState, ToolCallRecord } from '@saurio/shared';
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
import { adjustmentsForRun, RunAdjustments } from './RunAdjustments.js';
import { groupMessagesIntoTurns, countTurnSteps, turnElapsedMs, type ActivityStep, type ChatTurn } from './activityGrouping.js';
import { mergeRunCheckpoints } from './runCheckpoints.js';
import { turnSummaryLabel, toolStepLabel } from './stepLabel.js';
import { isNearChatScrollBottom } from './chatScroll.js';

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
  const adjustmentsByRun = useRunStore((s) => s.adjustmentsByRun);
  const activityByRun = useRunStore((s) => s.activityByRun);
  const smallModelWarningByRun = useRunStore((s) => s.smallModelWarningByRun);
  // Delegaciones nuevas correlacionan por toolCallId. El orden se conserva sólo para replays
  // legacy cuyos eventos run.delegated todavía no incluían ese campo.
  const childRunsByParent = useRunStore((s) => s.childRunsByParent);
  const childChatIdByRun = useRunStore((s) => s.childChatIdByRun);
  const childChatIdByToolCall = useRunStore((s) => s.childChatIdByToolCall);
  const setCurrentChat = useChatStore((s) => s.setCurrentChat);
  // `run:continue` crea un run nuevo. Mantener este cerrojo hasta que la tarjeta desaparezca evita
  // que un doble click alcance a crear dos continuaciones antes de que llegue el próximo evento.
  const continuingRunIds = useRef(new Set<string>());
  const [continuingByRun, setContinuingByRun] = useState<Record<string, true>>({});
  const [continueErrors, setContinueErrors] = useState<Record<string, string>>({});
  const stoppingChildRunIds = useRef(new Set<string>());
  const [stoppingByChildRun, setStoppingByChildRun] = useState<Record<string, true>>({});
  const [stopErrorsByChildRun, setStopErrorsByChildRun] = useState<Record<string, string>>({});

  function resolveDelegationTarget(call: ToolCallRecord): {
    childRunId?: string;
    childChatId?: string;
    childRunState?: RunState;
    stopping?: boolean;
    stopError?: string;
  } {
    const exactChatId = childChatIdByToolCall[call.id];
    const childRuns = childRunsByParent[call.runId] ?? [];
    const exactRunId = exactChatId
      ? childRuns.find((candidate) => childChatIdByRun[candidate] === exactChatId)
      : undefined;
    const orderedIds = (toolCallOrderByRun[call.runId] ?? []).filter((id) => toolCalls[id]?.toolName === 'delegate');
    const delegateIndex = orderedIds.indexOf(call.id);
    const childRunId = exactRunId ?? (delegateIndex >= 0 ? childRuns[delegateIndex] : undefined);
    const childChatId = exactChatId ?? (childRunId ? childChatIdByRun[childRunId] : undefined);
    return {
      childRunId,
      childChatId,
      childRunState: childRunId ? runStates[childRunId] : undefined,
      stopping: childRunId ? stoppingByChildRun[childRunId] === true : false,
      stopError: childRunId ? stopErrorsByChildRun[childRunId] : undefined,
    };
  }

  async function stopDelegation(parentRunId: string, childRunId: string): Promise<void> {
    if (stoppingChildRunIds.current.has(childRunId)) return;
    stoppingChildRunIds.current.add(childRunId);
    setStoppingByChildRun((current) => ({ ...current, [childRunId]: true }));
    setStopErrorsByChildRun((current) => {
      const next = { ...current };
      delete next[childRunId];
      return next;
    });
    try {
      await invoke('run:cancelChild', { parentRunId, childRunId });
      // El botón conserva "Deteniendo…" hasta que el evento del run confirme el estado terminal.
    } catch (error) {
      stoppingChildRunIds.current.delete(childRunId);
      setStoppingByChildRun((current) => {
        const next = { ...current };
        delete next[childRunId];
        return next;
      });
      setStopErrorsByChildRun((current) => ({
        ...current,
        [childRunId]: error instanceof Error && error.message.trim() ? error.message : 'Ocurrió un error inesperado.',
      }));
    }
  }

  const activeRunId = useMemo(() => {
    const candidates = Object.entries(runChatIds).filter(([, c]) => c === chatId).map(([runId]) => runId);
    return candidates.find((runId) => !TERMINAL_STATES.has(runStates[runId] ?? '')) ?? candidates.at(-1);
  }, [runChatIds, runStates, chatId]);
  const isActiveRunLive = activeRunId !== undefined && !TERMINAL_STATES.has(runStates[activeRunId] ?? '');
  const activeRunAdjustments = adjustmentsForRun(adjustmentsByRun, activeRunId);

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
  const failedRunError = activeRunId && runStates[activeRunId] === 'failed'
    ? (errorsByRun[activeRunId] ?? []).at(-1)
    : undefined;

  async function answerPermission(answer: PermissionAnswer): Promise<void> {
    await invoke('permission:answer', answer);
  }

  async function continueRun(runId: string, dismissInterrupted: boolean): Promise<void> {
    if (continuingRunIds.current.has(runId)) return;
    continuingRunIds.current.add(runId);
    setContinuingByRun((current) => ({ ...current, [runId]: true }));
    setContinueErrors((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });

    try {
      await invoke('run:continue', { runId });
      if (dismissInterrupted) useRunStore.getState().dismissInterrupted(runId);
      // El cerrojo se libera cuando se desmonta la tarjeta (effect de abajo): antes de eso el run
      // nuevo puede todavía no haber emitido su estado y permitiría una continuación duplicada.
    } catch (error) {
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : 'Ocurrió un error inesperado.';
      setContinueErrors((current) => ({ ...current, [runId]: message }));
      continuingRunIds.current.delete(runId);
      setContinuingByRun((current) => {
        const next = { ...current };
        delete next[runId];
        return next;
      });
    }
  }

  const pendingForActiveRun = Object.values(pendingPermissions).filter((req) => toolCalls[req.toolCallId]?.runId === activeRunId);

  // Scroll automático al fondo (UX estándar de chat): sin esto, un mensaje largo o una tarjeta
  // nueva (tool call, checkpoint, permiso) puede quedar fuera de la vista sin que el usuario note
  // que hay contenido nuevo debajo. El contenedor que hace scroll es `.chat-panel__messages`
  // (feature chat/ChatPanel.tsx); `scrollIntoView` sobre un centinela al final alcanza sin acoplar
  // este componente a esa clase.
  const bottomRef = useRef<HTMLDivElement>(null);
  const [followScroll, setFollowScroll] = useState(true);

  useEffect(() => {
    // Al cambiar de chat se arranca en el final de su conversación. Después, sólo una acción de
    // scroll de la persona decide si seguimos los mensajes nuevos.
    setFollowScroll(true);
  }, [chatId]);

  useEffect(() => {
    const scrollContainer = bottomRef.current?.closest<HTMLElement>('.chat-panel__messages');
    if (!scrollContainer) return;

    const updateFollowScroll = () => {
      setFollowScroll(isNearChatScrollBottom(
        scrollContainer.scrollHeight,
        scrollContainer.scrollTop,
        scrollContainer.clientHeight,
      ));
    };
    scrollContainer.addEventListener('scroll', updateFollowScroll, { passive: true });
    return () => scrollContainer.removeEventListener('scroll', updateFollowScroll);
  }, [chatId]);

  useEffect(() => {
    if (followScroll) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [followScroll, messages.length, streamingMessage?.content, currentRunToolCalls.length, checkpoints.length, pendingForActiveRun.length, chatInterrupted, oomFailure]);

  useEffect(() => {
    const visibleRunIds = new Set([chatInterrupted?.runId, oomFailure?.runId].filter((runId): runId is string => runId !== undefined));
    for (const runId of continuingRunIds.current) {
      if (visibleRunIds.has(runId)) continue;
      continuingRunIds.current.delete(runId);
      setContinuingByRun((current) => {
        if (!current[runId]) return current;
        const next = { ...current };
        delete next[runId];
        return next;
      });
      setContinueErrors((current) => {
        if (!current[runId]) return current;
        const next = { ...current };
        delete next[runId];
        return next;
      });
    }
  }, [chatInterrupted?.runId, oomFailure?.runId]);

  useEffect(() => {
    for (const childRunId of stoppingChildRunIds.current) {
      if (!TERMINAL_STATES.has(runStates[childRunId] ?? '')) continue;
      stoppingChildRunIds.current.delete(childRunId);
      setStoppingByChildRun((current) => {
        const next = { ...current };
        delete next[childRunId];
        return next;
      });
    }
  }, [runStates]);

  const isEmpty = turns.length === 0 && liveSteps.length === 0 && !streamingMessage
    && pendingForActiveRun.length === 0 && !chatInterrupted && !oomFailure && !isActiveRunLive;

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
        {turn.alternative && <p className="chat-message-list__alternative">Respuesta alternativa</p>}
        {turn.userMessage && (
          <MessageBubble message={turn.userMessage} currentModelLocality={currentModelLocality} />
        )}
        <ActivityBlock
          steps={steps}
          headerLabel={headerLabel}
          live={attachLive}
          resolveDelegationTarget={resolveDelegationTarget}
          onStopChild={(parentRunId, childRunId) => void stopDelegation(parentRunId, childRunId)}
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
            hasActiveRun={isActiveRunLive}
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

      {((isActiveRunLive && !liveAttachesToLastTurn) || trailingPending.length > 0) && (
        <div className="chat-message-list__group">
          {isActiveRunLive && (
            <ActivityBlock
              steps={trailingLiveSteps}
              headerLabel={liveHeaderLabel()}
              live
              resolveDelegationTarget={resolveDelegationTarget}
              onStopChild={(parentRunId, childRunId) => void stopDelegation(parentRunId, childRunId)}
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

      <RunAdjustments adjustments={activeRunAdjustments} />

      {failedRunError && failedRunError.code !== 'oom_load' && (
        <div className="saurio-banner danger" role="alert">
          <div>
            <strong>No se pudo completar el pedido.</strong>
            <p>{failedRunError.message}</p>
            <p>Podés revisar la configuración o enviar un nuevo pedido.</p>
          </div>
        </div>
      )}

      {chatInterrupted && (
        <InterruptedRunCard
          info={chatInterrupted}
          onRecover={(runId) => continueRun(runId, true)}
          onDismiss={(runId) => useRunStore.getState().dismissInterrupted(runId)}
          busy={continuingByRun[chatInterrupted.runId] === true}
          recoverError={continueErrors[chatInterrupted.runId]}
        />
      )}

      {oomFailure && (
        <OomLoadCard
          runId={oomFailure.runId}
          error={oomFailure.error}
          modelName={currentModelName}
          onRetry={(runId) => continueRun(runId, false)}
          busy={continuingByRun[oomFailure.runId] === true}
          retryError={continueErrors[oomFailure.runId]}
        />
      )}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
