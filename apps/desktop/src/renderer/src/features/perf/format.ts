// Helpers de formato puro para el panel de Rendimiento (doc 14 §4 "Modelo de métrica": todo
// número lleva su `quality`). apps/desktop/src/renderer/src/features/perf/format.ts.
import type { Metric } from '@saurio/shared';

export function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function metricBadgeClass(quality: Metric<unknown>['quality']): string {
  return quality;
}
