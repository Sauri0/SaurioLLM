// Panel de chat: mensajes + entrada (doc 01 §4.1 "feature chat") — apps/desktop/src/renderer/src/
// features/chat/ChatPanel.tsx.
//
// Pasada de diseño #1: antes este componente montaba su propia columna (`aside.chat-panel__sidebar`)
// con el selector de modelo, "+ Nuevo chat" y una lista de chats — la segunda de las tres columnas
// que había a la izquierda del chat. Esa configuración vive ahora en la única barra lateral
// (`layout/Sidebar.tsx`); acá solo queda la conversación, a todo el ancho del centro.
import { useEffect, useState } from 'react';
import type { Attachment, Chat, ChatPermissionPreset, Effort, Mode, ModelRef, PermissionPreset } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { useChatStore } from '../../stores/chatStore.js';
import { useModelsStore } from '../../stores/modelsStore.js';
import { useRunStore } from '../../stores/runStore.js';
import { ChatIcon } from '../../ui/icons.js';
import { formatContextPair } from '../../ui/formatTokens.js';
import { findActiveRunId } from './runStatus.js';
import { ChatMessageList } from './ChatMessageList.js';
import { CostSummary } from './CostSummary.js';
import { ContextInspector } from './ContextInspector.js';
import { ChatInput } from './ChatInput.js';
import { ModelLoadingBanner } from './ModelLoadingBanner.js';
import { displayedModelForChat, isModelInstalled } from './effectiveChatModel.js';
import { resolveChatPermissionDisplay } from './chatPermissionDisplay.js';
import './chat.css';

const DEFAULT_MODE: Mode = 'agent';
const DEFAULT_EFFORT: Effort = 'balanced';

export interface ChatPanelProps {
  projectId: string;
  /** Chat activo (o `undefined` si no hay ninguno seleccionado todavía) — ya resuelto por
   *  `layout/ChatCenter.tsx` desde `chatStore`, así ChatPanel no repite el `.find()`. */
  chat: Chat | undefined;
  defaultAgentId: string;
  /** PRIORIDAD CERO punto 6: `undefined` cuando `models:list` no reportó ningún modelo instalado —
   *  ya no hay un `qwen3:8b` hardcodeado que asumir. Sin esto, no se puede crear un chat nuevo
   *  (ver el estado vacío de abajo). */
  defaultModelRef: ModelRef | undefined;
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
  // El esfuerzo tiene default de chat. En permisos, `undefined` NO equivale a `ask`: el runtime
  // conserva la policy del agente hasta que el usuario fija un override para este chat.
  const effort = chat?.effort ?? DEFAULT_EFFORT;
  const chatAgentId = chat?.agentId;
  const chatPermissionPreset = chat?.permissionPreset;
  const setChatEffort = useChatStore((s) => s.setChatEffort);
  const setChatPermissionPreset = useChatStore((s) => s.setChatPermissionPreset);
  const [composerError, setComposerError] = useState<string | undefined>(undefined);
  const [agentPermission, setAgentPermission] = useState<{
    agentId: string;
    preset?: PermissionPreset;
    state: 'loading' | 'ready' | 'failed';
  }>({ agentId: '', state: 'loading' });

  // Ya no dispara `models:list`/`models:loaded` (eso ahora lo hace `layout/Sidebar.tsx`, doc de la
  // pasada de diseño #1); acá solo se lee `installed` para resolver el `contextMax` del modelo
  // activo y armar el contador de contexto del compositor (pasada de diseño #5).
  const installedModels = useModelsStore((s) => s.installed);

  const runStates = useRunStore((s) => s.runStates);
  const runChatIds = useRunStore((s) => s.runChatIds);
  const runStartedAt = useRunStore((s) => s.runStartedAt);
  const messages = useRunStore((s) => (currentChatId ? s.messagesByChat[currentChatId] : undefined));
  const metricsByMessage = useRunStore((s) => s.metricsByMessage);

  useEffect(() => {
    if (!chatAgentId || chatPermissionPreset) return;
    if (chatAgentId === defaultAgentId) {
      setAgentPermission({ agentId: chatAgentId, preset: 'balanced', state: 'ready' });
      return;
    }
    let cancelled = false;
    setAgentPermission({ agentId: chatAgentId, state: 'loading' });
    void invoke('agents:list', { projectId, includeArchived: true })
      .then((profiles) => {
        if (cancelled) return;
        const profile = profiles.find((candidate) => candidate.id === chatAgentId);
        setAgentPermission(profile
          ? { agentId: chatAgentId, preset: profile.permissionPreset, state: 'ready' }
          : { agentId: chatAgentId, state: 'failed' });
      })
      .catch(() => {
        if (!cancelled) setAgentPermission({ agentId: chatAgentId, state: 'failed' });
      });
    return () => { cancelled = true; };
  }, [chatAgentId, chatPermissionPreset, defaultAgentId, projectId]);

