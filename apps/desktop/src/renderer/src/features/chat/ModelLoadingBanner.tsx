// Aviso "Cargando modelo… mm:ss" con Cancelar (tarea "carga de modelo/oom_load", punto 1) —
// apps/desktop/src/renderer/src/features/chat/ModelLoadingBanner.tsx.
//
// Ollama puede tardar más de un minuto en cargar un modelo grande antes de emitir el primer token
// (doc de la tarea: un usuario real vio la app "colgada" sin ninguna indicación de qué estaba
// pasando). El runtime no distingue "cargando" de "generando" como estados separados — ambos son
// `generating` (doc 05 §1) — así que acá se infiere: si el run está en un estado activo pero todavía
// no llegó NINGÚN `message.delta` de este run (`hasFirstChunk`), se muestra el cronómetro en vez del
// texto genérico "Generando"; apenas llega el primer chunk, el banner desaparece solo.
import { useEffect, useState } from 'react';
import type { RunState } from '@saurio/shared';
import './chat.css';

const LOADING_STATES = new Set<RunState>(['created', 'preparing', 'queued', 'generating']);

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const ss = (totalSeconds % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

export interface ModelLoadingBannerProps {
  runState: RunState | undefined;
  /** `runStore.runStartedAt[runId]` (ts del primer `run.state` visto de este run). */
  startedAt: number | undefined;
  /** `true` en cuanto llegó el primer `message.delta` de este run — a partir de ahí el banner se
   *  apaga solo (ya no está "cargando", está generando texto real). */
  hasFirstChunk: boolean;
  onCancel: () => void;
}

export function ModelLoadingBanner(
  { runState, startedAt, hasFirstChunk, onCancel }: ModelLoadingBannerProps,
): React.JSX.Element | null {
  const visible = runState !== undefined && LOADING_STATES.has(runState) && !hasFirstChunk && startedAt !== undefined;
  // Fuerza un re-render cada segundo mientras el banner está visible, para que el cronómetro avance
  // — el resto del componente es puro (`Date.now()` se recalcula en cada render, no en el estado).
  const [, tick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [visible]);

  if (!visible || startedAt === undefined) return null;

  return (
    <div className="model-loading-banner" role="status" aria-live="polite">
      <span className="model-loading-banner__spinner" aria-hidden="true" />
      <span>{runState === 'generating' ? 'Esperando la primera respuesta…' : runState === 'queued' ? 'En cola…' : 'Preparando el chat…'} {formatElapsed(Date.now() - startedAt)}</span>
      <button type="button" className="saurio-btn-ghost model-loading-banner__cancel" onClick={onCancel}>
        Cancelar
      </button>
    </div>
  );
}
