// Implementación SQL directa de `DownloadsRepositoryPort` sobre la tabla `downloads` ya migrada
// (packages/runtime/src/persistence/migrations/0001_init.ts) — apps/desktop/src/main/services/
// downloads/SqlDownloadsRepository.ts. `packages/runtime/src/persistence` es zona de otro agente
// (trabaja en paralelo en agent/context/permissions/tasks/events/persistence); esta clase vive acá y
// usa solo el `SqliteDriver` YA EXPUESTO por `openPersistence()` (`prepare/run/get`, sin tocar el
// esquema ni los repositorios de esa carpeta), igual que `createRuntime.ts` ya usa `driver` para
// abrir la base. No agrega columnas ni migraciones nuevas.
import type { SqliteDriver } from '@saurio/runtime/persistence/driver';
import type { DownloadRecord, DownloadsRepositoryPort } from '@saurio/runtime/models/index';

interface DownloadRow {
  [key: string]: unknown;
  id: string;
  provider_id: string;
  model_name: string;
  status: string;
  total: number | null;
  completed: number | null;
  layers_json: string | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
}

function toRecord(row: DownloadRow): DownloadRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelName: row.model_name,
    status: row.status as DownloadRecord['status'],
    total: row.total ?? undefined,
    completed: row.completed ?? undefined,
    layersJson: row.layers_json ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
  };
}

/** `downloads.status` (CHECK ampliado por la migración 0002) admite `queued|running|paused|
 *  cancelled|done|failed|insufficient_space` (doc 13 §5 punto 1, doc 16 §8 punto 1 / punto 2 del
 *  encargo). `DownloadManager.pull()` (packages/runtime/src/models/DownloadManager.ts) persiste esa
 *  fila ANTES de lanzar `InsufficientSpaceError`, para que la pestaña Descargas la muestre. */
export class SqlDownloadsRepository implements DownloadsRepositoryPort {
  constructor(private readonly driver: SqliteDriver) {}

  async save(record: DownloadRecord): Promise<void> {
    this.driver.prepare(`
      INSERT INTO downloads (id, provider_id, model_name, status, total, completed, layers_json, started_at, finished_at, error)
      VALUES (@id, @providerId, @modelName, @status, @total, @completed, @layersJson, @startedAt, @finishedAt, @error)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, total = excluded.total, completed = excluded.completed,
        layers_json = excluded.layers_json, finished_at = excluded.finished_at, error = excluded.error
    `).run({
      id: record.id,
      providerId: record.providerId,
      modelName: record.modelName,
      status: record.status,
      total: record.total ?? null,
      completed: record.completed ?? null,
      layersJson: record.layersJson ?? null,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      error: record.error ?? null,
    });
  }

  async get(id: string): Promise<DownloadRecord | undefined> {
    const row = this.driver.prepare<DownloadRow>('SELECT * FROM downloads WHERE id = ?').get(id);
    return row ? toRecord(row) : undefined;
  }

  async listActiveOrRecent(limit = 50): Promise<DownloadRecord[]> {
    const rows = this.driver.prepare<DownloadRow>(
      'SELECT * FROM downloads ORDER BY started_at DESC LIMIT ?',
    ).all(limit);
    return rows.map(toRecord);
  }
}

/** Siembra `providers` (tabla vacía hasta ahora: nadie insertaba filas todavía, doc 13/16 no lo
 *  registraba como gap porque `downloads.provider_id` es la primera FK real hacia esa tabla) para
 *  que la FK `downloads.provider_id REFERENCES providers(id)` no falle al guardar la primera
 *  descarga. Idempotente (`INSERT OR IGNORE`); no migra el esquema, solo agrega datos. */
export function seedOllamaProviderRow(driver: SqliteDriver, providerId: string, baseUrl: string): void {
  const isLoopback = /^(https?:\/\/)?(127\.0\.0\.1|localhost)([:/]|$)/i.test(baseUrl) ? 1 : 0;
  // `config_json` (punto 3 del encargo, Ajustes > Proveedores): `preset`/`label` para que
  // SqlProvidersRepository.list() muestre "Ollama (local)" en vez de caer al fallback (id crudo).
  driver.prepare(`
    INSERT OR IGNORE INTO providers (id, kind, transport, base_url, is_loopback, enabled, mode, max_concurrency, config_json)
    VALUES (@id, 'ollama', 'http', @baseUrl, @isLoopback, 1, 'attach', 1, @configJson)
  `).run({ id: providerId, baseUrl, isLoopback, configJson: JSON.stringify({ preset: 'ollama', label: 'Ollama (local)' }) });
}

/** `DownloadRecord` (persistido) -> `DownloadJob` (forma que cruza IPC, packages/shared/src/domain.ts).
 *  Punto 5 del encargo ("historial de Descargas desde SqlDownloadsRepository por IPC para que
 *  sobreviva reinicios"): `bytesPerSec`/`etaMs` quedan `undefined` para el historial persistido (no se
 *  recalculan retroactivamente; solo `DownloadManager.listAll()`, en memoria, los tiene mientras la
 *  descarga está en curso en ESTE proceso). */
export function toDownloadJob(record: DownloadRecord): import('@saurio/shared').DownloadJob {
  let layers: { digest: string; total: number; completed: number }[] = [];
  if (record.layersJson) {
    try {
      layers = JSON.parse(record.layersJson) as typeof layers;
    } catch {
      layers = [];
    }
  }
  return {
    id: record.id,
    providerId: record.providerId,
    modelName: record.modelName,
    status: record.status,
    totalBytes: record.total ?? 0,
    completedBytes: record.completed ?? 0,
    layers,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
  };
}
