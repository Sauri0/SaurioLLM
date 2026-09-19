import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPersistence, type PersistenceHandle } from '@saurio/runtime/persistence/index';
import { SqlAuditLogRepository, type NonLocalResultEntry } from './SqlAuditLogRepository.js';

describe('SqlAuditLogRepository — ledger de uso no local', () => {
  let tmp: string;
  let dbPath: string;
  let persistence: PersistenceHandle;
  let repo: SqlAuditLogRepository;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'saurio-usage-ledger-'));
    dbPath = path.join(tmp, 'saurio.db');
    persistence = openPersistence(dbPath);
    repo = new SqlAuditLogRepository(persistence.driver);
  });

  afterEach(() => {
    persistence.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function record(patch: Partial<NonLocalResultEntry> = {}): void {
    repo.recordNonLocalResult({
      providerId: 'openrouter',
      modelName: 'modelo',
      locality: 'cloud',
      runId: 'run-a',
      callId: `call-${Math.random()}`,
      ts: 100,
      metrics: { quality: 'estimated', costUsd: 0.25, costSource: 'reported' },
      error: false,
      interrupted: false,
      ...patch,
    });
  }

  it('devuelve cero sin filas y persiste costos reportados, estimados y desconocidos', () => {
    expect(repo.usageSummary()).toEqual({
      reportedUsd: 0, reportedCalls: 0,
      estimatedUsd: 0, estimatedCalls: 0,
      unavailableCalls: 0, totalCalls: 0,
    });

    record({ callId: 'reported-zero', metrics: { quality: 'estimated', costUsd: 0, costSource: 'reported' } });
    record({ callId: 'reported', metrics: { quality: 'estimated', costUsd: 0.25, costSource: 'reported' } });
    record({ callId: 'estimated', metrics: { quality: 'estimated', costUsd: 0.1, costSource: 'estimated' } });
    record({ callId: 'missing', metrics: { quality: 'estimated', costSource: 'unavailable' } });
    record({
      callId: 'stream-error', error: true,
      metrics: { quality: 'estimated', costUsd: 9, costSource: 'reported' },
    });
    record({
      callId: 'abort', interrupted: true,
      metrics: { quality: 'estimated', costUsd: 7, costSource: 'reported' },
    });

    expect(repo.usageSummary()).toEqual({
      reportedUsd: 0.25, reportedCalls: 2,
      estimatedUsd: 0.1, estimatedCalls: 1,
      unavailableCalls: 3, totalCalls: 6,
    });
  });

  it('filtra inclusivamente por since y por runId, y conserva el ledger al reabrir SQLite', () => {
    record({ callId: 'old-a', runId: 'run-a', ts: 99 });
    record({ callId: 'new-a', runId: 'run-a', ts: 100, metrics: { quality: 'estimated', costUsd: 0.4, costSource: 'reported' } });
    record({ callId: 'new-b', runId: 'run-b', ts: 101, metrics: { quality: 'estimated', costUsd: 0.2, costSource: 'estimated' } });

    persistence.close();
    persistence = openPersistence(dbPath);
    repo = new SqlAuditLogRepository(persistence.driver);

    expect(repo.usageSummary({ since: 100, runId: 'run-a' })).toEqual({
      reportedUsd: 0.4, reportedCalls: 1,
      estimatedUsd: 0, estimatedCalls: 0,
      unavailableCalls: 0, totalCalls: 1,
    });
    expect(repo.usageSummary({ since: 100 }).totalCalls).toBe(2);
  });

  it('trata payloads viejos, inválidos y sumas no finitas como costo no disponible', () => {
    repo.recordNonLocalCall({
      providerId: 'anthropic', modelName: 'claude', locality: 'cloud', runId: 'legacy', ts: 1,
    });
    persistence.driver.prepare(
      'INSERT INTO audit_log (ts, kind, payload_json) VALUES (?, ?, ?)',
    ).run(2, 'provider.non_local_call', '{json roto');
    record({ callId: 'huge-1', ts: 3, metrics: { quality: 'estimated', costUsd: 1e308, costSource: 'reported' } });
    record({ callId: 'huge-2', ts: 4, metrics: { quality: 'estimated', costUsd: 1e308, costSource: 'reported' } });

    const summary = repo.usageSummary();
    expect(summary.reportedUsd).toBe(1e308);
    expect(summary.reportedCalls).toBe(1);
    expect(summary.unavailableCalls).toBe(3);
    expect(summary.totalCalls).toBe(4);
  });

  it('no persiste contenido, headers ni claves dentro de la fila de costo', () => {
    record({ callId: 'safe-call' });
    const row = persistence.driver.prepare<{ payload_json: string }>(
      'SELECT payload_json FROM audit_log WHERE kind = ?',
    ).get('provider.non_local_call');

    expect(row?.payload_json).toContain('safe-call');
    expect(row?.payload_json).not.toMatch(/prompt|message|content|header|api.?key|secret/i);
  });
});
