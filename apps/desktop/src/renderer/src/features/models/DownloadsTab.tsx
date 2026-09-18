// Pestaña "Descargas" del Centro de modelos (doc 13 §10): jobs de esta sesión (`models:downloads`)
// con progreso en vivo (`download:progress`/`done`/`failed`). No sobrevive a un reinicio de la app
// (DownloadManager guarda el estado en memoria de proceso; el historial persistido en SQLite queda
// para una vista futura — ver doc 16 "Pendiente").
// apps/desktop/src/renderer/src/features/models/DownloadsTab.tsx.
import { useCallback, useEffect, useState } from 'react';
import type { DownloadJob } from '@saurio/shared';
import { invoke, onEvent } from '../../ipc/client.js';
import { formatBytes } from './format.js';

const STATUS_LABELS: Record<DownloadJob['status'], string> = {
  queued: 'en cola', running: 'descargando', paused: 'pausada',
  cancelled: 'cancelada', done: 'completa', failed: 'fallida',
  insufficient_space: 'espacio insuficiente',
};

export function DownloadsTab(): React.JSX.Element {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setJobs(await invoke('models:downloads', undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const offProgress = onEvent('download:progress', (job) =>
      setJobs((prev) => (prev.some((j) => j.id === job.id) ? prev.map((j) => (j.id === job.id ? job : j)) : [job, ...prev])));
    const offDone = onEvent('download:done', (job) =>
      setJobs((prev) => prev.map((j) => (j.id === job.id ? job : j))));
    const offFailed = onEvent('download:failed', ({ downloadId, error: err }) =>
      setJobs((prev) => prev.map((j) => (j.id === downloadId ? { ...j, status: 'failed', error: err } : j))));
    return () => { offProgress(); offDone(); offFailed(); };
  }, [refresh]);

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
                    {STATUS_LABELS[job.status]}
                  </span>
                </span>
              </div>
              <div className="saurio-progress">
                <div className={`saurio-progress__fill ${job.status}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="saurio-row__line">
                {formatBytes(job.completedBytes)} / {formatBytes(job.totalBytes)} ({pct}%)
                {job.bytesPerSec !== undefined && job.bytesPerSec > 0 && ` · ${formatBytes(job.bytesPerSec)}/s`}
                {job.etaMs !== undefined && ` · ETA ${Math.ceil(job.etaMs / 1000)}s`}
              </div>
              {job.error && <div className="saurio-row__line saurio-row__line--danger">{job.error}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
