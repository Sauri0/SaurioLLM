// Test de apagado ordenado/idempotente (apps/desktop/src/main/host/shutdown.ts) — reproduce el bug
// real de v0.2.0 ("TypeError: The database connection is not open" al cerrar la app: MetricsTicker
// volcaba el minuto en curso DESPUÉS de que la persistencia ya estaba cerrada) y prueba que el orden
// fijo de `createShutdown` lo evita, además de la idempotencia pedida por el encargo.
import { describe, expect, it, vi } from 'vitest';
import { createSafeShutdownController, createShutdown } from './shutdown.js';

describe('createShutdown', () => {
  it('llama a cada dependencia una sola vez aunque se invoque el shutdown más de una vez (idempotente)', async () => {
    const stopTickers = vi.fn();
    const cleanupExtras = vi.fn();
    const closePersistence = vi.fn();
    const stopOwnOllama = vi.fn();
    const shutdown = createShutdown({ stopTickers, cleanupExtras, closePersistence, stopOwnOllama });

    await Promise.all([shutdown(), shutdown(), shutdown()]);

    expect(stopTickers).toHaveBeenCalledTimes(1);
    expect(cleanupExtras).toHaveBeenCalledTimes(1);
    expect(closePersistence).toHaveBeenCalledTimes(1);
    expect(stopOwnOllama).toHaveBeenCalledTimes(1);
  });

  it('confirma el stop propio y luego para tickers antes de cerrar la persistencia', async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      stopTickers: () => order.push('stopTickers'),
      cleanupExtras: () => order.push('cleanupExtras'),
      closePersistence: () => order.push('closePersistence'),
      stopOwnOllama: () => { order.push('stopOwnOllama'); },
    });

    await shutdown();

    expect(order).toEqual(['stopOwnOllama', 'stopTickers', 'cleanupExtras', 'closePersistence']);
  });

  it('funciona sin cleanupExtras (opcional)', async () => {
    const closePersistence = vi.fn();
    const shutdown = createShutdown({ stopTickers: () => {}, closePersistence, stopOwnOllama: () => {} });
    await expect(shutdown()).resolves.toBeUndefined();
    expect(closePersistence).toHaveBeenCalledTimes(1);
  });

  it('reproduce el bug real de v0.2.0: si el orden fuera al revés (persistencia cerrada antes del ' +
    'flush de MetricsTicker), el flush lanzaría "The database connection is not open" — con el orden ' +
    'correcto de createShutdown, stopTickers (que simula MetricsTicker.dispose()->flushCurrent()) ' +
    'corre mientras la base todavía está abierta y nunca lanza.', async () => {
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

    await expect(shutdown()).resolves.toBeUndefined();
    expect(dbOpen).toBe(false);
  });

  it('si detener Ollama vence, no cierra recursos y permite reintentar el mismo shutdown', async () => {
    const order: string[] = [];
    let attempts = 0;
    const shutdown = createShutdown({
      stopOwnOllama: async () => {
        order.push(`stop-${++attempts}`);
        if (attempts === 1) throw new Error('motor todavía activo');
      },
      stopTickers: () => order.push('stopTickers'),
      closePersistence: () => order.push('closePersistence'),
    });

    await expect(shutdown()).rejects.toThrow('motor todavía activo');
    expect(order).toEqual(['stop-1']);

    await expect(shutdown()).resolves.toBeUndefined();
    expect(order).toEqual(['stop-1', 'stop-2', 'stopTickers', 'closePersistence']);
  });
});

