// Fusiona los checkpoints de UN run en un resumen único — rediseño del chat, punto 4: "checkpoints
// solo cuando hubo archivos cambiados, como UNA tarjeta por run ... no una por tool call" (antes cada
// tool call de escritura creaba su propio checkpoint.created y la UI los listaba todos sueltos,
// incluidos los de "0 archivo(s)" que reportó el feedback real v0.2.1).
// apps/desktop/src/renderer/src/features/chat/runCheckpoints.ts.
import type { Checkpoint, CheckpointFile } from '@saurio/shared';

export interface MergedRunCheckpoint {
  checkpointIds: string[];
  /** Último `Checkpoint.files[].change` visto por archivo (create -> modified en checkpoints
   *  sucesivos del mismo run se muestra como "created", el estado más informativo para el usuario). */
  files: CheckpointFile[];
  stats: { files: number; added: number; removed: number };
}

/** `undefined` si no hubo NINGÚN archivo tocado — el turno no debe mostrar tarjeta de checkpoint
 *  (evita las tarjetas "0 archivo(s)" del feedback real). */
export function mergeRunCheckpoints(checkpoints: Checkpoint[]): MergedRunCheckpoint | undefined {
  if (checkpoints.length === 0) return undefined;
  const byPath = new Map<string, CheckpointFile>();
  let added = 0;
  let removed = 0;
  for (const checkpoint of checkpoints) {
    added += checkpoint.stats.added;
    removed += checkpoint.stats.removed;
    for (const file of checkpoint.files) {
      const existing = byPath.get(file.relPath);
      // 'created' es el estado más informativo (el archivo no existía antes de este run); no se pisa
      // con un 'modified' posterior del mismo run.
      if (existing?.change === 'created') continue;
      byPath.set(file.relPath, file);
    }
  }
  if (byPath.size === 0) return undefined;
  const files = [...byPath.values()];
  return {
    checkpointIds: checkpoints.map((c) => c.id),
    files,
    stats: { files: files.length, added, removed },
  };
}
