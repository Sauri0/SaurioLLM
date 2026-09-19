import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDriver, type SqliteDriver } from '../driver.js';
import { runMigrations } from '../migrations/index.js';
import { createModelCompatRepository, createModelLoadSamplesRepository } from './modelEvidence.js';

describe('repositorios de evidencia de modelos', () => {
  let driver: SqliteDriver;

  beforeEach(() => {
    driver = openDriver(':memory:');
    runMigrations(driver);
    driver.prepare(
      `INSERT INTO providers
        (id, kind, transport, base_url, is_loopback, enabled, mode, max_concurrency)
       VALUES ('ollama', 'ollama', 'http', 'http://127.0.0.1:11434', 1, 1, 'attach', 1)`,
    ).run();
  });

  afterEach(() => driver.close());

  it('persiste muestras reales y devuelve las más recientes primero', async () => {
    const repo = createModelLoadSamplesRepository(driver);
    await repo.insert({
      id: 'old', providerId: 'ollama', modelName: 'qwen3:8b', modelDigest: 'digest-a', numCtx: 8192,
      size: 5_000, sizeVram: 4_900, contextLength: 8192, loadMs: null, estimatedVram: 4_700,
      hardwareFingerprint: 'hw-a', sampledAt: 10,
    });
    await repo.insert({
      id: 'new', providerId: 'ollama', modelName: 'qwen3:8b', modelDigest: 'digest-a', numCtx: 32768,
      size: 5_000, sizeVram: 5_200, contextLength: 32768, loadMs: 850, estimatedVram: 5_000,
      hardwareFingerprint: 'hw-a', sampledAt: 20,
    });

    expect((await repo.recent('ollama', 'qwen3:8b', 'digest-a', 32768, 'hw-a', 1)).map((row) => row.id)).toEqual(['new']);
    expect(await repo.recent('ollama', 'qwen3:8b', 'digest-a', 8192, 'other-hardware', 5)).toEqual([]);
  });

  it('no reutiliza compatibilidad de otro digest, equipo ni contexto y toma la última prueba exacta', async () => {
    const repo = createModelCompatRepository(driver);
    const insert = driver.prepare(
      `INSERT INTO model_compat
        (id, provider_id, model_name, model_digest, hardware_fingerprint, num_ctx, status, gen_tps, tested_at)
       VALUES (?, 'ollama', 'qwen3:8b', ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('wrong-digest', 'digest-old', 'hw-a', 8192, 'fits', 90, 40);
    insert.run('wrong-hardware', 'digest-a', 'hw-b', 8192, 'fits', 80, 50);
    insert.run('wrong-context', 'digest-a', 'hw-a', 32768, 'partial', 20, 60);
    insert.run('older', 'digest-a', 'hw-a', 8192, 'fits', 60, 70);
    insert.run('latest', 'digest-a', 'hw-a', 8192, 'failed', null, 80);

    const exact = await repo.latest({
      providerId: 'ollama', modelName: 'qwen3:8b', modelDigest: 'digest-a', hardwareFingerprint: 'hw-a', numCtx: 8192,
    });
    expect(exact).toMatchObject({ id: 'latest', status: 'failed', genTps: null, testedAt: 80 });
    expect(await repo.latest({
      providerId: 'ollama', modelName: 'qwen3:8b', modelDigest: 'missing', hardwareFingerprint: 'hw-a', numCtx: 8192,
    })).toBeUndefined();
  });
});
