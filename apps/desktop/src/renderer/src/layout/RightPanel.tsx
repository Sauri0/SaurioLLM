// Panel CONTEXTUAL de la vista Chats: Archivos / Cambios / Terminal (punto 2 del encargo de
// rediseño) — apps/desktop/src/renderer/src/layout/RightPanel.tsx.
//
// Antes este archivo era el panel derecho de TODA la app, angosto (380px) y con siete pestañas
// (Archivos, Diff, Terminal, Modelos, Agentes, Rendimiento, Ajustes) — con etiquetas abreviadas
// ("Arch.", "Mod.", "Ag.") porque no entraban todas juntas, que es exactamente lo que reportó un
// usuario real de la v0.2.0 ("todo junto a la derecha... muchas cosas muy compactas"). Modelos,
// Agentes, Rendimiento y Ajustes ahora son secciones a pantalla completa de la barra de navegación
// izquierda (`layout/NavRail.tsx`, `layout/AppLayout.tsx`) — acá solo queda lo que ACOMPAÑA a un
// chat puntual, con nombre completo (nunca abreviado), colapsable y de ancho ajustable.
import { lazy, Suspense } from 'react';
import { useUiNavStore, type ContextTabId } from '../stores/uiNavStore.js';
import { FilesPanel } from '../features/files/index.js';
import { DiffPanel } from '../features/diff/index.js';
import { FileIcon, GitBranchIcon, TerminalIcon, PanelRightIcon, CloseIcon } from '../ui/icons.js';

// Punto 7 del encargo original (code-splitting), sin cambios de comportamiento: `@xterm/xterm` no
// tiene por qué ir en el chunk inicial del renderer si el usuario nunca abre la pestaña Terminal.
const TerminalPanel = lazy(() => import('../features/terminal/index.js').then((m) => ({ default: m.TerminalPanel })));

const TABS: { id: ContextTabId; icon: typeof FileIcon }[] = [
  { id: 'Archivos', icon: FileIcon },
  { id: 'Cambios', icon: GitBranchIcon },
  { id: 'Terminal', icon: TerminalIcon },
];

export interface RightPanelProps {
  projectId: string | null;
  chatId: string | null;
}

/** Franja angosta que reemplaza al panel cuando está oculto (punto 2: "botón para ocultarlo") — un
 *  único botón vertical para volver a mostrarlo, siempre visible para que no sea un panel "perdido". */
export function ContextPanelRail(): React.JSX.Element {
  const setContextOpen = useUiNavStore((s) => s.setContextOpen);
  return (
    <button
      type="button"
      className="saurio-context-rail"
      title="Mostrar panel de archivos, cambios y terminal"
      onClick={() => setContextOpen(true)}
    >
      <PanelRightIcon width={16} height={16} />
    </button>
  );
}

export function RightPanel({ projectId, chatId }: RightPanelProps): React.JSX.Element {
  const tab = useUiNavStore((s) => s.contextTab);
  const setTab = useUiNavStore((s) => s.setContextTab);
  const setContextOpen = useUiNavStore((s) => s.setContextOpen);
  const width = useUiNavStore((s) => s.contextWidth);

  return (
    <section className="saurio-right-panel" aria-label="Panel de archivos, cambios y terminal" style={{ width }}>
      <div className="saurio-tabs" role="tablist">
        {TABS.map(({ id, icon: Icon }) => (
          <div
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`saurio-tab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon width={15} height={15} />
            <span className="saurio-tab__label">{id}</span>
          </div>
        ))}
        <button
          type="button"
          className="saurio-context-panel__close"
          title="Ocultar panel"
          onClick={() => setContextOpen(false)}
        >
          <CloseIcon width={14} height={14} />
        </button>
      </div>
      <div className="saurio-tab-body">
        {tab === 'Archivos' && <FilesPanel projectId={projectId} />}
        {tab === 'Cambios' && <DiffPanel chatId={chatId} />}
        {tab === 'Terminal' && (
          <Suspense fallback={<p className="saurio-empty">Cargando terminal…</p>}>
            <TerminalPanel projectId={projectId} />
          </Suspense>
        )}
      </div>
    </section>
  );
}
