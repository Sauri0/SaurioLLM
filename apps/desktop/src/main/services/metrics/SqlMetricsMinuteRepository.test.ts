// Test de la guarda contra base cerrada (bug real v0.2.0, doc 16 "crash al cerrar" — diálogo nativo
// "TypeError: The database connection is not open", stack BetterSqlite3Driver.prepare <-
// SqlMetricsMinuteRepository.flush <- flushCurrent <- MetricsTicker.dispose <- EventEmitter).
// Reproduce EXACTAMENTE ese `TypeError` con un driver falso que se comporta como better-sqlite3
// después de `close()`, y prueba que `SqlMetricsMinuteRepository` lo atrapa en vez de dejarlo escapar.
import { describe, expect, it, vi } from 'vitest';
import type { SqliteDriver } from '@saurio/runtime/persistence/driver';
import { SqlMetricsMinuteRepository } from './SqlMetricsMinuteRepository.js';

/** Driver falso mínimo: `prepare()/exec()` funcionan hasta `close()`; después, lanzan el mismo
 *  `TypeError` verbatim que better-sqlite3 (mensaje real, no un texto inventado). */
function createFakeDriver(): SqliteDriver & { close(): void } {
  let open = true;
  const assertOpen = (): void => {
    if (!open) throw new TypeError('The database connection is not open');
  };
  return {
    exec: () => assertOpen(),
    prepare: () => {
      assertOpen();
      return { run: () => { assertOpen(); return { changes: 1, lastInsertRowid: 1 }; }, get: () => undefined, all: () => [] };
    },
    pragma: () => undefined,
    close: () => { open = false; },
  };
}

describe('SqlMetricsMinuteRepository — dispose después de close (bug real v0.2.0)', () => {
  it('flushCurrent() no lanza si la base ya se cerró (MetricsTicker.dispose() tarde en el apagado)', () => {
    const driver = createFakeDriver();
    const now = 0;
    const repo = new SqlMetricsMinuteRepository(driver, () => now);

    repo.addSample({ cpuPct: 10, ramUsedBytes: 100, quality: { cpu: 'measured', ram: 'measured' } });

    driver.close(); // simula RuntimeHost.dispose() ya corrido (orden equivocado / apagado en curso)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => repo.flushCurrent()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('addSample()->flush() por cambio de minuto tampoco lanza con la base cerrada', () => {
    const driver = createFakeDriver();
    let now = 0;
    const repo = new SqlMetricsMinuteRepository(driver, () => now);
    repo.addSample({ cpuPct: 1, quality: { cpu: 'measured' } });

    driver.close();
    now = 60_000; // cambia de minuto: addSample() dispara flush() del minuto anterior
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => repo.addSample({ cpuPct: 2, quality: { cpu: 'measured' } })).not.toThrow();
    warn.mockRestore();
  });

  it('pruneOlderThan30Days() no lanza si la base ya se cerró', () => {
    const driver = createFakeDriver();
    const repo = new SqlMetricsMinuteRepository(driver);
    driver.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => repo.pruneOlderThan30Days()).not.toThrow();
    warn.mockRestore();
  });

  it('sigue relanzando errores que NO son "base cerrada" (no se traga cualquier excepción)', () => {
    const driver: SqliteDriver = {
      exec: () => { throw new Error('otro error real'); },
      prepare: () => ({ run: () => { throw new Error('otro error real'); }, get: () => undefined, all: () => [] }),
      pragma: () => undefined,
      close: () => {},
    };
    const repo = new SqlMetricsMinuteRepository(driver);
    expect(() => repo.pruneOlderThan30Days()).toThrow('otro error real');
  });
});
