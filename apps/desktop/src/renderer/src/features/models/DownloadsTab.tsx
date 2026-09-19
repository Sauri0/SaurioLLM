// Pestaña "Descargas" del Centro de modelos (doc 13 §10): jobs de esta sesión (`models:downloads`)
// con progreso en vivo (`download:progress`/`done`/`failed`). No sobrevive a un reinicio de la app
// (DownloadManager guarda el estado en memoria de proceso; el historial persistido en SQLite queda
// para una vista futura — ver doc 16 "Pendiente").
// apps/desktop/src/renderer/src/features/models/DownloadsTab.tsx.
import { useCallback, useEffect, useState } from 'react';
import type { DownloadJob } from '@saurio/shared';
import { invoke, onEvent } from '../../ipc/client.js';
import { formatBytes } from './format.js';
import { mergeDownloadSnapshot, retryRequest, upsertDownloadJob, visibleDownloadError } from './downloadUi.js';

const STATUS_LABELS: Record<DownloadJob['status'], string> = {
  queued: 'en cola', running: 'descargando', paused: 'pausada',
  cancelled: 'cancelada', done: 'completa', failed: 'fallida',
  insufficient_space: 'espacio insuficiente',
};

export function DownloadsTab(): React.JSX.Element {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await invoke('models:downloads', undefined);
      setJobs((current) => mergeDownloadSnapshot(current, snapshot));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const offProgress = onEvent('download:progress', (job) => setJobs((prev) => upsertDownloadJob(prev, job)));
    const offDone = onEvent('download:done', (job) => setJobs((prev) => upsertDownloadJob(prev, job)));
    const offFailed = onEvent('download:failed', (job) => setJobs((prev) => upsertDownloadJob(prev, job)));
    return () => { offProgress(); offDone(); offFailed(); };
  }, [refresh]);

  const retry = useCallback(async (job: DownloadJob) => {
    setRetryingId(job.id);
    setError(null);
    try {
      const request = retryRequest(job);
      if (request.channel === 'models:pullExternal') {
        await invoke(request.channel, request.input);
      } else {
        await invoke(request.channel, request.input);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetryingId(null);
    }
  }, [refresh]);

  const cancel = useCallback(async (job: DownloadJob) => {
    setRetryingId(job.id);
    setError(null);
    try {
      await invoke('models:pullCancel', { downloadId: job.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetryingId(null);
    }
  }, []);

  if (jobs.length === 0) {
    return (
      <div className="saurio-empty-state">
        <span className="saurio-empty-state__title">Sin descargas en esta sesión</span>
        <span className="saurio-empty-state__hint">Descargá un modelo desde la pestaña "Explorar".</span>
      </div>
    );
  }

  return (
    <div>
      {error && <div className="saurio-banner danger">{error}</div>}
      <div className="saurio-row-list">
        {jobs.map((job) => {
          const pct = job.totalBytes > 0 ? Math.round((job.completedBytes / job.totalBytes) * 100) : 0;
          return (
            <div key={job.id} className="saurio-row">
              <div className="saurio-row__header">
                <strong className="saurio-mono saurio-row__title">{job.modelName}</strong>
                <span className="saurio-row__badges">
                  <span className={`saurio-badge ${job.status === 'done' ? 'measured' : job.status === 'failed' || job.status === 'insufficient_space' ? 'unavailable' : ''}`}>
                    {job.status === 'running' && job.phase === 'verifying' ? 'verificando archivo'
                      : job.status === 'running' && job.phase === 'importing' ? 'preparando modelo'
                        : STATUS_LABELS[job.status]}
                  </span>
                </span>
              </div>
              <div className="saurio-progress">
                <div className={`saurio-progress__fill ${job.status}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="saurio-row__line">
                {formatBytes(job.completedBytes)} / {formatBytes(job.totalBytes)} ({pct}%)
                {job.phase !== 'importing' && job.phase !== 'verifying' && job.bytesPerSec !== undefined && job.bytesPerSec > 0 && ` · ${formatBytes(job.bytesPerSec)}/s`}
                {job.phase !== 'importing' && job.phase !== 'verifying' && job.etaMs !== undefined && ` · ETA ${Math.ceil(job.etaMs / 1000)}s`}
              </div>
              {job.error && <div className="saurio-row__line saurio-row__line--danger">{visibleDownloadError(job.error)}</div>}
              {(job.status === 'queued' || job.status === 'running') && (
                <div className="saurio-row__line">
                  <button type="button" disabled={retryingId === job.id} onClick={() => void cancel(job)}>
                    {retryingId === job.id ? 'Cancelando…' : 'Cancelar'}
                  </button>
                </div>
              )}
              {(job.status === 'failed' || job.status === 'insufficient_space' || job.status === 'cancelled') && (
                <div className="saurio-row__line">
                  <button type="button" disabled={retryingId === job.id} onClick={() => void retry(job)}>
                    {retryingId === job.id ? 'Reintentando…' : 'Reintentar'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