describe('createSafeShutdownController', () => {
  function makeController(overrides: Partial<Parameters<typeof createSafeShutdownController>[0]> = {}) {
    const order: string[] = [];
    const deps: Parameters<typeof createSafeShutdownController>[0] = {
      listActiveRuns: vi.fn(async () => []),
      confirmActiveRuns: vi.fn(async () => 'continue_working' as const),
      cancelActiveRunsAndWait: vi.fn(async () => {}),
      showShutdownError: vi.fn(async () => 'continue_working' as const),
      finalize: vi.fn(() => { order.push('finalize'); }),
      resumeQuit: vi.fn(() => order.push('resumeQuit')),
      ...overrides,
    };
    return { controller: createSafeShutdownController(deps), deps, order };
  }

  it('cierra en reposo sin diálogo y completa holgadamente antes del límite de 2 s', async () => {
    const { controller, deps, order } = makeController();
    const startedAt = performance.now();

    await expect(controller.requestQuit()).resolves.toBe(true);

    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(deps.confirmActiveRuns).not.toHaveBeenCalled();
    expect(deps.cancelActiveRunsAndWait).not.toHaveBeenCalled();
    expect(order).toEqual(['finalize', 'resumeQuit']);
  });

  it('no reanuda app.quit hasta que finaliza el stop asíncrono', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const { controller, deps, order } = makeController({
      finalize: vi.fn(async () => {
        order.push('finalize-start');
        await waiting;
        order.push('finalize-end');
      }),
    });

    const request = controller.requestQuit();
    await vi.waitFor(() => expect(order).toEqual(['finalize-start']));
    expect(deps.resumeQuit).not.toHaveBeenCalled();
    release();

    await expect(request).resolves.toBe(true);
    expect(order).toEqual(['finalize-start', 'finalize-end', 'resumeQuit']);
  });

  it('deja la app y la persistencia abiertas cuando el usuario elige seguir trabajando', async () => {
    const { controller, deps, order } = makeController({
      listActiveRuns: vi.fn(async () => [{ id: 'run-activo' }]),
      confirmActiveRuns: vi.fn(async () => 'continue_working' as const),
    });

    await expect(controller.requestQuit()).resolves.toBe(false);

    expect(deps.confirmActiveRuns).toHaveBeenCalledWith(1);
    expect(deps.cancelActiveRunsAndWait).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(controller.isFinalizing()).toBe(false);
  });

  it('espera estado terminal persistido antes de cerrar cuando el usuario elige detener', async () => {
    let active = true;
    const order: string[] = [];
    const { controller, deps } = makeController({
      listActiveRuns: vi.fn(async () => active ? [{ id: 'padre' }, { id: 'hijo' }] : []),
      confirmActiveRuns: vi.fn(async () => 'stop_and_quit' as const),
      cancelActiveRunsAndWait: vi.fn(async () => {
        order.push('cancel-and-terminal');
        active = false;
      }),
      finalize: vi.fn(() => { order.push('finalize'); }),
      resumeQuit: vi.fn(() => order.push('resumeQuit')),
    });

    await expect(controller.requestQuit()).resolves.toBe(true);

    expect(deps.confirmActiveRuns).toHaveBeenCalledWith(2);
    expect(order).toEqual(['cancel-and-terminal', 'finalize', 'resumeQuit']);
  });

  it('ante un error no cierra SQLite y permite reintentar la cancelación sin pedir otra confirmación', async () => {
    let active = true;
    let attempts = 0;
    const finalize = vi.fn();
    const confirm = vi.fn(async () => 'stop_and_quit' as const);
    const { controller, deps } = makeController({
      listActiveRuns: vi.fn(async () => active ? [{ id: 'run-activo' }] : []),
      confirmActiveRuns: confirm,
      cancelActiveRunsAndWait: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('falló el primer intento');
        active = false;
      }),
      showShutdownError: vi.fn(async () => 'retry' as const),
      finalize,
    });

    await expect(controller.requestQuit()).resolves.toBe(true);

    expect(deps.showShutdownError).toHaveBeenCalledTimes(1);
    expect(deps.cancelActiveRunsAndWait).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('si el usuario no reintenta después del error mantiene persistencia y proceso vivos', async () => {
    const { controller, deps, order } = makeController({
      listActiveRuns: vi.fn(async () => [{ id: 'run-activo' }]),
      confirmActiveRuns: vi.fn(async () => 'stop_and_quit' as const),
      cancelActiveRunsAndWait: vi.fn(async () => { throw new Error('no terminó'); }),
      showShutdownError: vi.fn(async () => 'continue_working' as const),
    });

    await expect(controller.requestQuit()).resolves.toBe(false);

    expect(deps.showShutdownError).toHaveBeenCalledTimes(1);
    expect(order).toEqual([]);
    expect(controller.isFinalizing()).toBe(false);
  });

  it('deduplica pedidos simultáneos y deja pasar únicamente la segunda pasada de before-quit', async () => {
    let releaseList!: () => void;
    const waiting = new Promise<void>((resolve) => { releaseList = resolve; });
    const { controller, deps } = makeController({
      listActiveRuns: vi.fn(async () => { await waiting; return []; }),
    });
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };

    controller.handleBeforeQuit(firstEvent);
    controller.handleBeforeQuit(secondEvent);
    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(secondEvent.preventDefault).toHaveBeenCalledTimes(1);
    releaseList();
    await vi.waitFor(() => expect(deps.resumeQuit).toHaveBeenCalledTimes(1));

    const finalEvent = { preventDefault: vi.fn() };
    controller.handleBeforeQuit(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(deps.listActiveRuns).toHaveBeenCalledTimes(1);
  });
});
