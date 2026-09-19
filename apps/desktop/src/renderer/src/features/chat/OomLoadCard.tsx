// Tarjeta de "el modelo no entró en la memoria del equipo" (RunError.code === 'oom_load', doc de la
// tarea "carga de modelo/oom_load") — apps/desktop/src/renderer/src/features/chat/OomLoadCard.tsx.
//
// Aparece cuando un run terminó `failed` con `oom_load`: RunController (packages/runtime/src/agent)
// ya reintentó automáticamente bajando `numGpu` (~75% -> ~50% -> 0 = CPU pura, ver
// RunController.handleOomLoad) antes de rendirse, así que llegar acá significa que ni siquiera con
// CPU entró (o que el equipo no tiene forma de saber cuántas capas tiene el modelo). Dos acciones:
// "Elegir otro modelo" (abre la pestaña Modelos) y "Reintentar" (crea un run nuevo con `run:continue`
// — útil si mientras tanto se liberó memoria, p. ej. cerrando otra app; vuelve a correr la misma
// escalera automática desde el principio).
import type { RunError } from '@saurio/shared';
import { useUiNavStore } from '../../stores/uiNavStore.js';

export interface OomLoadCardProps {
  runId: string;
  error: RunError;
  modelName: string | undefined;
  onRetry: (runId: string) => Promise<void>;
  busy?: boolean;
  retryError?: string;
}

export function OomLoadCard({ runId, error, modelName, onRetry, busy = false, retryError }: OomLoadCardProps): React.JSX.Element {
  return (
    <div className="oom-load-card" role="alert">
      <p className="oom-load-card__title">
        El modelo{modelName ? ` (${modelName})` : ''} no entró en la memoria de tu equipo.
      </p>
      <p className="oom-load-card__detail">{error.message}</p>
      {retryError && <p className="oom-load-card__error" role="alert">No se pudo reintentar: {retryError}</p>}
      <div className="oom-load-card__actions">
        <button
          type="button"
          className="saurio-btn-ghost"
          onClick={() => useUiNavStore.getState().requestTab('Modelos')}
        >
          Elegir otro modelo
        </button>
        <button
          type="button"
          className="saurio-btn-primary"
          onClick={() => void onRetry(runId)}
          disabled={busy}
          title="Vuelve a intentar desde 0: primero con ~75% de las capas en GPU, después ~50%, por último solo CPU"
        >
          {busy ? 'Reintentando…' : 'Reintentar con menos capas en GPU'}
        </button>
      </div>
    </div>
  );
}
