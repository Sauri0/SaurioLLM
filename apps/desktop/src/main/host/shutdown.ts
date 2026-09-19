// Apagado único, ordenado e idempotente del proceso main — apps/desktop/src/main/host/shutdown.ts.
//
// BUG REAL (usuario real, notebook Windows 11 sin NVIDIA, v0.2.0): al cerrar la app aparecía el
// diálogo nativo "A JavaScript error occurred in the main process: TypeError: The database
// connection is not open", con stack `BetterSqlite3Driver.prepare <- SqlMetricsMinuteRepository.flush
// <- flushCurrent <- MetricsTicker.dispose <- EventEmitter`.
//
// CAUSA RAÍZ: `main/index.ts` registraba varios `app.on('before-quit', ...)` sueltos, en el orden en
// que cada pieza se construía durante el arranque — no en el orden en que había que APAGARLAS.
// `host.dispose()` (cierra `saurio.db`) se registraba ANTES que `metricsTicker.dispose()` (que vuelca
// el minuto de métricas en curso a esa misma base). Electron invoca los listeners de un evento en el
// orden en que se registraron: para el momento en que `metricsTicker.dispose()` corría, la base ya
// estaba cerrada y `SqlMetricsMinuteRepository.flush()` reventaba con un `TypeError` sin capturar.
//
// FIX: un único punto de apagado (esta función), con el orden correcto siempre garantizado por
// código (no por el orden en que `main/index.ts` decide construir cada pieza) e idempotente (llamarla
// más de una vez — 'before-quit' puede disparar más de un ciclo, o 'window-all-closed' -> app.quit()
// puede solaparse con un antes-de-quit ya en curso — no repite el trabajo ni vuelve a tocar recursos
// ya liberados).
export interface ShutdownDeps {
  /** Para timers/pollers/samplers que puedan escribir a la persistencia (MetricsTicker.dispose(),
   *  que además vuelca el minuto en curso — DEBE correr antes de `closePersistence`). */
  stopTickers: () => void;
  /** Limpieza que no depende de la base (terminales, watchers de archivos, batcher de eventos de run,
   *  desuscripción de eventos de descarga) — no importa si corre antes o después de `stopTickers`,
   *  pero SIEMPRE antes de `closePersistence` por las dudas de que algo dependa todavía de un run/chat. */
  cleanupExtras?: () => void;
  /** Cierra el runtime real (persistencia/saurio.db) — únicamente después de que TODO lo de arriba
   *  dejó de poder escribir en ella. */
  closePersistence: () => void;
  /** Detiene el `ollama serve` que ESTA app arrancó. Se espera antes de cerrar recursos para que un
   *  timeout pueda mostrarse y reintentarse sin dejar la app a medio cerrar. */
  stopOwnOllama: () => void | Promise<void>;
}

/** Fábrica en vez de una función suelta: permite testear el orden/idempotencia sin depender de
 *  Electron real (`app.on('before-quit', ...)`), y a `main/index.ts` le alcanza con
 *  `app.on('before-quit', createShutdown(deps))`. */
export function createShutdown(deps: ShutdownDeps): () => Promise<void> {
  let done = false;
  let inFlight: Promise<void> | undefined;
  return () => {
    if (done) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      // 1) Confirmar que el árbol propio terminó antes de cerrar recursos irreversibles. Si vence su
      // timeout, el controlador muestra el error y puede reintentar sobre el mismo PID propio.
      await deps.stopOwnOllama();
      // 2) Parar tickers/pollers/samplers y cancelar timers (incluye el flush del minuto en curso).
      deps.stopTickers();
      // 3) Limpieza sin dependencia de la base.
      deps.cleanupExtras?.();
      // 4) Cerrar runtime/persistencia — recién ahora nada más puede intentar escribir en ella.
      deps.closePersistence();
      done = true;
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

export type ActiveRunSummary = { id: string };
export type ActiveRunQuitDecision = 'continue_working' | 'stop_and_quit';
export type ShutdownErrorDecision = 'continue_working' | 'retry';

export interface SafeShutdownDeps {
  /** La consulta sale de la proyección persistida de runs: un evento terminal ya quedó escrito
   * antes de que esta lista pueda quedar vacía. */
  listActiveRuns: () => Promise<ActiveRunSummary[]>;
  confirmActiveRuns: (count: number) => Promise<ActiveRunQuitDecision>;
  cancelActiveRunsAndWait: () => Promise<void>;
  showShutdownError: (error: unknown) => Promise<ShutdownErrorDecision>;
  finalize: () => void | Promise<void>;
  resumeQuit: () => void;
  onFinalizing?: () => void;
}

export interface QuitEventLike {
  preventDefault(): void;
}

export interface SafeShutdownController {
  /** Devuelve true únicamente cuando se completó el apagado persistente y se reanudó app.quit(). */
  requestQuit(): Promise<boolean>;
  handleBeforeQuit(event: QuitEventLike): void;
  isFinalizing(): boolean;
}

/**
 * Puerta asíncrona de cierre. Electron no espera Promises en `before-quit`, por eso la primera pasada
 * siempre se cancela y, una vez que no quedan runs activos, se hace el cierre ordenado y se dispara
 * una segunda pasada de `app.quit()`. Durante esa segunda pasada `isFinalizing()` deja pasar tanto
 * `before-quit` como el evento `close` de la ventana.
 *
 * Los pedidos simultáneos comparten una sola operación. Si falla la cancelación o la comprobación,
 * la persistencia permanece abierta y el usuario puede reintentar desde el diálogo nativo.
 */
export function createSafeShutdownController(deps: SafeShutdownDeps): SafeShutdownController {
  let finalizing = false;
  let inFlight: Promise<boolean> | undefined;

  async function runRequest(): Promise<boolean> {
    let stopApproved = false;
    for (;;) {
      try {
        const activeRuns = await deps.listActiveRuns();
        if (activeRuns.length > 0) {
          if (!stopApproved) {
            const decision = await deps.confirmActiveRuns(activeRuns.length);
            if (decision === 'continue_working') return false;
            stopApproved = true;
          }
          await deps.cancelActiveRunsAndWait();
          // No confiamos solamente en que `cancel()` haya resuelto: el estado terminal y sus eventos
          // tienen que estar persistidos antes de cerrar SQLite.
          const remaining = await deps.listActiveRuns();
          if (remaining.length > 0) {
            throw new Error(`Quedaron ${remaining.length} tareas activas después de detenerlas.`);
          }
        }

        await deps.finalize();
        finalizing = true;
        deps.onFinalizing?.();
        deps.resumeQuit();
        return true;
      } catch (error) {
        const decision = await deps.showShutdownError(error);
        if (decision !== 'retry') return false;
      }
    }
  }

  const requestQuit = (): Promise<boolean> => {
    if (finalizing) return Promise.resolve(true);
    if (inFlight) return inFlight;
    inFlight = runRequest().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    requestQuit,
    handleBeforeQuit(event) {
      if (finalizing) return;
      event.preventDefault();
      void requestQuit();
    },
    isFinalizing() {
      return finalizing;
    },
  };
}
