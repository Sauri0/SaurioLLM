// Matching en cascada para edit_file(old_string, new_string) — packages/runtime/src/tools/matching.ts.
// Define: columna vertebral §1.2 fila "Formato de edición" y doc 09 §"Imprescindible para el MVP"
// ("matching en cascada exact/eol/indent/whitespace/fuzzy con match_level" — MatchLevel en
// @saurio/shared/enums.ts). El algoritmo concreto de cada nivel no está detallado letra por letra en
// los documentos de arquitectura; se implementa con la técnica estándar de "búsqueda tolerante" descrita
// en la columna vertebral (aider polyglot: whole > diff en modelos chicos) — ver deviations.
import type { MatchLevel } from '@saurio/shared';

export interface MatchResult {
  level: MatchLevel;
  /** Offsets sobre el `content` original (no normalizado) que hay que reemplazar. */
  start: number;
  end: number;
}

export interface MatchFailure {
  level: null;
  occurrences: number;   // cuántas veces matcheó el nivel más permisivo que sí encontró algo (0 = ninguno)
  reason: string;
  /** Doc 16 §4 ítem 6 ("edit_file ambiguo devuelve las coincidencias numeradas"): línea (1-based) y
   *  una vista previa de cada ocurrencia, para que el modelo pueda agregar contexto sin adivinar
   *  cuál de las coincidencias es la que quiere tocar. También orienta cuando sólo existe una
   *  coincidencia aproximada que no es segura para reemplazar automáticamente. */
  candidates?: { line: number; preview: string }[];
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

/** Quita indentación común de cada línea (mínimo de espacios/tabs iniciales entre las líneas no vacías). */
function stripCommonIndent(s: string): string {
  const lines = s.split('\n');
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const m = /^[ \t]*/.exec(line);
    min = Math.min(min, m ? m[0].length : 0);
  }
  if (!isFinite(min)) min = 0;
  return lines.map((l) => l.slice(Math.min(min, l.length))).join('\n');
}

function normalizeWhitespace(s: string): string {
  return s
    .split('\n')
    .map((l) => l.trim().replace(/[ \t]+/g, ' '))
    .join('\n')
    .trim();
}

/** Línea 1-based que contiene el offset `at` en `content` (doc 16 §4 ítem 6: coincidencias numeradas). */
function lineNumberAt(content: string, at: number): number {
  let line = 1;
  const end = Math.min(at, content.length);
  for (let i = 0; i < end; i++) if (content[i] === '\n') line++;
  return line;
}

function previewAt(content: string, at: number, maxLen = 80): string {
  const lineStart = content.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
  let lineEnd = content.indexOf('\n', at);
  if (lineEnd === -1) lineEnd = content.length;
  const text = content.slice(lineStart, lineEnd).trim();
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function candidatesFromOffsets(content: string, offsets: number[]): { line: number; preview: string }[] {
  return offsets.map((offset) => ({ line: lineNumberAt(content, offset), preview: previewAt(content, offset) }));
}

function candidatesFromLineRanges(contentLines: string[], hits: { startLine: number; endLine: number }[]): { line: number; preview: string }[] {
  return hits.map((h) => ({ line: h.startLine + 1, preview: (contentLines[h.startLine] ?? '').trim() }));
}

function findAllExact(haystack: string, needle: string): number[] {
  if (needle === '') return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    out.push(idx);
    from = idx + Math.max(needle.length, 1);
  }
  return out;
}

/** Levenshtein normalizado (0 = idéntico, 1 = totalmente distinto), para el nivel `fuzzy`. */
function levenshteinRatio(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0 && n === 0) return 0;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        (dp[j] ?? 0) + 1,
        (dp[j - 1] ?? 0) + 1,
        prevDiag + cost,
      );
      prevDiag = temp;
    }
  }
  const dist = dp[n] ?? Math.max(m, n);
  return dist / Math.max(m, n, 1);
}

