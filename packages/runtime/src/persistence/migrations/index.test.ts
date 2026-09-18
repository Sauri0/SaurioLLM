// Test de migraciones: aplica la migración 1 en una DB temporal real y verifica PRAGMA user_version,
// schema_migrations y que las tablas del doc 03 existen (doc 03 §8, requisito "migración en DB temporal").
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDriver, type SqliteDriver } from '../driver.js';
import { runMigrations, NewerSchemaError, MIGRATIONS } from './index.js';

describe('persistence/migrations', () => {
  let dir: string;
  let dbPath: string;
  let driver: SqliteDriver;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'saurio-migrations-test-'));
    dbPath = path.join(dir, 'saurio.db');
    driver = openDriver(dbPath);
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('aplica todas las migraciones embebidas y deja PRAGMA user_version en la última versión', () => {
    runMigrations(driver);
    const rows = driver.pragma('user_version') as Array<{ user_version: number }>;
    const latest = Math.max(...MIGRATIONS.map((m) => m.version));
    expect(rows[0]?.user_version).toBe(latest);
  });

  it('crea todas las tablas imprescindibles del MVP (doc 03 §12)', () => {
    runMigrations(driver);
    const tables = driver.prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all().map((r) => r.name);
    const expected = [
      'projects', 'agents', 'chats', 'runs', 'run_events', 'messages', 'tool_calls',
      'permission_rules', 'permission_decisions', 'checkpoints', 'checkpoint_files', 'blobs',
      'tasks', 'providers', 'models', 'model_load_samples', 'token_calibration', 'settings',
      'audit_log', 'schema_migrations', 'run_adjustments', 'project_memory', 'repo_map_cache',
      'profiles', 'model_compat', 'benchmark_runs', 'downloads', 'metrics_minute',
    ];
    for (const name of expected) expect(tables).toContain(name);
  });

  it('registra la migración en schema_migrations con checksum', () => {
    runMigrations(driver);
    const row = driver.prepare<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations WHERE version = 1',
    ).get();
    expect(row?.name).toBe('0001_init');
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('es idempotente: correr runMigrations de nuevo no reaplica nada', () => {
    runMigrations(driver);
    expect(() => runMigrations(driver)).not.toThrow();
    const count = driver.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations').get();
    expect(count?.n).toBe(MIGRATIONS.length);
  });

  it('rehúsa abrir si PRAGMA user_version es más nuevo que el código (doc 03 §8 punto 5)', () => {
    runMigrations(driver);
    driver.pragma('user_version = 99');
    expect(() => runMigrations(driver)).toThrow(NewerSchemaError);
  });

  describe('migración 2 (downloads.status insufficient_space + checkpoints.git_head)', () => {
    it('aplica las dos migraciones en una base nueva y deja user_version = 2', () => {
      runMigrations(driver, [MIGRATIONS[0]!, MIGRATIONS[1]!]);
      const rows = driver.pragma('user_version') as Array<{ user_version: number }>;
      expect(rows[0]?.user_version).toBe(2);
      const applied = driver.prepare<{ version: number; name: string }>(
        'SELECT version, name FROM schema_migrations ORDER BY version',
      ).all();
      expect(applied.map((r) => r.version)).toEqual([1, 2]);
      expect(applied[1]?.name).toBe('0002_downloads_status_and_git_head');
    });

    it('migra una base existente (solo con la migración 1 ya aplicada) sin perder filas de downloads', () => {
      // Simula una base "real" creada por una versión anterior de la app: solo migración 1.
      runMigrations(driver, [MIGRATIONS[0]!]);
      expect((driver.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version).toBe(1);

      driver.exec(`
        INSERT INTO providers (id, kind, transport, base_url, is_loopback, enabled, mode, max_concurrency)
        VALUES ('ollama', 'ollama', 'http', 'http://127.0.0.1:11434', 1, 1, 'attach', 1)
      `);
      driver.prepare(
        `INSERT INTO downloads (id, provider_id, model_name, status, total, completed)
         VALUES (?, 'ollama', 'qwen3:8b', 'running', 100, 40)`,
      ).run('dl-1');

      // Antes de la migración 2, el CHECK original rechaza 'insufficient_space' (confirma que el
      // test ejercita el CHECK real, no un supuesto).
      expect(() => driver.prepare(
        `INSERT INTO downloads (id, provider_id, model_name, status) VALUES ('dl-bad', 'ollama', 'x', 'insufficient_space')`,
      ).run()).toThrow();

      // Migrar la base existente a la migración 2 puntualmente (aplica solo la 2, la 1 ya está;
      // este describe prueba la migración 2 en aislamiento — la 3 tiene su propio describe abajo).
      runMigrations(driver, [MIGRATIONS[0]!, MIGRATIONS[1]!]);
      expect((driver.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version).toBe(2);

      // La fila sembrada antes de migrar sigue intacta.
      const preserved = driver.prepare<{ id: string; model_name: string; status: string; total: number; completed: number }>(
        'SELECT id, model_name, status, total, completed FROM downloads WHERE id = ?',
      ).get('dl-1');
      expect(preserved).toEqual({ id: 'dl-1', model_name: 'qwen3:8b', status: 'running', total: 100, completed: 40 });

      // Ahora sí admite 'insufficient_space' (doc 13 §5 punto 1 / doc 16 §8 punto 1).
      expect(() => driver.prepare(
        `INSERT INTO downloads (id, provider_id, model_name, status) VALUES ('dl-2', 'ollama', 'qwen3:8b', 'insufficient_space')`,
      ).run()).not.toThrow();
      const inserted = driver.prepare<{ status: string }>('SELECT status FROM downloads WHERE id = ?').get('dl-2');
      expect(inserted?.status).toBe('insufficient_space');

      // El resto de los valores del CHECK original siguen funcionando (no se angostó nada).
      for (const status of ['queued', 'paused', 'cancelled', 'done', 'failed']) {
        expect(() => driver.prepare(
          `INSERT INTO downloads (id, provider_id, model_name, status) VALUES (?, 'ollama', 'x', ?)`,
        ).run(`dl-${status}`, status)).not.toThrow();
      }

      // checkpoints.git_head existe y acepta NULL/valores de texto (doc 09 §2.2).
      const columns = driver.prepare<{ name: string }>("PRAGMA table_info(checkpoints)").all();
      expect(columns.map((c) => c.name)).toContain('git_head');
    });
  });

  describe('migración 3 (messages.model_ref_json)', () => {
    it('agrega la columna sin CHECK, nullable, sin perder filas existentes (doc 16 §10.4/§10.9, punto 4 del encargo)', () => {
      // Simula una base "real" con solo las migraciones 1 y 2 ya aplicadas.
      runMigrations(driver, [MIGRATIONS[0]!, MIGRATIONS[1]!]);
      expect((driver.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version).toBe(2);

      driver.exec(`INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'p', '/p', 0)`);
      driver.prepare(
        `INSERT INTO agents (id, project_id, name, role, model_ref_json, system_prompt, system_prompt_hash,
           allowed_tools_json, permission_policy_json, context_policy_json, default_mode, thinking,
           tool_transport, max_iterations, is_builtin, updated_at)
         VALUES ('agent1', NULL, 'Coder', 'coder', '{}', 'eres coder', 'hash', '[]', '{}', '{}', 'agent', 'off', 'auto', 10, 1, 0)`,
      ).run();
      driver.prepare(
        `INSERT INTO chats (id, project_id, agent_id, mode, created_at, updated_at)
         VALUES ('c1', 'p1', 'agent1', 'agent', 0, 0)`,
      ).run();
      driver.prepare(
        `INSERT INTO messages (id, chat_id, run_id, seq, role, content, truncated, created_at)
         VALUES ('m1', 'c1', NULL, 1, 'user', 'hola', 0, 0)`,
      ).run();

      // Doc 19 (migración 0004 agregada después): se fija explícitamente a las 3 primeras en vez de
      // depender de que el default de `runMigrations` termine justo en la versión 3 — ese default
      // ahora incluye migraciones posteriores (0004+), así que esta prueba puntual de la migración 3
      // pasa la lista explícita para no volver a romperse con cada migración nueva.
      runMigrations(driver, [MIGRATIONS[0]!, MIGRATIONS[1]!, MIGRATIONS[2]!]);
      expect((driver.pragma('user_version') as Array<{ user_version: number }>)[0]?.user_version).toBe(3);

      const columns = driver.prepare<{ name: string }>('PRAGMA table_info(messages)').all();
      expect(columns.map((c) => c.name)).toContain('model_ref_json');

      // La fila sembrada antes de migrar sigue intacta, con la columna nueva en NULL.
      const preserved = driver.prepare<{ id: string; content: string; model_ref_json: string | null }>(
        'SELECT id, content, model_ref_json FROM messages WHERE id = ?',
      ).get('m1');
      expect(preserved).toEqual({ id: 'm1', content: 'hola', model_ref_json: null });

      // Un mensaje nuevo sí puede guardar el modelo que lo generó.
      driver.prepare(
        `INSERT INTO messages (id, chat_id, run_id, seq, role, content, truncated, created_at, model_ref_json)
         VALUES ('m2', 'c1', NULL, 2, 'assistant', 'hola de vuelta', 0, 0, ?)`,
      ).run(JSON.stringify({ providerId: 'ollama', name: 'qwen3:8b', locality: 'local' }));
      const withModel = driver.prepare<{ model_ref_json: string }>(
        'SELECT model_ref_json FROM messages WHERE id = ?',
      ).get('m2');
      expect(JSON.parse(withModel!.model_ref_json)).toEqual({ providerId: 'ollama', name: 'qwen3:8b', locality: 'local' });
    });
  });
});
