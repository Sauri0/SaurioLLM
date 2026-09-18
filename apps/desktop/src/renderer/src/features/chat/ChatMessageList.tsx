// Lista de mensajes con streaming, tarjetas de tool/permiso/checkpoint y run interrumpido
// (doc 01 §4.1) — apps/desktop/src/renderer/src/features/chat/ChatMessageList.tsx.
import { useEffect, useMemo, useRef } from 'react';
import type { ChatMessage, Checkpoint, Locality, PermissionAnswer } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { useRunStore } from '../../stores/runStore.js';
import { PermissionCard } from '../permissions/PermissionCard.js';
import { MessageBubble } from './MessageBubble.js';
import { ToolCallCard } from './ToolCallCard.js';
import { CheckpointCard } from './CheckpointCard.js';
import { InterruptedRunCard } from './InterruptedRunCard.js';

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
}

export function ChatMessageList({ chatId, onOpenDiff, currentModelLocality }: ChatMessageListProps): React.JSX.Element {
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

  async function answerPermission(answer: PermissionAnswer): Promise<void> {
    await invoke('permission:answer', answer);
  }

  async function recoverRun(runId: string): Promise<void> {
    await invoke('run:continue', { runId });
    useRunStore.getState().dismissInterrupted(runId);
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
  }, [messages.length, streamingMessage?.content, currentRunToolCalls.length, checkpoints.length, pendingPermissionCount, chatInterrupted]);

  const isEmpty = messages.length === 0 && !streamingMessage && currentRunToolCalls.length === 0
    && checkpoints.length === 0 && !chatInterrupted && pendingPermissionCount === 0;

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
            .map((call) => <ToolCallCard key={call.id} call={call} />)}
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

      {currentRunToolCalls.map((call) => <ToolCallCard key={call.id} call={call} />)}

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
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
