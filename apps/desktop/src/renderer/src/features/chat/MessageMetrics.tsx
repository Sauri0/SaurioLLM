// Métricas al pie del mensaje final — rediseño del chat, punto 3: "fuera del flujo; un ícono 'i' o
// una línea tenue al pie del mensaje final que se expande (tokens, tok/s, carga, cache,
// medido/estimado)". Antes esta fila se veía SIEMPRE bajo cada mensaje del asistente, con un texto
// fijo "costo: no disponible" — la queja real v0.2.1 la señala explícitamente como parte de lo que
// hace ver "cargado" al chat. apps/desktop/src/renderer/src/features/chat/MessageMetrics.tsx.
import { useState } from 'react';
import type { ResponseMetrics } from '@saurio/shared';
import { formatUsd } from './costMetrics.js';
import './costMetrics.css';

export interface MessageMetricsProps {
  metrics: ResponseMetrics;
}

function fmtMs(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function genTps(m: ResponseMetrics): number | undefined {
  if (m.evalTokens === undefined || m.evalMs === undefined || m.evalMs <= 0) return undefined;
  return (m.evalTokens / m.evalMs) * 1000;
}

function cacheHitRatio(m: ResponseMetrics): number | undefined {
  if (m.cachedPromptTokens === undefined || m.promptTokens === undefined || m.promptTokens <= 0) return undefined;
  return m.cachedPromptTokens / m.promptTokens;
}

const QUALITY_LABEL: Record<ResponseMetrics['quality'], string> = {
  measured: 'medido', estimated: 'estimado', unavailable: 'no disponible',
};

/** Doc 14 §4/§11: `quality` es la única etiqueta que trae `ResponseMetrics` (no hay una por campo);
 *  se muestra una vez para todo el bloque. */
export function MessageMetrics({ metrics }: MessageMetricsProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const tps = genTps(metrics);
  const cache = cacheHitRatio(metrics);
  const load = fmtMs(metrics.loadMs);
  const tokens = metrics.promptTokens !== undefined && metrics.evalTokens !== undefined
    ? `${metrics.promptTokens} → ${metrics.evalTokens} tok`
    : undefined;

  return (
    <div className={`message-metrics-toggle quality-${metrics.quality}`}>
      <button
        type="button"
        className="message-metrics-toggle__button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Ver métricas de esta respuesta"
      >
        <span className="message-metrics-toggle__icon" aria-hidden="true">i</span>
        {tokens ?? 'métricas'}
      </button>
      {open && (
        <div className="message-metrics">
          {tokens && <span>{tokens}</span>}
          {tps !== undefined && <span>{tps.toFixed(1)} tok/s</span>}
          {load && <span>carga {load}</span>}
          {cache !== undefined && <span>cache {(cache * 100).toFixed(0)}%</span>}
          {metrics.costUsd !== undefined && metrics.costSource && metrics.costSource !== 'unavailable' && (
            <span className={`message-metrics__cost--${metrics.costSource}`}>
              {formatUsd(metrics.costUsd)} {metrics.costSource === 'reported' ? 'informado' : 'estimado'}
            </span>
          )}
          <span className="message-metrics__quality" title="Calidad del dato">{QUALITY_LABEL[metrics.quality]}</span>
        </div>
      )}
    </div>
  );
}
