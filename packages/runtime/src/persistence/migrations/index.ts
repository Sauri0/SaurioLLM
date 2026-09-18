// Runner de migraciones embebidas, numeradas por PRAGMA user_version (doc 03 §8) —
// packages/runtime/src/persistence/migrations/index.ts.
// Secuencia (doc 03 §8): abrir + pragmas (driver.ts) -> leer user_version -> aplicar cada
// migración pendiente, una por una, cada una en su propia transacción -> si user_version es
// mayor a la del código, rehusar abrir (versión más nueva que esta build).
import { createHash } from 'node:crypto';
import type { SqliteDriver } from '../driver.js';
import { migration0001 } from './0001_init.js';
import { migration0002 } from './0002_downloads_status_and_git_head.js';
import { migration0003 } from './0003_messages_model_ref.js';
import type { Migration } from './types.js';

/** Orden ascendente por versión; agregar migraciones nuevas acá cuando existan (0004, ...). */
const MIGRATIONS: Migration[] = [migration0001, migration0002, migration0003];

export class NewerSchemaError extends Error {
  constructor(public readonly dbVersion: number, public readonly codeVersion: number) {
    super(
      `saurio.db tiene PRAGMA user_version=${dbVersion}, más nuevo que esta build de SaurioLLM ` +
      `(soporta hasta ${codeVersion}). Esta versión de la app no puede abrir ese proyecto (doc 03 §8, punto 5).`,
    );
    this.name = 'NewerSchemaError';
  }
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function readUserVersion(driver: SqliteDriver): number {
  const rows = driver.pragma('user_version') as Array<{ user_version: number }>;
  return rows[0]?.user_version ?? 0;
}

/** Aplica las migraciones pendientes contra `driver`, en el orden de §8. Cada migración corre en
 *  su propia transacción; si una falla, `better-sqlite3` hace ROLLBACK de esa transacción y
 *  `user_version` queda en el valor anterior (la migración fallida nunca lo actualiza). */
export function runMigrations(driver: SqliteDriver, migrations: Migration[] = MIGRATIONS): void {
  const codeVersion = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  const dbVersion = readUserVersion(driver);

  if (dbVersion > codeVersion) {
    throw new NewerSchemaError(dbVersion, codeVersion);
  }

  const pending = migrations
    .filter((m) => m.version > dbVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    driver.exec('BEGIN IMMEDIATE');
    try {
      driver.exec(migration.sql);
      // schema_migrations existe siempre después de 0001_init (la crea esa propia migración).
      driver.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, checksumOf(migration.sql), Date.now());
      driver.pragma(`user_version = ${migration.version}`);
      driver.exec('COMMIT');
    } catch (error) {
      driver.exec('ROLLBACK');
      throw error;
    }
  }
}

export { MIGRATIONS };
export type { Migration };
