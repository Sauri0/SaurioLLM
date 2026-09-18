// Diálogo de revert: plan (planRevert) -> conflictos a tres vías -> revert, más el texto literal
// de lo que el revert NO cubre (doc 09 §5, §6: "regla dura, nunca se pisa en silencio").
// apps/desktop/src/renderer/src/features/diff/RevertDialog.tsx.
import { useState } from 'react';
import type { RevertConflict, RevertPlan, RevertResult } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import './diff.css';

type Resolution = 'restore' | 'keep_mine' | 'skip';

/** Texto literal exigido por doc 09 §6 ("Límites explícitos: lo que el checkpoint NO deshace")
 *  y §5.4 ("nunca se pisa en silencio"); se muestra siempre, no solo cuando hay uncoveredEffects,
 *  porque `RevertPlanSchema` de packages/shared (doc 04 §9) no incluye todavía `uncoveredEffects`
 *  ni `branchChanged` (solo `restorable`/`conflicts`) — ver deviations de este módulo. */
const REVERT_DOES_NOT_COVER = [
  'Comandos de terminal (`npm install`, migraciones de base de datos, `git push`, etc.): revertir un archivo no deshace lo que un comando haya hecho.',
  'Cambios fuera del workspace o en servicios externos (llamadas de red, modelos de Ollama).',
  'Archivos de más de 20 MB tocados por el agente: se guardó su hash, no su contenido, así que no hay nada que restaurar.',
  'Artefactos de build fuera de rutas conocidas.',
];

interface ConflictRowProps {
  conflict: RevertConflict;
  resolution: Resolution;
  onChange(relPath: string, resolution: Resolution): void;
}

function ConflictRow({ conflict, resolution, onChange }: ConflictRowProps): React.JSX.Element {
  return (
    <div className="revert-conflict-row">
      <div className="saurio-mono revert-conflict-row__path">{conflict.relPath}</div>
      <div className="revert-conflict-row__columns">
        <div>
          <div className="saurio-text-dim">pre</div>
          <pre className="saurio-mono revert-conflict-row__snippet">{conflict.pre ?? '(sin contenido previo)'}</pre>
        </div>
        <div>
          <div className="saurio-text-dim">post (lo que dejó el agente)</div>
          <pre className="saurio-mono revert-conflict-row__snippet">{conflict.post ?? '(archivo creado, sin post)'}</pre>
        </div>
        <div>
          <div className="saurio-text-dim">actual en disco</div>
          <pre className="saurio-mono revert-conflict-row__snippet">{conflict.current}</pre>
        </div>
      </div>
      <div className="revert-conflict-row__options">
        {(['restore', 'keep_mine', 'skip'] as const).map((option) => (
          <label key={option} className="revert-conflict-row__option">
            <input
              type="radio"
              name={`resolution-${conflict.relPath}`}
              checked={resolution === option}
              onChange={() => onChange(conflict.relPath, option)}
            />{' '}
            {option === 'restore' ? 'Restaurar (pisa lo actual)' : option === 'keep_mine' ? 'Conservar lo mío' : 'Ahora no'}
          </label>
        ))}
      </div>
    </div>
  );
}

export interface RevertDialogProps {
  checkpointIds: string[];
  onClose(): void;
  onReverted(result: RevertResult): void;
}

export function RevertDialog({ checkpointIds, onClose, onReverted }: RevertDialogProps): React.JSX.Element {
  const [plan, setPlan] = useState<RevertPlan | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadPlan(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke('checkpoint:planRevert', { checkpointIds });
      setPlan(result);
      setResolutions(Object.fromEntries(result.conflicts.map((c) => [c.relPath, 'keep_mine' as Resolution])));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyRevert(): Promise<void> {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const resolution: Record<string, Resolution> = { ...resolutions };
      for (const relPath of plan.restorable) resolution[relPath] = 'restore';
      const result = await invoke('checkpoint:revert', { checkpointIds, resolution });
      onReverted(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-label="Revertir checkpoints" className="revert-dialog__backdrop">
      <div className="revert-dialog__card">
        <h3>Revertir {checkpointIds.length} checkpoint(s)</h3>

        <div className="saurio-banner">
          <strong>Esto NO se deshace con un revert:</strong>
          <ul className="revert-dialog__does-not-cover-list">
            {REVERT_DOES_NOT_COVER.map((text) => <li key={text}>{text}</li>)}
          </ul>
        </div>

        {error && <div className="saurio-banner danger">{error}</div>}

        {!plan ? (
          <button className="saurio-btn-primary" onClick={() => void loadPlan()} disabled={busy}>
            {busy ? 'Calculando plan…' : 'Ver plan de revert'}
          </button>
        ) : (
          <>
            <p>{plan.restorable.length} archivo(s) restaurables sin conflicto.</p>
            {plan.conflicts.length > 0 && (
              <>
                <p>{plan.conflicts.length} archivo(s) en conflicto (editados después del checkpoint):</p>
                {plan.conflicts.map((conflict) => (
                  <ConflictRow
                    key={conflict.relPath}
                    conflict={conflict}
                    resolution={resolutions[conflict.relPath] ?? 'keep_mine'}
                    onChange={(relPath, resolution) => setResolutions((prev) => ({ ...prev, [relPath]: resolution }))}
                  />
                ))}
              </>
            )}
            <div className="revert-dialog__actions">
              <button className="saurio-btn-primary" onClick={() => void applyRevert()} disabled={busy}>
                {busy ? 'Aplicando…' : 'Confirmar revert'}
              </button>
              <button onClick={onClose} disabled={busy}>Cancelar</button>
            </div>
          </>
        )}
        {!plan && (
          <div className="revert-dialog__cancel-only">
            <button onClick={onClose}>Cancelar</button>
          </div>
        )}
      </div>
    </div>
  );
}
