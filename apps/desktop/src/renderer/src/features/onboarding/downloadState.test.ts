import { describe, expect, it } from 'vitest';
import type { DownloadJob } from '@saurio/shared';
import { canUseDownloadedModel, createDownloadStartGuard, findDownloadById, findDownloadForModel, hydrateDownloads, isDownloadActive, markDownloadFailed, mergeDownloadJob } from './downloadState.js';

const job = (status: DownloadJob['status'], modelName = 'qwen3:8b'): DownloadJob => ({
  id: `${status}-1`, providerId: 'ollama', modelName, status, totalBytes: 100, completedBytes: status === 'done' ? 100 : 0, layers: [],
});

describe('onboarding download state', () => {
  it('mergea trabajos existentes y eventos posteriores sin perder el primero', () => {
    const initial = mergeDownloadJob({}, job('running'));
    const merged = mergeDownloadJob(initial, { ...job('done'), id: 'running-1' });
    expect(findDownloadForModel(merged, 'qwen3:8b')?.status).toBe('done');
  });

  it('prefiere el reintento activo sobre un fallo anterior del mismo modelo', () => {
    const failed = { ...job('failed'), id: 'fallido-anterior' };
    const retry = { ...job('queued'), id: 'reintento-activo' };
    expect(findDownloadForModel({ [failed.id]: failed, [retry.id]: retry }, 'qwen3:8b')?.id).toBe('reintento-activo');
  });

  it('reconoce estados activos y permite usar solo completados o instalados', () => {
    expect(isDownloadActive(job('queued'))).toBe(true);
    expect(canUseDownloadedModel('qwen3:8b', job('failed'))).toBe(false);
    expect(canUseDownloadedModel('qwen3:8b', job('done'))).toBe(true);
    expect(canUseDownloadedModel('qwen3:8b', undefined, new Set(['qwen3:8b']))).toBe(true);
  });

  it('bloquea el segundo inicio síncrono hasta que models:pull responde', () => {
    const guard = createDownloadStartGuard();
    expect(guard.begin('qwen3:8b')).toBe(true);
    expect(guard.begin('qwen3:8b')).toBe(false);
    guard.end('qwen3:8b');
    expect(guard.begin('qwen3:8b')).toBe(true);
  });

  it('marca un fallo por downloadId y se rehidrata sin atribuírselo al modelo seleccionado', () => {
    const other = { ...job('running', 'otra-descarga:7b'), id: 'job_otra' };
    const failed = markDownloadFailed({ [other.id]: other }, 'job_otra', 'sin espacio');
    expect(findDownloadById(failed, 'job_otra')).toMatchObject({ modelName: 'otra-descarga:7b', status: 'failed', error: 'sin espacio' });
    expect(markDownloadFailed({}, 'job_desconocido', 'falló')).toEqual({});

    const hydrated = hydrateDownloads([{ ...other, status: 'failed', error: 'sin espacio' }]);
    expect(hydrated.downloadIds['otra-descarga:7b']).toBe('job_otra');
    expect(hydrated.jobs.job_otra).toMatchObject({ status: 'failed' });
  });

  it('al hidratar conserva el job activo del reintento como índice del modelo', () => {
    const previous = { ...job('failed'), id: 'job_anterior' };
    const active = { ...job('running'), id: 'job_actual' };
    expect(hydrateDownloads([previous, active]).downloadIds['qwen3:8b']).toBe('job_actual');
  });
});
