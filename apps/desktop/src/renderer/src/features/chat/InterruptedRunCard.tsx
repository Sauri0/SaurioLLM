// Tarjeta de run interrumpido con recover (doc 05 §1 `run.recovered`, doc 04 §16 `run:continue`)
// — apps/desktop/src/renderer/src/features/chat/InterruptedRunCard.tsx.
import type { InterruptedInfo } from '../../stores/runStore.js';

export interface InterruptedRunCardProps {
  info: InterruptedInfo;
  onRecover: (runId: string) => Promise<void>;
  onDismiss: (runId: string) => void;
  busy?: boolean;
  recoverError?: string;
}

/** doc 05 §1: `executing_tool -> interrupted` marca tool calls `running -> orphaned` y
 *  `pending/approved -> abandoned`. La tarjeta ofrece reanudar (`run:continue`, que crea un run
 *  nuevo, doc 05 nota de `interrupted --> [*]`) o descartar el aviso sin reanudar. */
export function InterruptedRunCard({ info, onRecover, onDismiss, busy = false, recoverError }: InterruptedRunCardProps): React.JSX.Element {
  return (
    <div className="interrupted-run-card">
      <p className="interrupted-run-card__title">Esta ejecución se interrumpió (la app se cerró o se reinició).</p>
      {info.orphaned.length > 0 && (
        <p>{info.orphaned.length} acción(es) quedaron en curso sin confirmar su resultado.</p>
      )}
      {info.abandoned.length > 0 && (
        <p>{info.abandoned.length} acción(es) pendientes se abandonaron sin ejecutarse.</p>
      )}
      {recoverError && <p className="interrupted-run-card__error" role="alert">No se pudo reanudar: {recoverError}</p>}
      <div className="interrupted-run-card__actions">
        <button type="button" onClick={() => void onRecover(info.runId)} disabled={busy}>
          {busy ? 'Reanudando…' : 'Reanudar'}
        </button>
        <button type="button" onClick={() => onDismiss(info.runId)} disabled={busy}>Descartar</button>
      </div>
    </div>
  );
}
