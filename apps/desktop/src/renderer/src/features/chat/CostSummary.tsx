import type { ResponseMetrics } from '@saurio/shared';
import { formatUsd, summarizeCosts } from './costMetrics.js';
import './costMetrics.css';

export interface CostSummaryProps {
  /** Métricas de las respuestas pertenecientes al chat o la sesión que monta el componente. */
  metrics: readonly ResponseMetrics[];
  scopeLabel?: string;
}

/** Resumen apto para ChatPanel: conserva separado lo informado, estimado y desconocido para que un
 * subtotal parcial no parezca la factura del chat. */
export function CostSummary({ metrics, scopeLabel = 'chat' }: CostSummaryProps): React.JSX.Element | null {
  const summary = summarizeCosts(metrics);
  if (summary.reportedResponses === 0 && summary.estimatedResponses === 0 && summary.unavailableResponses === 0) return null;

  return (
    <aside className="cost-summary" aria-label={`Costo del ${scopeLabel}`}>
      <span className="cost-summary__label" title="Subtotal de las respuestas visibles de este chat. El registro en Ajustes incluye también compactación y otros agentes.">Respuestas del {scopeLabel}</span>
      {summary.reportedResponses > 0 && (
        <span>Informado: {formatUsd(summary.reportedUsd)} ({summary.reportedResponses} respuesta{summary.reportedResponses === 1 ? '' : 's'})</span>
      )}
      {summary.estimatedResponses > 0 && (
        <span>Estimado: {formatUsd(summary.estimatedUsd)} ({summary.estimatedResponses} respuesta{summary.estimatedResponses === 1 ? '' : 's'})</span>
      )}
      {summary.unavailableResponses > 0 && (
        <span className="cost-summary__unknown">Sin costo informado: {summary.unavailableResponses} respuesta{summary.unavailableResponses === 1 ? '' : 's'}</span>
      )}
    </aside>
  );
}