/** Busca `needle` en `content` probando, en orden, exact -> eol -> indent -> whitespace -> fuzzy.
 *  Solo acepta un match único (si un nivel matchea más de una vez, se considera ambiguo y se sigue
 *  probando el próximo nivel más estricto en normalización pero más laxo en tolerancia; si ningún
 *  nivel produce un match único, devuelve `MatchFailure`). */
export function matchCascade(content: string, needle: string): MatchResult | MatchFailure {
  if (needle === '') return { level: null, occurrences: 0, reason: 'old_string vacío' };

  // 1) exact
  {
    const hits = findAllExact(content, needle);
    if (hits.length === 1) {
      const start = hits[0] as number;
      return { level: 'exact', start, end: start + needle.length };
    }
    if (hits.length > 1) {
      return {
        level: null, occurrences: hits.length,
        reason: 'old_string ambiguo (match exacto múltiple); agregá más contexto',
        candidates: candidatesFromOffsets(content, hits),
      };
    }
  }

  // 2) eol: normaliza CRLF -> LF de ambos lados antes de buscar
  {
    const nContent = normalizeEol(content);
    const nNeedle = normalizeEol(needle);
    const hits = findAllExact(nContent, nNeedle);
    if (hits.length === 1) {
      const span = mapNormalizedSpanToOriginal(content, nContent, hits[0] as number, nNeedle.length);
      if (span) return { level: 'eol', start: span.start, end: span.end };
    }
    if (hits.length > 1) {
      const originalOffsets = hits
        .map((h) => mapNormalizedSpanToOriginal(content, nContent, h, nNeedle.length)?.start)
        .filter((v): v is number => v !== undefined);
      return {
        level: null, occurrences: hits.length, reason: 'old_string ambiguo tras normalizar EOL',
        candidates: candidatesFromOffsets(content, originalOffsets),
      };
    }
  }

  // 3) indent: quita indentación común de needle y de cada bloque candidato del mismo alto en content
  {
    const needleLines = needle.split(/\r?\n/);
    const strippedNeedle = stripCommonIndent(needleLines.join('\n'));
    const contentLines = normalizeEol(content).split('\n');
    const hits: { startLine: number; endLine: number }[] = [];
    for (let i = 0; i + needleLines.length <= contentLines.length; i++) {
      const block = contentLines.slice(i, i + needleLines.length).join('\n');
      if (stripCommonIndent(block) === strippedNeedle) hits.push({ startLine: i, endLine: i + needleLines.length });
    }
    if (hits.length === 1) {
      const h = hits[0] as { startLine: number; endLine: number };
      const span = lineRangeToOffsets(content, h.startLine, h.endLine);
      return { level: 'indent', start: span.start, end: span.end };
    }
    if (hits.length > 1) {
      return {
        level: null, occurrences: hits.length, reason: 'old_string ambiguo tras normalizar indentación',
        candidates: candidatesFromLineRanges(contentLines, hits),
      };
    }
  }

  // 4) whitespace: colapsa espacios internos y bordes de cada línea
  {
    const needleLines = needle.split(/\r?\n/);
    const normNeedle = normalizeWhitespace(needleLines.join('\n'));
    const contentLines = normalizeEol(content).split('\n');
    const hits: { startLine: number; endLine: number }[] = [];
    for (let i = 0; i + needleLines.length <= contentLines.length; i++) {
      const block = contentLines.slice(i, i + needleLines.length).join('\n');
      if (normalizeWhitespace(block) === normNeedle) hits.push({ startLine: i, endLine: i + needleLines.length });
    }
    if (hits.length === 1) {
      const h = hits[0] as { startLine: number; endLine: number };
      const span = lineRangeToOffsets(content, h.startLine, h.endLine);
      return { level: 'whitespace', start: span.start, end: span.end };
    }
    if (hits.length > 1) {
      return {
        level: null, occurrences: hits.length, reason: 'old_string ambiguo tras normalizar espacios',
        candidates: candidatesFromLineRanges(contentLines, hits),
      };
    }
  }

  // 5) fuzzy: ventana deslizante del mismo alto en líneas que needle, mejor ratio de Levenshtein
  {
    const needleLines = needle.split(/\r?\n/);
    const contentLines = normalizeEol(content).split('\n');
    const normNeedle = normalizeWhitespace(needleLines.join('\n'));
    let best: { startLine: number; endLine: number; ratio: number } | null = null;
    let secondBestRatio = Infinity;
    for (let i = 0; i + needleLines.length <= contentLines.length; i++) {
      const block = contentLines.slice(i, i + needleLines.length).join('\n');
      const ratio = levenshteinRatio(normalizeWhitespace(block), normNeedle);
      if (!best || ratio < best.ratio) {
        secondBestRatio = best ? best.ratio : Infinity;
        best = { startLine: i, endLine: i + needleLines.length, ratio };
      } else if (ratio < secondBestRatio) {
        secondBestRatio = ratio;
      }
    }
    const FUZZY_THRESHOLD = 0.25;
    if (best && best.ratio <= FUZZY_THRESHOLD && best.ratio < secondBestRatio) {
      const span = lineRangeToOffsets(content, best.startLine, best.endLine);
      return { level: 'fuzzy', start: span.start, end: span.end };
    }
  }

  return { level: null, occurrences: 0, reason: 'old_string no encontrado (ni exacto, ni tolerante a EOL/indentación/espacios/fuzzy)' };
}

