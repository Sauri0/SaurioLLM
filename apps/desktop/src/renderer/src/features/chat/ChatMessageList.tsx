// Lista de mensajes con streaming, tarjetas de tool/permiso/checkpoint y run interrumpido
// (doc 01 §4.1) — apps/desktop/src/renderer/src/features/chat/ChatMessageList.tsx.
import { useEffect, useMemo, useRef } from 'react';
import type { ChatMessage, Checkpoint, Locality, PermissionAnswer, ToolCallRecord } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { useRunStore } from '../../stores/runStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { PermissionCard } from '../permissions/PermissionCard.js';
import { MessageBubble } from './MessageBubble.js';
import { ToolCallCard } from './ToolCallCard.js';
import { DelegationCard } from './DelegationCard.js';
import { CheckpointCard } from './CheckpointCard.js';
import { InterruptedRunCard } from './InterruptedRunCard.js';
import { OomLoadCard } from './OomLoadCard.js';

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
  // Doc 19 §2.6 (E3a delegación): DelegationCard necesita el childChatId de ESTA tool call puntual
  // para "ver conversación completa" — `run.delegated` no lleva `toolCallId` (doc 19 §2.3, literal),
  // así que se correlaciona por orden de aparición entre las tool calls `delegate` del run y los
  // childRunId que fue emitiendo `run.delegated` para ese mismo run (limitación conocida: documentada
  // en DelegationCard.tsx).
  const childRunsByParent = useRunStore((s) => s.childRunsByParent);
  const childChatIdByRun = useRunStore((s) => s.childChatIdByRun);
  const setCurrentChat = useChatStore((s) => s.setCurrentChat);

  function renderToolCall(call: ToolCallRecord): React.JSX.Element {
    if (call.toolName !== 'delegate') return <ToolCallCard key={call.id} call={call} />;
    const orderedIds = (toolCallOrderByRun[call.runId] ?? []).filter((id) => toolCalls[id]?.toolName === 'delegate');
    const delegateIndex = orderedIds.indexOf(call.id);
    const childRunId = delegateIndex >= 0 ? (childRunsByParent[call.runId] ?? [])[delegateIndex] : undefined;
    const childChatId = childRunId ? childChatIdByRun[childRunId] : undefined;
    return <DelegationCard key={call.id} call={call} childChatId={childChatId} onOpenChat={setCurrentChat} />;
  }

  const activeRunId = useMemo(() => {
    const candidates = Object.entries(runChatIds).filter(([, c]) => c === chatId).map(([runId]) => runId);
    return candidates.find((runId) => !TERMINAL_STATES.has(runStates[runId] ?? '')) ?? candidates.at(-1);
  }, [runChatIds, runStates, chatId]);

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

  const pendingPermissionCount = Object.values(pendingPermissions)
    .filter((req) => toolCalls[req.toolCallId]?.runId === activeRunId).length;

  // Scroll automático al fondo (UX estándar de chat): sin esto, un mensaje largo o una tarjeta
  // nueva (tool call, checkpoint, permiso) puede quedar fuera de la vista sin que el usuario note
  // que hay contenido nuevo debajo. El contenedor que hace scroll es `.chat-panel__messages`
  // (feature chat/ChatPanel.tsx); `scrollIntoView` sobre un centinela al final alcanza sin acoplar
  // este componente a esa clase.
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, streamingMessage?.content, currentRunToolCalls.length, checkpoints.length, pendingPermissionCount, chatInterrupted, oomFailure]);

  const isEmpty = messages.length === 0 && !streamingMessage && currentRunToolCalls.length === 0
    && checkpoints.length === 0 && !chatInterrupted && pendingPermissionCount === 0 && !oomFailure;

  if (isEmpty) {
    return (
      <div className="chat-message-list chat-message-list--empty">
        <p className="saurio-empty">Escribí un mensaje para empezar la conversación.</p>
      </div>
    );
  }

  return (
    <div className="chat-message-list">
      {messages.map((message) => (
        <div key={message.id} className="chat-message-list__group">
          {/* `metricsByMessage` (runStore, en vivo) tiene prioridad; si el mensaje viene de
              `chat:history` (recargó la app, nunca pasó por un evento en vivo en esta sesión) se cae
              a `message.metrics` — ya persistido en `messages.response_metrics_json` desde antes de
              esta tarea, pero `ChatMessage`/`MessageRepository` no lo exponían (cambio de esta tarea,
              punto 4 del encargo: "mostrar tokens de entrada/salida"). */}
          <MessageBubble
            message={message}
            metrics={metricsByMessage[message.id] ?? message.metrics}
            currentModelLocality={currentModelLocality}
          />
          {Object.values(toolCalls)
            .filter((call) => call.messageId === message.id)
            .map((call) => renderToolCall(call))}
        </div>
      ))}

      {streamingMessage && (
        <div className="chat-message-list__group">
          <MessageBubble
            message={{ id: streamingMessage.id, role: 'assistant', content: streamingMessage.content, thinking: streamingMessage.thinking || undefined }}
            streaming
            currentModelLocality={currentModelLocality}
          />
        </div>
      )}

      {currentRunToolCalls.map((call) => renderToolCall(call))}

      {checkpoints.map((checkpoint) => (
        <CheckpointCard key={checkpoint.id} checkpoint={checkpoint} onOpenDiff={onOpenDiff} />
      ))}

      {Object.values(pendingPermissions)
        .filter((req) => toolCalls[req.toolCallId]?.runId === activeRunId)
        .map((request) => (
          <PermissionCard key={request.toolCallId} request={request} onAnswer={(a) => void answerPermission(a)} />
        ))}

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
