// Panel "Diff": lista de checkpoints del chat activo, vista antes/después con @codemirror/merge
// desde `checkpoint:diff`, y el flujo planRevert -> diálogo de conflictos a tres vías -> revert
// (doc 09 §2-§5, doc 01 §4.1 Paneles del MVP). apps/desktop/src/renderer/src/features/diff/.
import { useCallback, useEffect, useState } from 'react';
import type { Checkpoint, RevertResult } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { MergeViewHost } from './MergeViewHost.js';
import { RevertDialog } from './RevertDialog.js';
import { splitUnifiedDiff } from './unifiedDiff.js';
import './diff.css';

export interface DiffPanelProps {
  chatId: string | null;
}

function checkpointLabel(checkpoint: Checkpoint): string {
  const { files, stats } = checkpoint;
  const scope = checkpoint.kind === 'revert' ? 'revert' : 'tool';
  return `${scope} · ${files.length} archivo(s) · +${stats.added}/-${stats.removed} · ${checkpoint.status}`;
}

export function DiffPanel({ chatId }: DiffPanelProps): React.JSX.Element {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeFile, setActiveFile] = useState<{ checkpointId: string; relPath: string } | null>(null);
  const [diff, setDiff] = useState<{ before: string; after: string; added: number; removed: number } | null>(null);
  const [showRevert, setShowRevert] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRevert, setLastRevert] = useState<RevertResult | null>(null);

  const loadCheckpoints = useCallback(async (id: string) => {
    try {
      setCheckpoints(await invoke('checkpoint:list', { chatId: id }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (chatId) void loadCheckpoints(chatId);
    else { setCheckpoints([]); setActiveFile(null); setDiff(null); }
  }, [chatId, loadCheckpoints]);

  async function openFile(checkpointId: string, relPath: string): Promise<void> {
    setActiveFile({ checkpointId, relPath });
    setError(null);
    try {
      const result = await invoke('checkpoint:diff', { checkpointId, relPath });
      const { before, after } = splitUnifiedDiff(result.unified);
      setDiff({ before, after, added: result.added, removed: result.removed });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDiff(null);
    }
  }

  function toggleSelected(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (!chatId) return <p className="saurio-empty">Elegí un chat para ver sus checkpoints.</p>;

  return (
    <div className="diff-panel">
      <div className="diff-panel__checkpoints">
        <strong>Checkpoints</strong>
        {error && <div className="saurio-banner danger">{error}</div>}
        {checkpoints.length === 0 && <p className="saurio-empty">Sin checkpoints en este chat.</p>}
        {checkpoints.map((checkpoint) => (
          <div key={checkpoint.id} className="diff-panel__checkpoint-card">
            <label className="diff-panel__checkpoint-label">
              <input
                type="checkbox"
                checked={selectedIds.has(checkpoint.id)}
                onChange={() => toggleSelected(checkpoint.id)}
                disabled={checkpoint.status === 'reverted'}
              />
              <span>{checkpointLabel(checkpoint)}</span>
            </label>
            <div className="diff-panel__checkpoint-files">
              {checkpoint.files.map((file) => (
                <div
                  key={file.relPath}
                  className={`saurio-sidebar-item${activeFile?.checkpointId === checkpoint.id && activeFile.relPath === file.relPath ? ' active' : ''}`}
                  onClick={() => void openFile(checkpoint.id, file.relPath)}
                  title={file.relPath}
                >
                  {file.change === 'created' ? '＋' : file.change === 'deleted' ? '－' : '±'} {file.relPath}
                  {file.blobMissing && <span className="saurio-badge unavailable">&gt;20 MB</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
        <button
          className="saurio-btn-primary diff-panel__revert-btn"
          disabled={selectedIds.size === 0}
          onClick={() => setShowRevert(true)}
        >
          Revertir seleccionados ({selectedIds.size})
        </button>
        {lastRevert && (
          <div className="saurio-banner diff-panel__revert-banner">
            Revert aplicado: {lastRevert.restored.length} restaurado(s), {lastRevert.skipped.length} omitido(s). Checkpoint del revert: {lastRevert.revertCheckpointId.slice(0, 8)}.
          </div>
        )}
      </div>

      <div className="diff-panel__content">
        <strong>Antes / después</strong>
        {!activeFile && <p className="saurio-empty">Elegí un archivo de un checkpoint.</p>}
        {activeFile && diff && (
          <>
            <p className="diff-panel__file-label saurio-mono">{activeFile.relPath} (+{diff.added}/-{diff.removed})</p>
            <MergeViewHost before={diff.before} after={diff.after} />
          </>
        )}
      </div>

      {showRevert && (
        <RevertDialog
          checkpointIds={[...selectedIds]}
          onClose={() => setShowRevert(false)}
          onReverted={(result) => {
            setLastRevert(result);
            setShowRevert(false);
            setSelectedIds(new Set());
            if (chatId) void loadCheckpoints(chatId);
          }}
        />
      )}
    </div>
  );
}
