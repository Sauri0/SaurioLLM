// Selector de modo plan/agent (doc 06 §1: MVP = plan y agent; ask/edit quedan tipados para v0.2)
// — apps/desktop/src/renderer/src/features/chat/ModeSelector.tsx.
import type { Mode } from '@saurio/shared';

const MVP_MODES: Mode[] = ['plan', 'agent'];
const MODE_LABEL: Record<Mode, string> = { plan: 'Plan', ask: 'Preguntar', edit: 'Editar', agent: 'Agente' };

export interface ModeSelectorProps {
  mode: Mode;
  disabled?: boolean;
  onChange: (mode: Mode) => void;
}

/** `ask`/`edit` (doc 06 §1, tabla de modos) no tienen selector en el MVP — quedan como valores
 *  válidos del enum `Mode` (packages/shared/src/enums.ts) para que el tipo no cambie en v0.2, pero
 *  esta UI solo ofrece los dos modos del hito 1. */
export function ModeSelector({ mode, disabled, onChange }: ModeSelectorProps): React.JSX.Element {
  return (
    <div className="mode-selector" role="radiogroup" aria-label="Modo del agente">
      {MVP_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          className={`mode-selector__option${mode === m ? ' mode-selector__option--active' : ''}`}
          disabled={disabled}
          onClick={() => onChange(m)}
        >
          {MODE_LABEL[m]}
        </button>
      ))}
    </div>
  );
}
