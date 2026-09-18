// Gráfico de línea simple en SVG propio (doc 14 §9: "gráficos simples propios en SVG", sin
// librería de charts) — apps/desktop/src/renderer/src/features/perf/Sparkline.tsx.
// Puramente de presentación: recibe valores ya numéricos (0-100 para porcentajes, o cualquier
// escala con `max` explícito) y dibuja una polyline. No calcula nada de calidad/medido-estimado —
// eso ya lo filtró quien arma `values` (PerfPanel).
export interface SparklineProps {
  values: number[];
  max?: number;
  width?: number;
  height?: number;
  color?: string;
  ariaLabel: string;
}

export function Sparkline({ values, max, width = 220, height = 36, color = 'var(--accent)', ariaLabel }: SparklineProps): React.JSX.Element {
  if (values.length < 2) {
    return <svg width={width} height={height} role="img" aria-label={ariaLabel} />;
  }
  const effectiveMax = max ?? Math.max(...values, 1);
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - (Math.min(v, effectiveMax) / effectiveMax) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const last = values[values.length - 1] ?? 0;
  const lastY = height - (Math.min(last, effectiveMax) / effectiveMax) * height;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width} cy={lastY} r={2.5} fill={color} />
    </svg>
  );
}