function lineRangeToOffsets(original: string, startLine: number, endLine: number): { start: number; end: number } {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r\n|\n/);
  let offset = 0;
  for (let i = 0; i < startLine; i++) offset += (lines[i]?.length ?? 0) + eol.length;
  let end = offset;
  for (let i = startLine; i < endLine; i++) end += (lines[i]?.length ?? 0) + eol.length;
  // no incluir el separador final si es la última línea del archivo
  if (endLine >= lines.length) end -= eol.length;
  return { start: offset, end: Math.max(offset, end) };
}

function mapNormalizedSpanToOriginal(original: string, normalized: string, normStart: number, normLen: number): { start: number; end: number } | null {
  // Mapea offsets en `normalized` (CRLF colapsado a LF) de vuelta a offsets del `original`.
  let oi = 0, ni = 0;
  let start = -1, end = -1;
  while (ni <= normalized.length) {
    if (ni === normStart) start = oi;
    if (ni === normStart + normLen) { end = oi; break; }
    if (oi >= original.length) break;
    if (original[oi] === '\r' && original[oi + 1] === '\n') { oi += 2; ni += 1; }
    else { oi += 1; ni += 1; }
  }
  if (start < 0 || end < 0) return null;
  return { start, end };
}

export function replaceAtCascade(content: string, needle: string, replacement: string, replaceAll: boolean): { content: string; level: MatchLevel; count: number } | MatchFailure {
  if (!replaceAll) {
    const res = matchCascade(content, needle);
    if (res.level === null) return res;
    // Una distancia pequeña no garantiza el mismo bloque: una función completa en una línea
    // puede parecerse a una cabecera sin cuerpo. Nunca aplicar ese reemplazo destructivo.
    if (res.level === 'fuzzy') return {
      level: null, occurrences: 1,
      reason: 'old_string sólo tiene una coincidencia aproximada; no se modificó el archivo. Usá read_file y copiá el bloque real completo en old_string, sin resumirlo ni cambiar sus nombres',
      candidates: candidatesFromOffsets(content, [res.start]),
    };
    return { content: content.slice(0, res.start) + replacement + content.slice(res.end), level: res.level, count: 1 };
  }
  // replace_all: exige match exacto (múltiples ocurrencias); niveles tolerantes no aplican a "todas"
  // porque el sitio de cada ocurrencia deja de ser unívoco fuera del texto exacto.
  const hits = findAllExact(content, needle);
  if (hits.length === 0) return { level: null, occurrences: 0, reason: 'old_string no encontrado para replace_all' };
  let out = '';
  let cursor = 0;
  for (const h of hits) {
    out += content.slice(cursor, h) + replacement;
    cursor = h + needle.length;
  }
  out += content.slice(cursor);
  return { content: out, level: 'exact', count: hits.length };
}
