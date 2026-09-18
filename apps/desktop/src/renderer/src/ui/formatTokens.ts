// Formato compacto de tokens de contexto ("3.3k / 8k" en vez de "3.306 / 40.960") — pasada de
// diseño #4/#5: la barra de estado y el compositor muestran el mismo par (usado, máximo) y tienen
// que coincidir. apps/desktop/src/renderer/src/ui/formatTokens.ts.
//
// Dos redondeos distintos a propósito: el valor "usado" crece token a token dentro de la misma
// respuesta (un decimal ayuda a notar el avance); el "máximo" es un num_ctx configurado, siempre
// un número redondo en la práctica (8192, 40960…), así que se muestra sin decimales ("8k").
export function formatContextUsed(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '—';
  if (tokens < 1000) return String(Math.round(tokens));
  const thousands = Math.round(tokens / 100) / 10;
  return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
}

export function formatContextMax(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '—';
  if (tokens < 1000) return String(Math.round(tokens));
  return `${Math.round(tokens / 1000)}k`;
}

/** Par completo "usado / máximo", o solo "usado" si no se conoce el máximo del modelo todavía. */
export function formatContextPair(used: number | undefined, max: number | undefined): string | undefined {
  if (used === undefined) return undefined;
  return max ? `${formatContextUsed(used)} / ${formatContextMax(max)}` : formatContextUsed(used);
}
