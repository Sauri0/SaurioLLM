import type { DownloadJob } from '@saurio/shared';

const TERMINAL_STATUSES = new Set<DownloadJob['status']>(['cancelled', 'done', 'failed', 'insufficient_space']);
const ACTIVE_STATUSES = new Set<DownloadJob['status']>(['queued', 'running', 'paused']);

export function upsertDownloadJob(jobs: DownloadJob[], job: DownloadJob): DownloadJob[] {
  return jobs.some((current) => current.id === job.id)
    ? jobs.map((current) => {
      if (current.id !== job.id) return current;
      // Una respuesta `models:downloads` iniciada antes del fallo puede volver después del evento
      // terminal. Sólo un intento realmente nuevo (startedAt mayor) puede pasar de terminal a activo.
      if (TERMINAL_STATUSES.has(current.status) && ACTIVE_STATUSES.has(job.status)
        && (job.startedAt ?? 0) <= (current.startedAt ?? 0)) return current;
      return job;
    })
    : [job, ...jobs];
}

export function mergeDownloadSnapshot(current: DownloadJob[], snapshot: DownloadJob[]): DownloadJob[] {
  return snapshot.reduce((jobs, job) => upsertDownloadJob(jobs, job), current);
}

export function retryRequest(job: DownloadJob):
  | { channel: 'models:pullExternal'; input: { ref: string; sizeBytes: number } }
  | { channel: 'models:pull'; input: { name: string } } {
  return job.modelName.startsWith('hf.co/')
    ? { channel: 'models:pullExternal', input: { ref: job.modelName, sizeBytes: job.totalBytes } }
    : { channel: 'models:pull', input: { name: job.modelName } };
}

/** El motor puede incluir una URL firmada enorme. Se conserva completa en SQLite/evidencia interna,
 *  pero la UI omite sólo su query efímera y mantiene host, ruta y motivo final legibles. */
export function visibleDownloadError(error: string): string {
  return error.replace(/(https?:\/\/[^?\s"]+)\?[^\s"]+/gu, '$1?<parámetros omitidos>');
}
