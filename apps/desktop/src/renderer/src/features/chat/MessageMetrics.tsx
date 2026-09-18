// Métricas bajo cada mensaje (doc 14 §6/§9: tokens entrada/salida, tok/s, carga, cache — cada uno
// con su badge measured/estimated) — apps/desktop/src/renderer/src/features/chat/MessageMetrics.tsx.
import type { ResponseMetrics } from '@saurio/shared';

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

/** Doc 14 §4/§11: `quality` es la única etiqueta que trae `ResponseMetrics` (no hay una por campo);
 *  el badge measured/estimated/unavailable se muestra una vez para todo el bloque, como indica la
 *  fila "bajo cada mensaje" del doc 14 §6/§9 (Nota de consistencia: el `MetricSample<T>` por-campo
 *  de `packages/shared/src/telemetry.ts` que propone ese doc no existe en el contrato zod ya
 *  instalado — ver deviations). */
export function MessageMetrics({ metrics }: MessageMetricsProps): React.JSX.Element {
  const tps = genTps(metrics);
  const cache = cacheHitRatio(metrics);
  const load = fmtMs(metrics.loadMs);

  return (
    <div className={`message-metrics quality-${metrics.quality}`}>
      {metrics.promptTokens !== undefined && metrics.evalTokens !== undefined && (
        <span>{metrics.promptTokens} → {metrics.evalTokens} tok</span>
      )}
      {tps !== undefined && <span>{tps.toFixed(1)} tok/s</span>}
      {load && <span>carga {load}</span>}
      {cache !== undefined && <span>cache {(cache * 100).toFixed(0)}%</span>}
      {/* Punto 4 del encargo ("mostrar... costo 'no disponible' salvo que el proveedor lo informe"):
          ningún Provider del MVP (Ollama/OpenAI-compatible/Anthropic) devuelve costo en $, así que
          esto siempre muestra "no disponible" — no hay campo de costo que inventar un valor para. */}
      <span className="message-metrics__cost" title="Ningún proveedor del MVP informa costo en moneda">costo: no disponible</span>
      <span className="message-metrics__quality" title="Calidad del dato">
        {metrics.quality === 'measured' ? 'medido' : metrics.quality === 'estimated' ? 'estimado' : 'no disponible'}
      </span>
    </div>
  );
}
