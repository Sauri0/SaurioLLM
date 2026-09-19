// Escritura sobre la tabla genérica `audit_log` (id, ts, kind, payload_json — ya migrada, doc 03) —
// apps/desktop/src/main/services/audit/SqlAuditLogRepository.ts. Mismo patrón que
// services/downloads/SqlDownloadsRepository.ts: SQL directo sobre el `SqliteDriver` ya expuesto por
// `openPersistence()`, sin tocar packages/runtime/src/persistence (zona de otro agente).
//
// Las llamadas no locales usan `kind: 'provider.non_local_call'`. El hook de resultado de
// ModelGateway es el único punto por el que pasan chat, reintentos y compactaciones: persiste una
// fila por invocación realmente iniciada, con costo reportado/estimado o indisponible.
import type { SqliteDriver } from '@saurio/runtime/persistence/driver';
import type { IpcOutput, NonLocalCallAuditEntry, Locality, ResponseMetrics } from '@saurio/shared';

interface AuditLogRow {
  [key: string]: unknown;
  id: number;
  ts: number;
  kind: string;
  payload_json: string;
}

const NON_LOCAL_CALL_KIND = 'provider.non_local_call';

export interface NonLocalResultEntry {
  providerId: string;
  modelName: string;
  locality: Locality;
  runId: string;
  callId: string;
  ts: number;
  metrics?: ResponseMetrics;
  error: boolean;
  interrupted: boolean;
}

export type ProviderUsageSummary = IpcOutput<'providers:usageSummary'>;

export class SqlAuditLogRepository {
  constructor(private readonly driver: SqliteDriver) {}

  recordNonLocalCall(entry: { providerId: string; modelName: string; locality: Locality; runId: string; ts: number }): void {
    this.driver.prepare('INSERT INTO audit_log (ts, kind, payload_json) VALUES (@ts, @kind, @payload)').run({
      ts: entry.ts,
      kind: NON_LOCAL_CALL_KIND,
      payload: JSON.stringify({ providerId: entry.providerId, modelName: entry.modelName, locality: entry.locality, runId: entry.runId }),
    });
  }

  /** Una fila por llamada terminada. Sólo persiste identidad técnica, resultado y costo; nunca
   *  mensajes, prompts, respuestas, headers ni claves. Error/interrupción siempre queda con costo
   *  no disponible aunque un provider haya emitido métricas parciales antes de cortarse. */
  recordNonLocalResult(entry: NonLocalResultEntry): void {
    const source = !entry.error && !entry.interrupted
      && (entry.metrics?.costSource === 'reported' || entry.metrics?.costSource === 'estimated')
      && isValidCost(entry.metrics.costUsd)
      ? entry.metrics.costSource
      : 'unavailable';
    const payload = {
      providerId: entry.providerId,
      modelName: entry.modelName,
      locality: entry.locality,
      runId: entry.runId,
      callId: entry.callId,
      status: entry.interrupted ? 'interrupted' : entry.error ? 'error' : 'completed',
      costSource: source,
      ...(source === 'unavailable' ? {} : { costUsd: entry.metrics?.costUsd }),
    };
    this.driver.prepare('INSERT INTO audit_log (ts, kind, payload_json) VALUES (@ts, @kind, @payload)').run({
      ts: entry.ts,
      kind: NON_LOCAL_CALL_KIND,
      payload: JSON.stringify(payload),
    });
  }

  /** Punto 1a del encargo (feedback real v0.2.1): "unrestricted... queda en audit_log" — genérico a
   *  propósito (`kind`/`payload`) para no tener que sumar un método dedicado por cada evento de
   *  auditoría futuro que solo necesite `{ ts, kind, payload }`. */
  record(entry: { kind: string; payload: unknown; ts?: number }): void {
    this.driver.prepare('INSERT INTO audit_log (ts, kind, payload_json) VALUES (@ts, @kind, @payload)').run({
      ts: entry.ts ?? Date.now(),
      kind: entry.kind,
      payload: JSON.stringify(entry.payload),
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

  usageSummary(filter: { since?: number; runId?: string } = {}): ProviderUsageSummary {
    const rows = filter.since === undefined
      ? this.driver.prepare<AuditLogRow>(
        'SELECT * FROM audit_log WHERE kind = ? ORDER BY ts ASC',
      ).all(NON_LOCAL_CALL_KIND)
      : this.driver.prepare<AuditLogRow>(
        'SELECT * FROM audit_log WHERE kind = ? AND ts >= ? ORDER BY ts ASC',
      ).all(NON_LOCAL_CALL_KIND, filter.since);
    const summary: ProviderUsageSummary = {
      reportedUsd: 0,
      reportedCalls: 0,
      estimatedUsd: 0,
      estimatedCalls: 0,
      unavailableCalls: 0,
      totalCalls: 0,
    };

    for (const row of rows) {
      const payload = parsePayload(row.payload_json);
      if (filter.runId !== undefined && payload?.runId !== filter.runId) continue;
      summary.totalCalls += 1;
      const source = payload?.costSource;
      const cost = payload?.costUsd;
      const nextReported = source === 'reported' && isValidCost(cost)
        ? safeAdd(summary.reportedUsd, cost)
        : undefined;
      const nextEstimated = source === 'estimated' && isValidCost(cost)
        ? safeAdd(summary.estimatedUsd, cost)
        : undefined;
      if (nextReported !== undefined) {
        summary.reportedUsd = nextReported;
        summary.reportedCalls += 1;
      } else if (nextEstimated !== undefined) {
        summary.estimatedUsd = nextEstimated;
        summary.estimatedCalls += 1;
      } else {
        summary.unavailableCalls += 1;
      }
    }
    return summary;
  }
}

function parsePayload(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function isValidCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function safeAdd(current: number, increment: number): number | undefined {
  const total = current + increment;
  return Number.isFinite(total) && total >= 0 ? total : undefined;
}
