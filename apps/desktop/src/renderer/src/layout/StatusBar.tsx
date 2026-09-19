// Barra de estado inferior: modelo activo, contexto usado, tok/s, LOCAL y Ollama conectado
// (pasada de diseño visual — doc 01 §4.1 "Paneles del MVP"). apps/desktop/src/renderer/src/layout/StatusBar.tsx.
//
// Solo pinta: lee de los stores existentes. La salud de Ollama viene del poll único compartido,
// para que no haya una comprobación por componente ni se confunda con el estado de otros providers.
import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore.js';
import { useRunStore } from '../stores/runStore.js';
import { useOllamaHealthStore } from '../stores/ollamaHealthStore.js';
import { CpuIcon, GaugeIcon, PlugIcon } from '../ui/icons.js';
import { formatContextPair } from '../ui/formatTokens.js';
import { localityLabel } from '../features/models/locality.js';
import { displayedModelForChat } from '../features/chat/effectiveChatModel.js';
import type { Chat, ChatMessage, ModelRef } from '@saurio/shared';

function genTps(promptTokens: number | undefined, evalTokens: number | undefined, evalMs: number | undefined): number | undefined {
  if (evalTokens === undefined || evalMs === undefined || evalMs <= 0) return undefined;
  return (evalTokens / evalMs) * 1000;
}

export interface StatusBarProps {
  projectId: string | null;
  chatId: string | null;
}

/** El borrador solo representa al próximo chat; nunca reemplaza el modelo de uno abierto. */
export function statusModelRef(
  chatId: string | null,
  chats: Chat[] | undefined,
  draftModelRef: ModelRef | undefined,
  messages: readonly ChatMessage[] = [],
): ModelRef | undefined {
  if (!chatId) return draftModelRef;
  return displayedModelForChat(chats?.find((chat) => chat.id === chatId), messages);
}

/** Misma prioridad y lenguaje que el indicador del compositor. */
export function statusContextLabel(
  contextBudget: {
    totalUsed: number;
    effectiveNumCtx?: number;
    numCtx?: number;
    contextLimitSource?: 'reported' | 'provisional';
  } | undefined,
  lastMessageContextUsed: number | undefined,
): string {
  if (contextBudget) {
    const effectiveContextMax = contextBudget.effectiveNumCtx ?? contextBudget.numCtx;
    const limitDisclosure = contextBudget.contextLimitSource === 'reported'
      ? ''
      : contextBudget.contextLimitSource === 'provisional'
        ? ' (provisional; límite sin confirmar)'
        : ' (límite sin confirmar)';
    return `Contexto ≈ ${formatContextPair(contextBudget.totalUsed, effectiveContextMax) ?? '—'} tokens${limitDisclosure}`;
  }
  if (lastMessageContextUsed !== undefined) {
    return `Último uso: ${formatContextPair(lastMessageContextUsed, undefined)} tokens`;
  }
  return 'Contexto: se calcula al enviar';
}

export function StatusBar({ projectId, chatId }: StatusBarProps): React.JSX.Element {
  const projectChats = useChatStore((s) => (projectId ? s.chatsByProject[projectId] : undefined));
  const draftModelRef = useChatStore((s) => (projectId ? s.draftModelRefByProject[projectId] : undefined));
  const messages = useRunStore((s) => (chatId ? s.messagesByChat[chatId] : undefined));
  const metricsByMessage = useRunStore((s) => s.metricsByMessage);
  const contextBudget = useRunStore((s) => (chatId ? s.contextBudgetByChat[chatId] : undefined));
  const ollamaOk = useOllamaHealthStore((s) => s.ok);
  const starting = useOllamaHealthStore((s) => s.starting);
  const startError = useOllamaHealthStore((s) => s.startError);
  const startOllama = useOllamaHealthStore((s) => s.start);
  const subscribeOllamaHealth = useOllamaHealthStore((s) => s.subscribe);

  useEffect(() => {
    return subscribeOllamaHealth();
  }, [subscribeOllamaHealth]);

  const lastMessageId = messages && messages.length > 0 ? messages[messages.length - 1]!.id : undefined;
  const lastMetrics = lastMessageId ? metricsByMessage[lastMessageId] : undefined;
  const tps = lastMetrics ? genTps(lastMetrics.promptTokens, lastMetrics.evalTokens, lastMetrics.evalMs) : undefined;

  // Un borrador define el próximo chat. Cuando hay uno abierto, su modelo persistido es el único
  // que puede representar al chat activo, aun mientras el listado todavía termina de cargar.
  const activeChat = chatId ? projectChats?.find((chat) => chat.id === chatId) : undefined;
  const activeModelRef = statusModelRef(chatId, projectChats, draftModelRef, messages ?? []);
  const awaitingAutomaticSelection = activeChat?.modelSelection === 'auto' && !activeModelRef;
  const contextUsed = lastMetrics?.promptTokens !== undefined && lastMetrics.evalTokens !== undefined
    ? lastMetrics.promptTokens + lastMetrics.evalTokens
    : undefined;
  const contextLimitSource = contextBudget?.contextLimitSource;
  const contextLabel = statusContextLabel(contextBudget, contextUsed);

  return (
    <footer className="saurio-statusbar" role="contentinfo" aria-label="Estado del runtime">
      {activeModelRef && (
        <span className="saurio-statusbar__item" title="Ubicación real del modelo activo">
          <span className={`saurio-badge ${activeModelRef.locality}`}>{localityLabel(activeModelRef.locality)}</span>
        </span>
      )}

      {awaitingAutomaticSelection && (
        <span className="saurio-statusbar__item saurio-mono" title="SaurioLLM elegirá un modelo local al ejecutar">
          <CpuIcon />
          Automático · se elegirá al ejecutar
        </span>
      )}

      {activeModelRef && (
        <span className="saurio-statusbar__item saurio-mono" title="Modelo activo">
          <CpuIcon />
          {activeModelRef.name}
        </span>
      )}

      <span className="saurio-statusbar__sep" aria-hidden="true" />

      <span className="saurio-statusbar__item" title={contextBudget
        ? contextLimitSource === 'reported'
          ? 'Contexto efectivo estimado del último armado de este chat'
          : 'Contexto efectivo estimado; el límite no fue confirmado por el modelo'
        : 'Contexto del último mensaje de este chat'}>
        {contextLabel}
      </span>

      <span className="saurio-statusbar__item" title="Tokens por segundo del último mensaje generado">
        <GaugeIcon />
        {tps !== undefined ? `${tps.toFixed(1)} tok/s` : '— tok/s'}
      </span>

      <span className="saurio-statusbar__spacer" />

      <span className="saurio-statusbar__item" title={startError ?? (ollamaOk === false ? 'provider:health respondió con error' : undefined)}>
        <PlugIcon />
        <span className={`saurio-statusbar__dot ${ollamaOk ? 'ok' : 'down'}`} aria-hidden="true" />
        {starting
          ? 'Iniciando motor local…'
          : ollamaOk === null ? 'Comprobando Ollama…' : ollamaOk ? 'Ollama conectado' : 'Ollama no conectado'}
      </span>
      {!starting && ollamaOk === false && (
        <button type="button" className="saurio-btn-ghost saurio-statusbar__start-ollama" onClick={() => void startOllama()}>
          Iniciar Ollama
        </button>
      )}
    </footer>
  );
}