  const permissionLookup: { agentId: string; preset?: PermissionPreset; state: 'loading' | 'ready' | 'failed' } = agentPermission.agentId === chat?.agentId
    ? agentPermission
    : { agentId: chat?.agentId ?? '', state: 'loading' as const };
  const permissionDisplay = resolveChatPermissionDisplay(
    chatPermissionPreset,
    permissionLookup.preset,
    permissionLookup.state,
  );

  useEffect(() => {
    if (currentChatId && !historyLoaded) {
      void loadHistory(currentChatId);
    }
  }, [currentChatId, historyLoaded, loadHistory]);

  const activeRunId = findActiveRunId(currentChatId, runChatIds, runStates);

  async function handleCreateChat(): Promise<void> {
    if (!draftModelRef) return; // el botón de abajo ya queda deshabilitado sin modelo instalado
    const created = await createChat(projectId, defaultAgentId, DEFAULT_MODE, draftModelRef);
    setCurrentChat(created.id);
  }

  // Punto 2 del encargo ("nunca permitir enviar a un modelo no instalado — validación antes de
  // crear el run con error accionable"): un modelo LOCAL puede haberse desinstalado (Centro de
  // modelos, u otro proceso) después de que este chat ya lo tuviera asignado — sin este chequeo,
  // `run:start` igual dispara el run y el usuario recién se entera del problema cuando falla
  // (`provider_down`/`model_not_found`, varios segundos después). Los modelos LAN/NUBE no tienen
  // noción de "instalado" (siempre disponibles mientras el proveedor esté configurado), así que el
  // chequeo solo aplica a `locality: 'local'`.
  async function handleSend(text: string, attachments: Attachment[]): Promise<void> {
    if (!currentChatId) return;
    const modelRef = chat?.modelRef;
    if (modelRef?.locality === 'local' && !isModelInstalled(modelRef, installedModels)) {
      throw new Error(`El modelo "${modelRef.name}" ya no está instalado en este equipo. Elegí otro modelo arriba antes de enviar.`);
    }
    await invoke('run:start', { chatId: currentChatId, text, mode, attachments: attachments.length > 0 ? attachments : undefined });
  }

  async function handleCancel(): Promise<void> {
    if (!activeRunId) return;
    await invoke('run:cancel', { runId: activeRunId });
  }

