// Sección "Chats" (punto 2 del encargo de rediseño): columna de proyecto + chats a la izquierda,
// conversación al centro y panel contextual (Archivos/Cambios/Terminal) a la derecha, colapsable y
// de ancho ajustable. apps/desktop/src/renderer/src/layout/ChatsView.tsx.
//
// Reemplaza el `<main className="saurio-main">` + `<RightPanel>` fijos que antes vivían sueltos en
// AppLayout.tsx: agrupa esas dos piezas más la barra lateral (`Sidebar.tsx`) bajo una sola sección de
// la navegación principal, y agrega lo que pedía el encargo: ocultar el panel contextual, arrastrar
// para cambiar su ancho.
import { useCallback, useRef } from 'react';
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
  const contextOpen = useUiNavStore((s) => s.contextOpen);
  const contextWidth = useUiNavStore((s) => s.contextWidth);
  const setContextWidth = useUiNavStore((s) => s.setContextWidth);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

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

  return (
    <div className="saurio-chats-view">
      <Sidebar
        project={project}
        onProjectChange={onProjectChange}
        activeChatId={activeChatId}
        onSelectChat={onSelectChat}
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
      {contextOpen ? (
        <>
          <div
            className="saurio-context-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Cambiar el ancho del panel contextual"
            onPointerDown={handleResizeStart}
          />
          <RightPanel projectId={project?.id ?? null} chatId={activeChatId} />
        </>
      ) : (
        <ContextPanelRail />
      )}
    </div>
  );
}
