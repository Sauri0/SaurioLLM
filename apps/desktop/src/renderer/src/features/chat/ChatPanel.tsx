// Panel de chat: mensajes + entrada (doc 01 §4.1 "feature chat") — apps/desktop/src/renderer/src/
// features/chat/ChatPanel.tsx.
//
// Pasada de diseño #1: antes este componente montaba su propia columna (`aside.chat-panel__sidebar`)
// con el selector de modelo, "+ Nuevo chat" y una lista de chats — la segunda de las tres columnas
// que había a la izquierda del chat. Esa configuración vive ahora en la única barra lateral
// (`layout/Sidebar.tsx`); acá solo queda la conversación, a todo el ancho del centro.
import { useEffect } from 'react';
import type { Chat, Mode, ModelRef } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { useChatStore } from '../../stores/chatStore.js';
import { useModelsStore } from '../../stores/modelsStore.js';
import { useRunStore } from '../../stores/runStore.js';
import { ChatIcon } from '../../ui/icons.js';
import { formatContextPair } from '../../ui/formatTokens.js';
import { findActiveRunId } from './runStatus.js';
import { ChatMessageList } from './ChatMessageList.js';
import { ChatInput } from './ChatInput.js';
import './chat.css';

const DEFAULT_MODE: Mode = 'agent';

export interface ChatPanelProps {
  projectId: string;
  /** Chat activo (o `undefined` si no hay ninguno seleccionado todavía) — ya resuelto por
   *  `layout/ChatCenter.tsx` desde `chatStore`, así ChatPanel no repite el `.find()`. */
  chat: Chat | undefined;
  defaultAgentId: string;
  defaultModelRef: ModelRef;
  /** El diff en sí vive en `features/diff` (fuera de esta tarea); acá solo se reenvía el pedido. */
  onOpenDiff: (checkpointId: string, relPath: string) => void;
}

export function ChatPanel({ projectId, chat, defaultAgentId, defaultModelRef, onOpenDiff }: ChatPanelProps): React.JSX.Element {
  const currentChatId = useChatStore((s) => s.currentChatId);
  const createChat = useChatStore((s) => s.createChat);
  const setCurrentChat = useChatStore((s) => s.setCurrentChat);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const historyLoaded = useChatStore((s) => (currentChatId ? (s.historyLoaded[currentChatId] ?? false) : false));
  const mode = useChatStore((s) => (currentChatId ? (s.modeByChat[currentChatId] ?? DEFAULT_MODE) : DEFAULT_MODE));
  const setMode = useChatStore((s) => s.setMode);
  const draftModelRef = useChatStore((s) => s.draftModelRefByProject[projectId] ?? defaultModelRef);

  // Ya no dispara `models:list`/`models:loaded` (eso ahora lo hace `layout/Sidebar.tsx`, doc de la
  // pasada de diseño #1); acá solo se lee `installed` para resolver el `contextMax` del modelo
  // activo y armar el contador de contexto del compositor (pasada de diseño #5).
  const installedModels = useModelsStore((s) => s.installed);

  const runStates = useRunStore((s) => s.runStates);
  const runChatIds = useRunStore((s) => s.runChatIds);
  const messages = useRunStore((s) => (currentChatId ? s.messagesByChat[currentChatId] : undefined));
  const metricsByMessage = useRunStore((s) => s.metricsByMessage);

  useEffect(() => {
    if (currentChatId && !historyLoaded) {
      void loadHistory(currentChatId);
    }
  }, [currentChatId, historyLoaded, loadHistory]);

  const activeRunId = findActiveRunId(currentChatId, runChatIds, runStates);

  async function handleCreateChat(): Promise<void> {
    const created = await createChat(projectId, defaultAgentId, DEFAULT_MODE, draftModelRef);
    setCurrentChat(created.id);
  }

  async function handleSend(text: string): Promise<void> {
    if (!currentChatId) return;
    await invoke('run:start', { chatId: currentChatId, text, mode });
  }

  async function handleCancel(): Promise<void> {
    if (!activeRunId) return;
    await invoke('run:cancel', { runId: activeRunId });
  }

  const activeModelName = chat?.modelRef?.name ?? draftModelRef.name;
  const activeModelInfo = installedModels.find((m) => m.ref.name === activeModelName);
  const lastMessageId = messages && messages.length > 0 ? messages[messages.length - 1]!.id : undefined;
  const lastMetrics = lastMessageId ? metricsByMessage[lastMessageId] : undefined;
  const contextUsed = lastMetrics?.promptTokens !== undefined && lastMetrics.evalTokens !== undefined
    ? lastMetrics.promptTokens + lastMetrics.evalTokens
    : undefined;
  const contextLabel = formatContextPair(contextUsed, activeModelInfo?.contextMax);

  return (
    <div className="chat-panel">
      <section className="chat-panel__main">
        {currentChatId ? (
          <>
            <div className="chat-panel__messages">
              <ChatMessageList chatId={currentChatId} onOpenDiff={onOpenDiff} currentModelLocality={chat?.modelRef?.locality} />
            </div>
            <ChatInput
              mode={mode}
              onModeChange={(m) => setMode(currentChatId, m)}
              isRunning={activeRunId !== undefined}
              onSend={(text) => void handleSend(text)}
              onCancel={() => void handleCancel()}
              modelName={activeModelName}
              contextLabel={contextLabel}
            />
          </>
        ) : (
          <div className="saurio-empty-state saurio-empty-state--fill">
            <span className="saurio-empty-state__icon"><ChatIcon width={18} height={18} /></span>
            <span className="saurio-empty-state__title">Elegí un chat o creá uno nuevo</span>
            <span className="saurio-empty-state__hint">Cada chat mantiene su propio modo, modelo e historial.</span>
            <button type="button" className="saurio-btn-primary" onClick={() => void handleCreateChat()}>+ Nuevo chat</button>
          </div>
        )}
      </section>
    </div>
  );
}