  async function handleEffortChange(next: Effort): Promise<void> {
    if (!currentChatId) return;
    setComposerError(undefined);
    try {
      await setChatEffort(currentChatId, next);
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handlePermissionPresetChange(next: ChatPermissionPreset, confirmed?: boolean): Promise<void> {
    if (!currentChatId) return;
    setComposerError(undefined);
    try {
      await setChatPermissionPreset(currentChatId, next, confirmed);
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : String(err));
    }
  }

  const activeModelRef = displayedModelForChat(chat, messages ?? []);
  // Un borrador pertenece al próximo chat. En uno automático sin ejecuciones todavía no hay modelo
  // efectivo que afirmar: se muestra el modo hasta que el runtime deje evidencia en el historial.
  const activeModelName = currentChatId
    ? (chat?.modelSelection === 'auto' ? (activeModelRef?.name ?? 'Automático') : activeModelRef?.name)
    : draftModelRef?.name;
  // Rediseño del chat, punto 1 ("indicador de contexto REAL, nunca el máximo teórico del modelo"):
  // `contextBudgetByChat` guarda el `effectiveNumCtx` real del último `context.built` de ESTE chat
  // (runStore.ts); mientras no hubo ningún run todavía no hay valor real que mostrar, así que se
  // omite el máximo en vez de mostrar `contextMax` del modelo (que puede ser 10x-30x más grande que
  // lo que de verdad se manda).
  const contextBudget = useRunStore((s) => (currentChatId ? s.contextBudgetByChat[currentChatId] : undefined));
  const modelResolution = useRunStore((s) => (currentChatId ? s.modelResolutionByChat[currentChatId] : undefined));
  const effectiveContextMax = contextBudget?.effectiveNumCtx ?? contextBudget?.numCtx;
  const lastMessageId = messages && messages.length > 0 ? messages[messages.length - 1]!.id : undefined;
  const lastMetrics = lastMessageId ? metricsByMessage[lastMessageId] : undefined;
  const contextUsed = lastMetrics?.promptTokens !== undefined && lastMetrics.evalTokens !== undefined
    ? lastMetrics.promptTokens + lastMetrics.evalTokens
    : undefined;
  // `contextLimitSource` es opcional para que historiales/eventos anteriores sigan cargando. Si
  // falta, el presupuesto puede ser útil para orientar el uso, pero no debe presentarse como el
  // máximo confirmado por el modelo/proveedor.
  const contextLimitSource = contextBudget?.contextLimitSource;
  const contextLimitDisclosure = contextLimitSource === 'reported'
    ? ''
    : contextLimitSource === 'provisional'
      ? ' (provisional; límite sin confirmar)'
      : ' (límite sin confirmar)';
  const contextLabel = contextBudget
    ? `Contexto ≈ ${formatContextPair(contextBudget.totalUsed, effectiveContextMax)} tokens${contextLimitDisclosure}`
    : contextUsed !== undefined ? `Último uso: ${formatContextPair(contextUsed, undefined)} tokens` : 'Contexto: se calcula al enviar';
  // Tarea "carga de modelo/oom_load": "cargando" = el run activo no tiene ningún `message.delta`
  // todavía (ningún `streaming` cuyo `runId` sea este) — ver ModelLoadingBanner.
  const hasFirstChunk = useRunStore((s) => activeRunId !== undefined && s.firstChunkByRun?.[activeRunId] === true);

  return (
    <div className="chat-panel">
      <section className="chat-panel__main">
        {currentChatId ? (
          <>
            <div className="chat-panel__messages">
              <ChatMessageList
                chatId={currentChatId}
                onOpenDiff={onOpenDiff}
                currentModelLocality={activeModelRef?.locality}
                currentModelName={activeModelName}
              />
            </div>
            <CostSummary metrics={(messages ?? []).filter((message) => message.role === 'assistant'
              && (message.modelRef?.locality !== 'local' || message.metrics?.costUsd !== undefined))
              .map((message) => metricsByMessage[message.id] ?? message.metrics ?? { quality: 'unavailable' as const })} />
            <ModelLoadingBanner
              runState={activeRunId ? runStates[activeRunId] : undefined}
              startedAt={activeRunId ? runStartedAt[activeRunId] : undefined}
              hasFirstChunk={hasFirstChunk}
              onCancel={() => void handleCancel()}
            />
            {composerError && (
              <div className="saurio-banner danger chat-panel__send-error" role="alert">{composerError}</div>
            )}
            <ContextInspector key={`context-${currentChatId}`} report={contextBudget} modelResolution={modelResolution} />
            <ChatInput
              key={currentChatId}
              mode={mode}
              onModeChange={(m) => setMode(currentChatId, m)}
              effort={effort}
              onEffortChange={(e) => void handleEffortChange(e)}
              permissionPreset={permissionDisplay.chatPreset}
              permissionDisplay={permissionDisplay}
              onPermissionPresetChange={(p, confirmed) => void handlePermissionPresetChange(p, confirmed)}
              isRunning={activeRunId !== undefined}
              onSend={handleSend}
              onCancel={() => void handleCancel()}
              modelName={activeModelName ?? '(sin modelo)'}
              contextLabel={contextLabel}
            />
          </>
        ) : (
          <div className="saurio-empty-state saurio-empty-state--fill">
            <span className="saurio-empty-state__icon"><ChatIcon width={18} height={18} /></span>
            <span className="saurio-empty-state__title">Elegí un chat o creá uno nuevo</span>
            <span className="saurio-empty-state__hint">
              {draftModelRef
                ? 'Cada chat mantiene su propio modo, modelo e historial.'
                // PRIORIDAD CERO punto 6: explícito en vez de dejar crear un chat contra un modelo
                // que no existe en este equipo.
                : 'No hay ningún modelo instalado todavía. Instalá uno en la pestaña "Modelos" para poder crear un chat.'}
            </span>
            <button type="button" className="saurio-btn-primary" onClick={() => void handleCreateChat()} disabled={!draftModelRef}>
              + Nuevo chat
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
