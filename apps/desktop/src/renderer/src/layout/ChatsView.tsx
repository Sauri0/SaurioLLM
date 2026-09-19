// Sección "Chats" (punto 2 del encargo de rediseño): columna de proyecto + chats a la izquierda,
// conversación al centro y panel contextual (Archivos/Cambios/Terminal) a la derecha, colapsable y
// de ancho ajustable. apps/desktop/src/renderer/src/layout/ChatsView.tsx.
//
// Reemplaza el `<main className="saurio-main">` + `<RightPanel>` fijos que antes vivían sueltos en
// AppLayout.tsx: agrupa esas dos piezas más la barra lateral (`Sidebar.tsx`) bajo una sola sección de
// la navegación principal, y agrega lo que pedía el encargo: ocultar el panel contextual, arrastrar
// para cambiar su ancho.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '@saurio/shared';
import { Sidebar } from './Sidebar.js';
import { ChatCenter } from './ChatCenter.js';
import { RightPanel, ContextPanelRail } from './RightPanel.js';
import { useUiNavStore, CONTEXT_WIDTH_MIN, CONTEXT_WIDTH_MAX } from '../stores/uiNavStore.js';

export interface ChatsViewProps {
  project: Project | null;
  onProjectChange: (project: Project) => void;
  activeChatId: string | null;
  onSelectChat: (chatId: string) => void;
}

export function ChatsView({ project, onProjectChange, activeChatId, onSelectChat }: ChatsViewProps): React.JSX.Element {
  const [compactPane, setCompactPane] = useState<'sidebar' | 'chat' | 'context'>('chat');
  const [isCompact, setIsCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches);
  const contextOpen = useUiNavStore((s) => s.contextOpen);
  const contextWidth = useUiNavStore((s) => s.contextWidth);
  const setContextWidth = useUiNavStore((s) => s.setContextWidth);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const update = (): void => setIsCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  // Arrastrar el borde izquierdo del panel contextual para cambiar su ancho (punto 2 del encargo:
  // "ancho redimensionable"). El panel está pegado al borde derecho de la ventana, así que achicar X
  // agranda el panel — de ahí el signo invertido respecto de un panel a la izquierda.
  const handlePointerMove = useCallback((ev: PointerEvent) => {
    if (!dragState.current) return;
    const delta = dragState.current.startX - ev.clientX;
    setContextWidth(Math.min(CONTEXT_WIDTH_MAX, Math.max(CONTEXT_WIDTH_MIN, dragState.current.startWidth + delta)));
  }, [setContextWidth]);

  const handlePointerUp = useCallback(() => {
    dragState.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    document.body.classList.remove('saurio-resizing');
  }, [handlePointerMove]);

  function handleResizeStart(ev: React.PointerEvent<HTMLDivElement>): void {
    dragState.current = { startX: ev.clientX, startWidth: contextWidth };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    document.body.classList.add('saurio-resizing');
  }

  function showContextPane(): void {
    setCompactPane('context');
  }

  const showContext = isCompact ? compactPane === 'context' : contextOpen;

  function handleCompactTabKey(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const current = tabs.indexOf(event.currentTarget);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
    tabs[next]?.click();
  }

  return (
    <div className={`saurio-chats-view saurio-chats-view--compact-${compactPane}`}>
      <div className="saurio-compact-tabs" role="tablist" aria-label="Vistas del chat">
        <button type="button" role="tab" tabIndex={compactPane === 'sidebar' ? 0 : -1} aria-selected={compactPane === 'sidebar'} onKeyDown={handleCompactTabKey} onClick={() => setCompactPane('sidebar')}>Proyecto y chats</button>
        <button type="button" role="tab" tabIndex={compactPane === 'chat' ? 0 : -1} aria-selected={compactPane === 'chat'} onKeyDown={handleCompactTabKey} onClick={() => setCompactPane('chat')}>Chat</button>
        <button type="button" role="tab" tabIndex={compactPane === 'context' ? 0 : -1} aria-selected={compactPane === 'context'} onKeyDown={handleCompactTabKey} onClick={showContextPane}>Archivos y más</button>
      </div>
      <Sidebar
        project={project}
        onProjectChange={(next) => { setCompactPane('chat'); onProjectChange(next); }}
        activeChatId={activeChatId}
        onSelectChat={(chatId) => { setCompactPane('chat'); onSelectChat(chatId); }}
      />
      <main className="saurio-main">
        <ChatCenter
          project={project}
          onProjectChange={onProjectChange}
          onSelectChat={onSelectChat}
          // El diff en sí vive en la pestaña "Cambios" del panel contextual (features/diff): abrir un
          // diff desde el chat es equivalente a mirar los checkpoints de ese chat ahí.
          onOpenDiff={() => { /* la pestaña "Cambios" del panel contextual ya lista los checkpoints del chat */ }}
        />
      </main>
      {showContext ? (
        <>
          <div
            className="saurio-context-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Cambiar el ancho del panel contextual"
            onPointerDown={handleResizeStart}
          />
          <RightPanel projectId={project?.id ?? null} chatId={activeChatId} onClose={() => {
            if (isCompact) setCompactPane('chat');
            else useUiNavStore.getState().setContextOpen(false);
          }} />
        </>
      ) : (
        <ContextPanelRail />
      )}
    </div>
  );
}
