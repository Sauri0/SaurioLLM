// Aviso único y discreto de "modelo chico para modo Agente" — rediseño del chat, punto 6
// (feedback real v0.2.1, punto 10: "modelo chico (< ~7B) en modo agente"). `run.smallModelWarning`
// llega UNA sola vez por run (runStore.smallModelWarningByRun); se muestra plegado en el flujo, no
// como un banner de error, con enlace directo a la sección Modelos.
// apps/desktop/src/renderer/src/features/chat/SmallModelWarningBanner.tsx.
import { useState } from 'react';
import { useUiNavStore } from '../../stores/uiNavStore.js';
import { AlertIcon, CloseIcon } from '../../ui/icons.js';
import './chat.css';

export interface SmallModelWarningBannerProps {
  modelName: string;
  parameterSize: string | undefined;
}

export function SmallModelWarningBanner({ modelName, parameterSize }: SmallModelWarningBannerProps): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  const setSection = useUiNavStore((s) => s.setSection);
  if (dismissed) return null;

  return (
    <div className="small-model-warning" role="status">
      <AlertIcon width={13} height={13} />
      <span>
        {modelName}{parameterSize ? ` (${parameterSize})` : ''} es un modelo chico para modo Agente — puede tener
        problemas siguiendo instrucciones o usando herramientas.{' '}
        <button type="button" className="small-model-warning__link" onClick={() => setSection('modelos')}>
          Ver modelos
        </button>
      </span>
      <button type="button" className="small-model-warning__dismiss" aria-label="Cerrar aviso" onClick={() => setDismissed(true)}>
        <CloseIcon width={11} height={11} />
      </button>
    </div>
  );
}
