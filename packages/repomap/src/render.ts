// Render compacto del repo map + selección por presupuesto de tokens (doc 07 §2.3, §2.2 paso 6).
// Formato: un bloque de texto plano por archivo, "path:\n│ def foo(...)\n⋮" — sin JSON ni XML.
// Selección: búsqueda binaria sobre cuántos archivos (en orden de rank) entran completos en
// `budgetTokens`; si un archivo no entra completo, no entra (doc 07 §2.2 paso 6, mismo mecanismo
// que repomap.py de Aider). Los archivos sin grammar/tags van en un bloque final "otros archivos
// del proyecto", solo con su ruta (doc 07 §2.3).
import type { RankedFile } from './types.js';

/** Estimación barata de tokens (heurística ~4 chars/token en inglés/código; el TokenCounter
 *  calibrado real vive en packages/runtime — acá alcanza para la búsqueda binaria de selección,
 *  que solo necesita monotonicidad, no precisión exacta). */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Bloque de un archivo con símbolos: "path:\n│ name\n⋮\n│ name2\n". Las líneas no contiguas
 *  entre definiciones se separan con "⋮" (doc 07 §2.3). */
export function renderFileBlock(file: string, defs: { name: string; line: number }[]): string {
  const sorted = [...defs].sort((a, b) => a.line - b.line);
  const lines: string[] = [`${file}:`];
  let prevLine: number | null = null;
  for (const d of sorted) {
    if (prevLine !== null && d.line - prevLine > 1) lines.push('⋮');
    lines.push(`│ ${d.name}`);
    prevLine = d.line;
  }
  return `${lines.join('\n')}\n`;
}

/** "otros archivos del proyecto": ruta sola, sin cuerpo (doc 07 §2.3, archivos sin grammar). */
function renderFlatBlock(files: string[]): string {
  if (files.length === 0) return '';
  return `# otros archivos del proyecto\n${files.join('\n')}\n`;
}

export interface RenderResult {
  text: string;
  tokens: number;
}

/**
 * Selecciona por búsqueda binaria cuántos de los `ranked` (ya ordenados por PageRank desc) entran
 * completos en `budgetTokens`, y arma la salida: bloques con símbolos primero (uno por archivo,
 * todas las defs de un archivo antes de pasar al siguiente), después "otros archivos del
 * proyecto" con lo que sobre de presupuesto.
 */
export function renderRepoMap(ranked: RankedFile[], budgetTokens: number): RenderResult {
  if (budgetTokens <= 0 || ranked.length === 0) return { text: '', tokens: 0 };

  const withDefs = ranked.filter((r) => r.tags.some((t) => t.kind === 'def'));
  const withoutDefs = ranked.filter((r) => !r.tags.some((t) => t.kind === 'def'));

  const blocks = withDefs.map((r) =>
    renderFileBlock(
      r.file,
      r.tags.filter((t) => t.kind === 'def'),
    ),
  );

  // Prefijos acumulados (concatenación en orden de rank) para la búsqueda binaria: como el texto
  // solo crece al agregar archivos, el conteo de tokens es monótono no decreciente en k.
  const prefixText: string[] = [''];
  for (const b of blocks) prefixText.push((prefixText[prefixText.length - 1] ?? '') + b);

  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const tokens = estimateTokens(prefixText[mid] ?? '');
    if (tokens <= budgetTokens) lo = mid;
    else hi = mid - 1;
  }
  const k = lo;

  let text = prefixText[k] ?? '';
  let tokens = estimateTokens(text);

  // Con lo que sobra de presupuesto, agrega rutas planas (archivos sin defs / sin grammar).
  if (tokens < budgetTokens && withoutDefs.length > 0) {
    const flatPaths: string[] = [];
    for (const r of withoutDefs) {
      const candidate = renderFlatBlock([...flatPaths, r.file]);
      const candidateTokens = estimateTokens(text + candidate);
      if (candidateTokens > budgetTokens) break;
      flatPaths.push(r.file);
    }
    if (flatPaths.length > 0) {
      text = text + renderFlatBlock(flatPaths);
      tokens = estimateTokens(text);
    }
  }

  return { text, tokens };
}
