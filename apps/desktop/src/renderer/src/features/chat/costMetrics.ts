import type { ResponseMetrics } from '@saurio/shared';

export interface CostBreakdown {
  reportedUsd: number;
  estimatedUsd: number;
  reportedResponses: number;
  estimatedResponses: number;
  unavailableResponses: number;
}

/** Agrupa sólo importes que llegaron con fuente explícita. La ausencia de un campo de versiones
 * anteriores sigue siendo desconocida: no se incorpora como USD 0. */
export function summarizeCosts(metrics: readonly ResponseMetrics[]): CostBreakdown {
  return metrics.reduce<CostBreakdown>((summary, metric) => {
    if (metric.costUsd === undefined || metric.costSource === undefined || metric.costSource === 'unavailable') {
      summary.unavailableResponses += 1;
    } else if (metric.costSource === 'reported') {
      summary.reportedUsd += metric.costUsd;
      summary.reportedResponses += 1;
    } else {
      summary.estimatedUsd += metric.costUsd;
      summary.estimatedResponses += 1;
    }
    return summary;
  }, { reportedUsd: 0, estimatedUsd: 0, reportedResponses: 0, estimatedResponses: 0, unavailableResponses: 0 });
}

export function formatUsd(value: number): string {
  const rendered = value.toFixed(8).replace(/(?:\.0+|(?:(\.\d*?[1-9]))0+)$/, '$1');
  return `USD ${rendered}`;
}
