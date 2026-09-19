// Tarjeta de checkpoint MERGEADA por run — rediseño del chat, punto 4: "solo cuando hubo archivos
// cambiados, como UNA tarjeta por run ... no una por tool call" (antes `ChatMessageList` listaba
// cada `Checkpoint` suelto, incluidos los de "0 archivo(s)" que reportó el feedback real v0.2.1).
// apps/desktop/src/renderer/src/features/chat/RunCheckpointCard.tsx.
import { useState } from 'react';
import type { RevertResult } from '@saurio/shared';
import type { MergedRunCheckpoint } from './runCheckpoints.js';
import { RevertDialog } from '../diff/RevertDialog.js';
import './chat.css';

export interface RunCheckpointCardProps {
  merged: MergedRunCheckpoint;
  onOpenDiff: (checkpointId: string, relPath: string) => void;
}

export function RunCheckpointCard({ merged, onOpenDiff }: RunCheckpointCardProps): React.JSX.Element {
  const [showRevert, setShowRevert] = useState(false);
  const [reverted, setReverted] = useState<RevertResult | null>(null);
  const lastCheckpointId = merged.checkpointIds[merged.checkpointIds.length - 1]!;

  return (
    <div className="run-checkpoint-card">
      <div className="run-checkpoint-card__header">
        <span>
          Cambió {merged.stats.files} archivo{merged.stats.files === 1 ? '' : 's'}
          {' '}<span className="run-checkpoint-card__added">+{merged.stats.added}</span>{' '}
          <span className="run-checkpoint-card__removed">−{merged.stats.removed}</span>
        </span>
        {!reverted && (
          <button type="button" className="saurio-btn-ghost run-checkpoint-card__undo" onClick={() => setShowRevert(true)}>
            Deshacer
          </button>
        )}
        {reverted && <span className="run-checkpoint-card__reverted">Deshecho</span>}
      </div>
      <ul className="run-checkpoint-card__files">
        {merged.files.map((f) => (
          <li key={f.relPath}>
            <button type="button" className="run-checkpoint-card__file-link" onClick={() => onOpenDiff(lastCheckpointId, f.relPath)}>
              {f.relPath}
            </button>
            <span className="run-checkpoint-card__change">{f.change}</span>
            {f.blobMissing && <span className="run-checkpoint-card__blob-missing">(sin blob, &gt;20 MB)</span>}
          </li>
        ))}
      </ul>
      {showRevert && (
        <RevertDialog
          checkpointIds={merged.checkpointIds}
          onClose={() => setShowRevert(false)}
          onReverted={(result) => { setReverted(result); setShowRevert(false); }}
        />
      )}
    </div>
  );
}
