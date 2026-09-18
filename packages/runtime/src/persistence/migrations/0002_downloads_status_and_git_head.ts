// Migración 2 — packages/runtime/src/persistence/migrations/0002_downloads_status_and_git_head.ts.
// Dos cierres de cabos sueltos que la migración 1 dejó documentados como pendientes (doc 16 §8 punto
// 1, doc 09 §2.2/§5.3 Nomenclatura agregada), ninguno de los dos con implementación previa que dependa
// del valor exacto de la columna, así que agregarlos no rompe filas existentes:
//
// 1. `downloads.status` no admitía `'insufficient_space'` (doc 13 §5 punto 1): el `CHECK` original
//    (migración 1) solo permite `queued|running|paused|cancelled|done|failed`, así que
//    `DownloadManager.pull()` (packages/runtime/src/models/, fuera de esta zona) tenía que rechazar
//    con `InsufficientSpaceError` ANTES de crear cualquier fila, en vez de poder persistir ese estado.
//    SQLite no soporta `ALTER TABLE ... DROP/MODIFY CONSTRAINT` para ensanchar un `CHECK`: hay que
//    reconstruir la tabla (crear la nueva con el CHECK ampliado, copiar filas, borrar la vieja,
//    renombrar). No hace falta el proceso completo de "12 pasos" de sqlite.org/lang_altertable.html
//    (deshabilitar foreign_keys, recrear triggers/vistas) porque `downloads` no tiene triggers/vistas
//    propias y ninguna otra tabla de la migración 1 la referencia (grep sobre 0001_init.ts: cero
//    "REFERENCES downloads") — solo su propio FK saliente hacia `providers`, que se preserva igual.
// 2. `checkpoints.git_head` (doc 09 §2.2, §5.3, Nomenclatura agregada): dos lecturas de solo lectura
//    de git (`git rev-parse HEAD` / `--abbrev-ref HEAD`) tomadas en `CheckpointService.begin()`, que
//    `planRevert()` usa para poblar `RevertPlan.branchChanged` (doc 09 §5.3) cuando el repositorio
//    cambió de rama/commit entre el checkpoint y el revert. Columna simple, nullable, sin CHECK: un
//    `ALTER TABLE ... ADD COLUMN` alcanza, sin reconstruir la tabla.
import type { Migration } from './types.js';

export const migration0002: Migration = {
  version: 2,
  name: '0002_downloads_status_and_git_head',
  sql: `
CREATE TABLE downloads_new (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL REFERENCES providers(id),
  model_name   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued','running','paused','cancelled','done','failed','insufficient_space')),
  total        INTEGER,
  completed    INTEGER,
  layers_json  TEXT,
  started_at   INTEGER,
  finished_at  INTEGER,
  error        TEXT
);
INSERT INTO downloads_new (id, provider_id, model_name, status, total, completed, layers_json, started_at, finished_at, error)
  SELECT id, provider_id, model_name, status, total, completed, layers_json, started_at, finished_at, error FROM downloads;
DROP TABLE downloads;
ALTER TABLE downloads_new RENAME TO downloads;
CREATE INDEX downloads_status ON downloads(status, started_at DESC);

ALTER TABLE checkpoints ADD COLUMN git_head TEXT;
`,
};
