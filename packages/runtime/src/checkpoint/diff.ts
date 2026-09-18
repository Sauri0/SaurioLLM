// Diff unificado con jsdiff — packages/runtime/src/checkpoint/diff.ts.
// Define: doc 09 §3.5 (stats_json {files, added, removed} vía jsdiff, nunca confiando en lo que dice
// el modelo) y §3.6 (diff unificado on-demand a partir de los blobs pre/post, sin persistirse).
import { createTwoFilesPatch, diffLines } from 'diff';

export interface DiffStats {
  added: number;
  removed: number;
}

export function computeDiffStats(preText: string, postText: string): DiffStats {
  const parts = diffLines(preText, postText);
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const lineCount = countLines(part.value);
    if (part.added) added += lineCount;
    else if (part.removed) removed += lineCount;
  }
  return { added, removed };
}

export function computeUnifiedDiff(relPath: string, preText: string, postText: string): string {
  return createTwoFilesPatch(relPath, relPath, preText, postText, undefined, undefined, { context: 3 });
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  const lines = value.split('\n');
  // jsdiff deja un elemento vacío final cuando `value` termina en '\n'; no cuenta como línea propia.
  return value.endsWith('\n') ? lines.length - 1 : lines.length;
}
