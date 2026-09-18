// Panel derecho con pestañas Archivos / Diff / Terminal / Modelos / Rendimiento / Ajustes
// (doc 02 §1 y §2, doc 01 §4.1 "Paneles del MVP"). apps/desktop/src/renderer/src/layout/RightPanel.tsx.
//
// Pasada de diseño #3: las 6 pestañas con su nombre completo no entraban en los 380px del panel
// (`--right-panel-width`) y la barra hacía scroll horizontal — "Ajustes" quedaba fuera de vista.
// Ahora cada pestaña es ícono + etiqueta corta, todas con `flex: 1` (`theme.css` .saurio-tabs), así
// entran siempre las 6 sin scroll: si el texto no entra, se recorta con ellipsis pero el ícono y el
// estado activo/seleccionado siguen visibles (el `title` conserva el nombre completo).
import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { useUiNavStore } from '../stores/uiNavStore.js';
import type { SVGProps } from 'react';
import { FilesPanel } from '../features/files/index.js';
import { DiffPanel } from '../features/diff/index.js';
import { ModelsPanel } from '../features/models/index.js';
import { PerfPanel } from '../features/perf/index.js';
import { SettingsPanel } from '../features/settings/index.js';

// Punto 7 del encargo (code-splitting): `@xterm/xterm` no tiene por qué ir en el chunk inicial del
// renderer si el usuario nunca abre la pestaña Terminal — mismo criterio que `FileViewer` (CodeMirror)
// en `features/files/FilesPanel.tsx`.
const TerminalPanel = lazy(() => import('../features/terminal/index.js').then((m) => ({ default: m.TerminalPanel })));
import { FileIcon, GitBranchIcon, TerminalIcon, CpuIcon, GaugeIcon, SettingsIcon } from '../ui/icons.js';
import { getDemoRightPanelTab } from '../demo/demoState.js';

type Tab = 'Archivos' | 'Diff' | 'Terminal' | 'Modelos' | 'Rendimiento' | 'Ajustes';

const TAB_IDS: Tab[] = ['Archivos', 'Diff', 'Terminal', 'Modelos', 'Rendimiento', 'Ajustes'];

function initialTab(): Tab {
  const requested = getDemoRightPanelTab();
  return (TAB_IDS as string[]).includes(requested ?? '') ? (requested as Tab) : 'Archivos';
}

// `label` es lo que se ve en la pestaña ACTIVA (icono + texto, doc de la pasada de diseño #3): a
// 380px / 6 pestañas hay ~60px por pestaña, así que va abreviado; `fullLabel` es el nombre completo,
// siempre disponible como `title` (tooltip) en cualquier pestaña, activa o no.
const TABS: { id: Tab; label: string; fullLabel: string; icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: 'Archivos', label: 'Arch.', fullLabel: 'Archivos', icon: FileIcon },
  { id: 'Diff', label: 'Diff', fullLabel: 'Diff', icon: GitBranchIcon },
  { id: 'Terminal', label: 'Term.', fullLabel: 'Terminal', icon: TerminalIcon },
  { id: 'Modelos', label: 'Mod.', fullLabel: 'Modelos', icon: CpuIcon },
  { id: 'Rendimiento', label: 'Rend.', fullLabel: 'Rendimiento', icon: GaugeIcon },
  { id: 'Ajustes', label: 'Ajus.', fullLabel: 'Ajustes', icon: SettingsIcon },
];

export interface RightPanelProps {
  projectId: string | null;
  chatId: string | null;
}

export function RightPanel({ projectId, chatId }: RightPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab);
  const requestedTab = useUiNavStore((s) => s.requestedTab);
  const clearRequestedTab = useUiNavStore((s) => s.clearRequestedTab);

  // Navegación pedida desde afuera del panel (doc del asistente de primer arranque, punto 5:
  // "Tengo una clave de API" lleva a Ajustes > Proveedores) — ver stores/uiNavStore.ts.
  useEffect(() => {
    if (requestedTab && (TAB_IDS as string[]).includes(requestedTab)) {
      setTab(requestedTab as Tab);
      clearRequestedTab();
    }
  }, [requestedTab, clearRequestedTab]);

  return (
    <section className="saurio-right-panel" aria-label="Panel de proyecto">
      <div className="saurio-tabs" role="tablist">
        {TABS.map(({ id, label, fullLabel, icon: Icon }) => (
          <div
            key={id}
            role="tab"
            aria-selected={tab === id}
            title={fullLabel}
            className={`saurio-tab${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon width={14} height={14} />
            <span className="saurio-tab__label">{label}</span>
          </div>
        ))}
      </div>
      <div className="saurio-tab-body">
        {tab === 'Archivos' && <FilesPanel projectId={projectId} />}
        {tab === 'Diff' && <DiffPanel chatId={chatId} />}
        {tab === 'Terminal' && (
          <Suspense fallback={<p className="saurio-empty">Cargando terminal…</p>}>
            <TerminalPanel projectId={projectId} />
          </Suspense>
        )}
        {tab === 'Modelos' && <ModelsPanel />}
        {tab === 'Rendimiento' && <PerfPanel />}
        {tab === 'Ajustes' && <SettingsPanel />}
      </div>
    </section>
  );
}
