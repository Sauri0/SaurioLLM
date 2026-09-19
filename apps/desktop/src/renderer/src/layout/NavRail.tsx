// Barra de navegación izquierda del rediseño de arquitectura de información (punto 1 del encargo):
// angosta, vertical, ícono + etiqueta SIEMPRE visible (nunca solo ícono) — cada ítem lleva a una
// sección a pantalla completa, ya no a una pestaña de un panel angosto. apps/desktop/src/renderer/src/layout/NavRail.tsx.
import type { ComponentType, SVGProps } from 'react';
import type { SectionId } from '../stores/uiNavStore.js';
import { HomeIcon, ChatIcon, CpuIcon, UserIcon, GaugeIcon, SettingsIcon } from '../ui/icons.js';

const ITEMS: { id: SectionId; label: string; icon: ComponentType<SVGProps<SVGSVGElement>>; shortcut: string }[] = [
  { id: 'inicio', label: 'Inicio', icon: HomeIcon, shortcut: 'Ctrl+1' },
  { id: 'chats', label: 'Chats', icon: ChatIcon, shortcut: 'Ctrl+2' },
  { id: 'modelos', label: 'Modelos', icon: CpuIcon, shortcut: 'Ctrl+3' },
  { id: 'agentes', label: 'Agentes', icon: UserIcon, shortcut: 'Ctrl+4' },
  { id: 'rendimiento', label: 'Rendimiento', icon: GaugeIcon, shortcut: 'Ctrl+5' },
  { id: 'ajustes', label: 'Ajustes', icon: SettingsIcon, shortcut: 'Ctrl+6' },
];

export interface NavRailProps {
  section: SectionId;
  onSelect: (section: SectionId) => void;
}

export function NavRail({ section, onSelect }: NavRailProps): React.JSX.Element {
  return (
    <nav className="saurio-nav-rail" aria-label="Navegación principal">
      {ITEMS.map(({ id, label, icon: Icon, shortcut }) => (
        <button
          key={id}
          type="button"
          className={`saurio-nav-item${section === id ? ' active' : ''}`}
          aria-current={section === id ? 'page' : undefined}
          title={`${label} (${shortcut})`}
          onClick={() => onSelect(id)}
        >
          <Icon width={19} height={19} />
          <span className="saurio-nav-item__label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
