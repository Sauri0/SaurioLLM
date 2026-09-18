// Escritura sobre la tabla genérica `audit_log` (id, ts, kind, payload_json — ya migrada, doc 03) —
// apps/desktop/src/main/services/audit/SqlAuditLogRepository.ts. Mismo patrón que
// services/downloads/SqlDownloadsRepository.ts: SQL directo sobre el `SqliteDriver` ya expuesto por
// `openPersistence()`, sin tocar packages/runtime/src/persistence (zona de otro agente).
//
// Punto 4 del encargo ("registrar en audit_log cada llamada no local"): la única fila que este
// repositorio escribe hoy es `kind: 'provider.non_local_call'`, alimentada desde el hook
// `ModelGatewayHooks.onNonLocalCall` (packages/runtime/src/gateway/ModelGateway.ts, cambio aditivo de
// esta misma tarea) — es el único punto por el que pasa TODA llamada de inferencia no local,
// independientemente del caller (chat normal, compactación, etc.), así que no hace falta instrumentar
// nada más para que quede completo.
import type { SqliteDriver } from '@saurio/runtime/persistence/driver';
import type { NonLocalCallAuditEntry, Locality } from '@saurio/shared';

interface AuditLogRow {
  [key: string]: unknown;
  id: number;
  ts: number;
  kind: string;
  payload_json: string;
}

const NON_LOCAL_CALL_KIND = 'provider.non_local_call';

export class SqlAuditLogRepository {
  constructor(private readonly driver: SqliteDriver) {}

  recordNonLocalCall(entry: { providerId: string; modelName: string; locality: Locality; runId: string; ts: number }): void {
    this.driver.prepare('INSERT INTO audit_log (ts, kind, payload_json) VALUES (@ts, @kind, @payload)').run({
      ts: entry.ts,
      kind: NON_LOCAL_CALL_KIND,
      payload: JSON.stringify({ providerId: entry.providerId, modelName: entry.modelName, locality: entry.locality, runId: entry.runId }),
    });
  }

  listNonLocalCalls(limit = 200): NonLocalCallAuditEntry[] {
    const rows = this.driver.prepare<AuditLogRow>(
      'SELECT * FROM audit_log WHERE kind = ? ORDER BY ts DESC LIMIT ?',
    ).all(NON_LOCAL_CALL_KIND, limit);
    return rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as { providerId: string; modelName: string; locality: Locality; runId: string };
      return { id: row.id, ts: row.ts, providerId: payload.providerId, modelName: payload.modelName, locality: payload.locality, runId: payload.runId };
    });
  }
}
