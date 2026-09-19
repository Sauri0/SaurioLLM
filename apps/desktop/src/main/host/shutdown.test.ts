// Test de apagado ordenado/idempotente (apps/desktop/src/main/host/shutdown.ts) — reproduce el bug
// real de v0.2.0 ("TypeError: The database connection is not open" al cerrar la app: MetricsTicker
// volcaba el minuto en curso DESPUÉS de que la persistencia ya estaba cerrada) y prueba que el orden
// fijo de `createShutdown` lo evita, además de la idempotencia pedida por el encargo.
import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from './shutdown.js';

describe('createShutdown', () => {
  it('llama a cada dependencia una sola vez aunque se invoque el shutdown más de una vez (idempotente)', () => {
    const stopTickers = vi.fn();
    const cleanupExtras = vi.fn();
    const closePersistence = vi.fn();
    const stopOwnOllama = vi.fn();
    const shutdown = createShutdown({ stopTickers, cleanupExtras, closePersistence, stopOwnOllama });

    shutdown();
    shutdown();
    shutdown();

    expect(stopTickers).toHaveBeenCalledTimes(1);
    expect(cleanupExtras).toHaveBeenCalledTimes(1);
    expect(closePersistence).toHaveBeenCalledTimes(1);
    expect(stopOwnOllama).toHaveBeenCalledTimes(1);
  });

  it('para los tickers/pollers ANTES de cerrar la persistencia (orden fijo, no el de construcción)', () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      stopTickers: () => order.push('stopTickers'),
      cleanupExtras: () => order.push('cleanupExtras'),
      closePersistence: () => order.push('closePersistence'),
      stopOwnOllama: () => order.push('stopOwnOllama'),
    });

    shutdown();

    expect(order).toEqual(['stopTickers', 'cleanupExtras', 'closePersistence', 'stopOwnOllama']);
  });

  it('funciona sin cleanupExtras (opcional)', () => {
    const closePersistence = vi.fn();
    const shutdown = createShutdown({ stopTickers: () => {}, closePersistence, stopOwnOllama: () => {} });
    expect(() => shutdown()).not.toThrow();
    expect(closePersistence).toHaveBeenCalledTimes(1);
  });

  it('reproduce el bug real de v0.2.0: si el orden fuera al revés (persistencia cerrada antes del ' +
    'flush de MetricsTicker), el flush lanzaría "The database connection is not open" — con el orden ' +
    'correcto de createShutdown, stopTickers (que simula MetricsTicker.dispose()->flushCurrent()) ' +
    'corre mientras la base todavía está abierta y nunca lanza.', () => {
    let dbOpen = true;
    const stopTickers = (): void => {
      // Simula SqlMetricsMinuteRepository.flush() escribiendo en la base — si `closePersistence` ya
      // hubiera corrido, esto es exactamente el TypeError real reportado por el usuario.
      if (!dbOpen) throw new TypeError('The database connection is not open');
    };
    const closePersistence = (): void => {
      dbOpen = false;
    };
    const shutdown = createShutdown({ stopTickers, closePersistence, stopOwnOllama: () => {} });

    expect(() => shutdown()).not.toThrow();
    expect(dbOpen).toBe(false);
  });
});
