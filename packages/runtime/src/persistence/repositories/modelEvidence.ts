import type { SqliteDriver, SqliteRow } from '../driver.js';

export interface ModelLoadSampleRecord {
  id: string;
  providerId: string;
  modelName: string;
  modelDigest: string | null;
  numCtx: number;
  size: number | null;
  sizeVram: number | null;
  contextLength: number | null;
  loadMs: number | null;
  estimatedVram: number | null;
  hardwareFingerprint: string | null;
  sampledAt: number;
}

export interface ModelCompatRecord {
  id: string;
  providerId: string;
  modelName: string;
  modelDigest: string | null;
  hardwareFingerprint: string;
  numCtx: number;
  kvCacheType: string | null;
  think: string | null;
  ollamaVersion: string | null;
  driverVersion: string | null;
  size: number | null;
  sizeVram: number | null;
  offloadRatio: number | null;
  loadMs: number | null;
  promptTps: number | null;
  genTps: number | null;
  ttftMs: number | null;
  peakVramMib: number | null;
  peakRamMib: number | null;
  qualityScore: number | null;
  status: 'fits' | 'partial' | 'failed';
  error: string | null;
  testedAt: number;
}

export interface ModelCompatLookup {
  providerId: string;
  modelName: string;
  modelDigest: string;
  hardwareFingerprint: string;
  numCtx: number;
}

interface ModelLoadSampleRow extends SqliteRow {
  id: string; provider_id: string; model_name: string; model_digest: string | null;
  num_ctx: number; size: number | null; size_vram: number | null; context_length: number | null;
  load_ms: number | null; estimated_vram: number | null; hardware_fingerprint: string | null; sampled_at: number;
}

interface ModelCompatRow extends SqliteRow {
  id: string; provider_id: string; model_name: string; model_digest: string | null;
  hardware_fingerprint: string; num_ctx: number; kv_cache_type: string | null; think: string | null;
  ollama_version: string | null; driver_version: string | null; size: number | null; size_vram: number | null;
  offload_ratio: number | null; load_ms: number | null; prompt_tps: number | null; gen_tps: number | null;
  ttft_ms: number | null; peak_vram_mib: number | null; peak_ram_mib: number | null;
  quality_score: number | null; status: string; error: string | null; tested_at: number;
}

function toLoadSample(row: ModelLoadSampleRow): ModelLoadSampleRecord {
  return {
    id: row.id, providerId: row.provider_id, modelName: row.model_name, modelDigest: row.model_digest,
    numCtx: row.num_ctx, size: row.size, sizeVram: row.size_vram, contextLength: row.context_length,
    loadMs: row.load_ms, estimatedVram: row.estimated_vram,
    hardwareFingerprint: row.hardware_fingerprint, sampledAt: row.sampled_at,
  };
}

function toCompat(row: ModelCompatRow): ModelCompatRecord {
  if (row.status !== 'fits' && row.status !== 'partial' && row.status !== 'failed') {
    throw new Error(`saurio: estado model_compat desconocido: ${row.status}`);
  }
  return {
    id: row.id, providerId: row.provider_id, modelName: row.model_name, modelDigest: row.model_digest,
    hardwareFingerprint: row.hardware_fingerprint, numCtx: row.num_ctx, kvCacheType: row.kv_cache_type,
    think: row.think, ollamaVersion: row.ollama_version, driverVersion: row.driver_version,
    size: row.size, sizeVram: row.size_vram, offloadRatio: row.offload_ratio, loadMs: row.load_ms,
    promptTps: row.prompt_tps, genTps: row.gen_tps, ttftMs: row.ttft_ms,
    peakVramMib: row.peak_vram_mib, peakRamMib: row.peak_ram_mib, qualityScore: row.quality_score,
    status: row.status, error: row.error, testedAt: row.tested_at,
  };
}

export function createModelLoadSamplesRepository(driver: SqliteDriver) {
  return {
    async insert(sample: ModelLoadSampleRecord): Promise<void> {
      driver.prepare(
        `INSERT INTO model_load_samples
          (id, provider_id, model_name, model_digest, num_ctx, size, size_vram, context_length,
           load_ms, estimated_vram, hardware_fingerprint, sampled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sample.id, sample.providerId, sample.modelName, sample.modelDigest, sample.numCtx,
        sample.size, sample.sizeVram, sample.contextLength, sample.loadMs, sample.estimatedVram,
        sample.hardwareFingerprint,
        sample.sampledAt,
      );
    },
    async recent(
      providerId: string, modelName: string, modelDigest: string, numCtx: number,
      hardwareFingerprint: string, limit: number,
    ): Promise<ModelLoadSampleRecord[]> {
      const safeLimit = Math.max(0, Math.floor(limit));
      return driver.prepare<ModelLoadSampleRow>(
        `SELECT * FROM model_load_samples
         WHERE provider_id = ? AND model_name = ? AND model_digest = ? AND num_ctx = ?
           AND hardware_fingerprint = ?
         ORDER BY sampled_at DESC LIMIT ?`,
      ).all(providerId, modelName, modelDigest, numCtx, hardwareFingerprint, safeLimit).map(toLoadSample);
    },
  };
}

export function createModelCompatRepository(driver: SqliteDriver) {
  return {
    /** Devuelve sólo evidencia para la misma revisión del modelo, equipo y contexto. Una fila de
     * otro digest o contexto no se reutiliza como si probara compatibilidad universal. */
    async latest(input: ModelCompatLookup): Promise<ModelCompatRecord | undefined> {
      const row = driver.prepare<ModelCompatRow>(
        `SELECT * FROM model_compat
         WHERE provider_id = ? AND model_name = ? AND model_digest = ?
           AND hardware_fingerprint = ? AND num_ctx = ?
         ORDER BY tested_at DESC LIMIT 1`,
      ).get(input.providerId, input.modelName, input.modelDigest, input.hardwareFingerprint, input.numCtx);
      return row ? toCompat(row) : undefined;
    },
  };
}

export type ModelLoadSamplesRepository = ReturnType<typeof createModelLoadSamplesRepository>;
export type ModelCompatRepository = ReturnType<typeof createModelCompatRepository>;
