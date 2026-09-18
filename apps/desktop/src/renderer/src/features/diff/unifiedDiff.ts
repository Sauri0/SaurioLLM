// Reconstruye "antes"/"después" a partir del unified diff que devuelve `checkpoint:diff`
// (DiffResultSchema = { unified, added, removed } — packages/shared/src/domain.ts, doc 04 §9);
// el contrato no expone el contenido completo por separado, así que la vista antes/después de
// @codemirror/merge (doc 09 §4, doc 01 §4.1) se arma parseando el propio unified diff acá.
// apps/desktop/src/renderer/src/features/diff/unifiedDiff.ts.
export interface SplitDiff { before: string; after: string }

/** Parser mínimo de un hunk unified diff de un solo archivo (líneas `@@`, ` `, `-`, `+`;
 *  ignora cabeceras `---`/`+++`). Suficiente para reconstruir ambos lados en el MVP: no soporta
 *  diffs "no newline at end of file" con precisión de EOL. */
export function splitUnifiedDiff(unified: string): SplitDiff {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of unified.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('-')) {
      before.push(line.slice(1));
    } else if (line.startsWith('+')) {
      after.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    } else if (line.length === 0) {
      before.push('');
      after.push('');
    }
  }
  return { before: before.join('\n'), after: after.join('\n') };
}
