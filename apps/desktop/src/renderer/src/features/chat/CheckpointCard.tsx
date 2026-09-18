// Tarjeta de checkpoint: archivos +N -M con enlace al diff (doc 01 §4.1, doc 04 §9)
// — apps/desktop/src/renderer/src/features/chat/CheckpointCard.tsx.
import type { Checkpoint } from '@saurio/shared';

export interface CheckpointCardProps {
  checkpoint: Checkpoint;
  /** El diff en sí (`@codemirror/merge`, doc 01 §4.1) vive fuera de este módulo (features/diff no
   *  está entre los directorios asignados a renderer-core); acá solo se expone el enlace/acción
   *  para que el layout abra ese panel con `checkpoint:diff` — ver deviations. */
  onOpenDiff: (checkpointId: string, relPath: string) => void;
}

export function CheckpointCard({ checkpoint, onOpenDiff }: CheckpointCardProps): React.JSX.Element {
  return (
    <div className={`checkpoint-card status-${checkpoint.status}`}>
      <div className="checkpoint-card__header">
        <span>Checkpoint</span>
        <span className="checkpoint-card__stats">
          {checkpoint.stats.files} archivo(s), <span className="checkpoint-card__added">+{checkpoint.stats.added}</span>{' '}
          <span className="checkpoint-card__removed">−{checkpoint.stats.removed}</span>
        </span>
      </div>
      <ul className="checkpoint-card__files">
        {checkpoint.files.map((f) => (
          <li key={f.relPath}>
            <button type="button" className="checkpoint-card__file-link" onClick={() => onOpenDiff(checkpoint.id, f.relPath)}>
              {f.relPath}
            </button>
            <span className={`checkpoint-card__change change-${f.change}`}>{f.change}</span>
            {f.blobMissing && <span className="checkpoint-card__blob-missing">(sin blob, &gt;20 MB)</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
