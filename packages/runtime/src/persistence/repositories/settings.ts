// SettingsRepository (doc 03 §4.8, desvío 4: índices únicos parciales por rama de scope en vez
// de PK simple) — packages/runtime/src/persistence/repositories/settings.ts.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { SettingsRepository } from '../types.js';

interface SettingsRow extends SqliteRow { value_json: string }

export function createSettingsRepository(driver: SqliteDriver): SettingsRepository {
  return {
    async get(key: string, projectId?: string): Promise<unknown> {
      const row = projectId
        ? driver.prepare<SettingsRow>('SELECT value_json FROM settings WHERE key = ? AND project_id = ?').get(key, projectId)
        : driver.prepare<SettingsRow>('SELECT value_json FROM settings WHERE key = ? AND project_id IS NULL').get(key);
      return row ? JSON.parse(row.value_json) : undefined;
    },
    async set(key: string, value: unknown, projectId?: string): Promise<void> {
      const scope = projectId ? 'project' : 'global';
      const valueJson = JSON.stringify(value);
      if (projectId) {
        driver.prepare(
          `INSERT INTO settings (key, value_json, scope, project_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(key, project_id) WHERE project_id IS NOT NULL DO UPDATE SET value_json = excluded.value_json`,
        ).run(key, valueJson, scope, projectId);
      } else {
        driver.prepare(
          `INSERT INTO settings (key, value_json, scope, project_id) VALUES (?, ?, ?, NULL)
           ON CONFLICT(key) WHERE project_id IS NULL DO UPDATE SET value_json = excluded.value_json`,
        ).run(key, valueJson, scope);
      }
    },
  };
}
