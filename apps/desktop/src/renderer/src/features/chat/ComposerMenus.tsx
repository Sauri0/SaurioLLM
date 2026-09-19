// Menús desplegables del compositor (rediseño del chat, punto 1): modo, potencia (Effort) y
// permisos del chat — "Todo compacto en una barra bajo el textarea, con menús desplegables, no una
// fila de controles sueltos". apps/desktop/src/renderer/src/features/chat/ComposerMenus.tsx.
import { useEffect, useRef, useState } from 'react';
import type { ChatPermissionPreset, Effort, Mode } from '@saurio/shared';
import { CHAT_PERMISSION_INFO } from './chatPermissionDisplay.js';
import { ChevronDownIcon } from '../../ui/icons.js';

/** Menú desplegable genérico: botón disparador + panel que se cierra solo (click afuera / Escape).
 *  Sin librería nueva — position:absolute simple, alcanza para 3 menúes chicos en una barra. */
function Dropdown({ trigger, children, disabled }: {
  trigger: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  disabled?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(ev: MouseEvent): void {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false);
    }
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="composer-menu" ref={ref}>
      <button
        type="button"
        className="composer-menu__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={disabled}
      >
        {trigger}
        <ChevronDownIcon width={10} height={10} />
      </button>
      {open && <div className="composer-menu__panel" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

function MenuOption({ active, title, description, risk, onClick }: {
  active: boolean;
  title: string;
  description: string;
  risk?: 'low' | 'medium' | 'high';
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className={`composer-menu__option${active ? ' composer-menu__option--active' : ''}`}
      onClick={onClick}
    >
      <span className="composer-menu__option-title">
        {risk && <span className={`composer-menu__risk-dot composer-menu__risk-dot--${risk}`} aria-hidden="true" />}
        {title}
      </span>
      <span className="composer-menu__option-desc">{description}</span>
    </button>
  );
}

const MODE_INFO: Record<Mode, { label: string; description: string }> = {
  plan: { label: 'Plan', description: 'Analiza y propone, no toca nada.' },
  agent: { label: 'Agente', description: 'Lee, edita y ejecuta según tus permisos.' },
  ask: { label: 'Preguntar', description: 'Responde preguntas puntuales, sin ejecutar cambios.' },
  edit: { label: 'Editar', description: 'Enfocado en editar archivos existentes.' },
};
// MVP (doc 06 §1): solo Plan/Agente tienen selector; Ask/Edit quedan tipados para v0.2 (ModeSelector.tsx).
const AVAILABLE_MODES: Mode[] = ['agent', 'plan'];

export function ModeMenu({ mode, disabled, onChange }: { mode: Mode; disabled?: boolean; onChange: (m: Mode) => void }): React.JSX.Element {
  const info = MODE_INFO[mode];
  return (
    <Dropdown disabled={disabled} trigger={<span className="composer-menu__trigger-label">{info.label}</span>}>
      {(close) => (
        <>
          <div className="composer-menu__heading">Modo</div>
          {AVAILABLE_MODES.map((m) => (
            <MenuOption
              key={m}
              active={m === mode}
              title={MODE_INFO[m].label}
              description={MODE_INFO[m].description}
              onClick={() => { onChange(m); close(); }}
            />
          ))}
        </>
      )}
    </Dropdown>
  );
}

const EFFORT_INFO: Record<Effort, { label: string; description: string }> = {
  fast: { label: 'Rápida', description: 'Respuestas más rápidas, con menos pasos de razonamiento.' },
  balanced: { label: 'Equilibrada', description: 'Equilibrio entre velocidad y profundidad (recomendado).' },
  deep: { label: 'Profunda', description: 'Más pasos de razonamiento: más lenta, pero más precisa.' },
};
const EFFORT_ORDER: Effort[] = ['fast', 'balanced', 'deep'];

export function EffortMenu({ effort, disabled, onChange }: { effort: Effort; disabled?: boolean; onChange: (e: Effort) => void }): React.JSX.Element {
  return (
    <Dropdown disabled={disabled} trigger={<span className="composer-menu__trigger-label">{EFFORT_INFO[effort].label}</span>}>
      {(close) => (
        <>
          <div className="composer-menu__heading">Potencia</div>
          {EFFORT_ORDER.map((e) => (
            <MenuOption
              key={e}
              active={e === effort}
              title={EFFORT_INFO[e].label}
              description={EFFORT_INFO[e].description}
              onClick={() => { onChange(e); close(); }}
            />
          ))}
        </>
      )}
    </Dropdown>
  );
}

const PERMISSION_ORDER: ChatPermissionPreset[] = ['ask', 'edit_in_folder', 'full_in_folder', 'unrestricted'];

export function PermissionMenu({ preset, effectiveLabel, effectiveDescription, disabled, onChange }: {
  preset: ChatPermissionPreset | undefined;
  effectiveLabel?: string;
  effectiveDescription?: string;
  disabled?: boolean;
  /** `confirmed` es `true` cuando el usuario ya confirmó el diálogo de "Sin límites" acá mismo — el
   *  caller lo reenvía tal cual a `chat:setPermissionPreset` (el handler lo exige para `unrestricted`). */
  onChange: (p: ChatPermissionPreset, confirmed?: boolean) => void;
}): React.JSX.Element {
  return (
    <Dropdown disabled={disabled} trigger={<span className="composer-menu__trigger-label" title={effectiveDescription}>{effectiveLabel ?? (preset ? CHAT_PERMISSION_INFO[preset].label : 'Permisos heredados')}</span>}>
      {(close) => (
        <>
          <div className="composer-menu__heading">{preset ? 'Permisos de este chat' : 'Permisos heredados · elegir un override'}</div>
          {effectiveDescription && <div className="composer-menu__option-desc">{effectiveDescription}</div>}
          {PERMISSION_ORDER.map((p) => (
            <MenuOption
              key={p}
              active={p === preset}
              title={CHAT_PERMISSION_INFO[p].label}
              description={CHAT_PERMISSION_INFO[p].description}
              risk={CHAT_PERMISSION_INFO[p].risk}
              onClick={() => {
                if (p === 'unrestricted') {
                  const confirmed = window.confirm(
                    'Vas a dar acceso SIN LÍMITES a este chat: puede leer, editar, borrar y ejecutar comandos ' +
                      'incluso fuera de la carpeta del proyecto, sin pedirte permiso.\n\n¿Confirmás?',
                  );
                  if (!confirmed) return;
                  onChange(p, true);
                  close();
                  return;
                }
                onChange(p);
                close();
              }}
            />
          ))}
        </>
      )}
    </Dropdown>
  );
}
