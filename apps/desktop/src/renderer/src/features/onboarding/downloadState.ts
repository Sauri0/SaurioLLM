import type { DownloadJob } from '@saurio/shared';

export function mergeDownloadJob(jobs: Record<string, DownloadJob>, job: DownloadJob): Record<string, DownloadJob> {
  return { ...jobs, [job.id]: job };
}

export function findDownloadById(jobs: Record<string, DownloadJob>, downloadId: string): DownloadJob | undefined {
  return jobs[downloadId];
}

export function findDownloadForModel(jobs: Record<string, DownloadJob>, modelName: string): DownloadJob | undefined {
  const matches = Object.values(jobs).filter((job) => job.modelName === modelName);
  // Un reintento puede coexistir brevemente con un fallo anterior. La descarga activa debe ganar
  // para impedir otro pull, aunque el objeto conserve primero el historial terminal.
  return matches.find(isDownloadActive) ?? matches.at(-1);
}

export function isDownloadActive(job: DownloadJob | undefined): boolean {
  return job?.status === 'queued' || job?.status === 'running' || job?.status === 'paused';
}

/** Marca un fallo únicamente sobre el trabajo que emitió ese `downloadId`. Si el evento llegó antes
 * de que el renderer lo conozca, no se inventa un modelo: el caller rehidrata `models:downloads`. */
export function markDownloadFailed(jobs: Record<string, DownloadJob>, downloadId: string, error: string): Record<string, DownloadJob> {
  const current = findDownloadById(jobs, downloadId);
  return current ? mergeDownloadJob(jobs, { ...current, status: 'failed', error }) : jobs;
}

/** Convierte la fuente persistida del main en ambos índices del renderer. Es el fallback correcto
 * cuando un evento de descarga llegó antes de la respuesta inicial de `models:pull`. */
export function hydrateDownloads(downloads: DownloadJob[]): {
  jobs: Record<string, DownloadJob>;
  downloadIds: Record<string, string>;
} {
  const jobs = Object.fromEntries(downloads.map((job) => [job.id, job]));
  const downloadIds: Record<string, string> = {};
  for (const modelName of new Set(downloads.map((job) => job.modelName))) {
    const selected = findDownloadForModel(jobs, modelName);
    if (selected) downloadIds[modelName] = selected.id;
  }
  return {
    jobs,
    downloadIds,
  };
}

/** Guarda sincrónica para el intervalo entre el click y la respuesta de `models:pull`. */
export function createDownloadStartGuard(): { begin: (modelName: string) => boolean; end: (modelName: string) => void; has: (modelName: string) => boolean } {
  const pending = new Set<string>();
  return {
    begin(modelName) {
      if (pending.has(modelName)) return false;
      pending.add(modelName);
      return true;
    },
    end(modelName) { pending.delete(modelName); },
    has(modelName) { return pending.has(modelName); },
  };
}

export function canUseDownloadedModel(modelName: string, job: DownloadJob | undefined, installedNames: ReadonlySet<string> = new Set()): boolean {
  return job?.status === 'done' || (job === undefined && installedNames.has(modelName));
}
