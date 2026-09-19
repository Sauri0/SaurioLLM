import type { Adjustment } from '@saurio/shared';

export interface RunAdjustmentsProps {
  adjustments: Adjustment[];
}

export function adjustmentsForRun(adjustmentsByRun: Record<string, Adjustment[]>, runId: string | undefined): Adjustment[] {
  return runId ? (adjustmentsByRun[runId] ?? []) : [];
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '—';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Ajustes efectivos de un único run; se muestra cerrado para no competir con Actividad. */
export function RunAdjustments({ adjustments }: RunAdjustmentsProps): React.JSX.Element | null {
  if (adjustments.length === 0) return null;

  return (
    <details className="saurio-row">
      <summary className="saurio-row__header">
        <span className="saurio-row__title">Ajustes de ejecución</span>
        <span className="saurio-row__meta">{adjustments.length}</span>
      </summary>
      {adjustments.map((adjustment, index) => (
        <div className="saurio-row__line" key={`${adjustment.param}-${index}`}>
          <span className="saurio-mono">{adjustment.param}</span>
          <span className="saurio-row__meta">Aplicado: {displayValue(adjustment.applied)}</span>
          <span className="saurio-row__meta">{adjustment.reason}</span>
        </div>
      ))}
    </details>
  );
}
