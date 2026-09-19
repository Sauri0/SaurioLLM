import { describe, expect, it } from 'vitest';
import type { DownloadJob } from '@saurio/shared';
import { mergeDownloadSnapshot, retryRequest, upsertDownloadJob, visibleDownloadError } from './downloadUi.js';

function job(patch: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: 'download-1', providerId: 'ollama', modelName: 'hf.co/Qwen/repo:q8_0',
    status: 'running', totalBytes: 100, completedBytes: 0, layers: [], startedAt: 10,
    ...patch,
  };
}

describe('downloadUi', () => {
  it('inserta un fallo aunque no haya existido un evento de progreso previo', () => {
    const failed = job({ status: 'failed', error: 'blocked redirect to a different host' });
    expect(upsertDownloadJob([], failed)).toEqual([failed]);
  });

  it('una respuesta running tardía no pisa el fallo terminal del mismo intento', () => {
    const failed = job({ status: 'failed', error: 'falló' });
    expect(mergeDownloadSnapshot([failed], [job({ status: 'running' })])).toEqual([failed]);
    expect(upsertDownloadJob([failed], job({ status: 'running', startedAt: 11 }))[0]?.status).toBe('running');
  });

  it('reintenta HF con la referencia y el tamaño persistidos; Ollama con su nombre', () => {
    expect(retryRequest(job())).toEqual({
      channel: 'models:pullExternal', input: { ref: 'hf.co/Qwen/repo:q8_0', sizeBytes: 100 },
    });
    expect(retryRequest(job({ modelName: 'qwen3:8b' }))).toEqual({
      channel: 'models:pull', input: { name: 'qwen3:8b' },
    });
  });

  it('oculta parámetros firmados sólo en presentación y conserva el motivo', () => {
    const raw = 'Head "https://cdn.example/model.gguf?Policy=secret&Signature=abc": blocked redirect to a different host';
    const visible = visibleDownloadError(raw);
    expect(visible).toContain('https://cdn.example/model.gguf?<parámetros omitidos>');
    expect(visible).toContain('blocked redirect to a different host');
    expect(visible).not.toContain('secret');
  });
});
