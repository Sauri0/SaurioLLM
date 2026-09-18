// Punto de entrada de packages/runtime/src/persistence/: abre la base, aplica migraciones
// embebidas y devuelve driver + EventStore + repositorios listos para usar (doc 02 §1).
import { openDriver, type SqliteDriver } from './driver.js';
import { runMigrations } from './migrations/index.js';
import { createRepositories, type Repositories } from './repositories/index.js';
import { SqliteEventStore } from '../events/index.js';
import type { EventStore } from './types.js';

export interface PersistenceHandle {
  driver: SqliteDriver;
  eventStore: EventStore;
  repositories: Repositories;
  close(): void;
}

/** Abre `path` (o ':memory:' en tests), aplica PRAGMAs + migraciones pendientes (doc 03 §2/§8) y
 *  devuelve un handle con el driver, el EventStore y los repositorios tipados. */
export function openPersistence(path: string): PersistenceHandle {
  const driver = openDriver(path);
  runMigrations(driver);
  return {
    driver,
    eventStore: new SqliteEventStore(driver),
    repositories: createRepositories(driver),
    close: () => driver.close(),
  };
}

export { openDriver, type SqliteDriver, type SqliteRow, type PreparedStatement } from './driver.js';
export { runMigrations, NewerSchemaError } from './migrations/index.js';
export { createRepositories, type Repositories } from './repositories/index.js';
export { SqliteEventStore, createProjector } from '../events/index.js';
export * from './types.js';
