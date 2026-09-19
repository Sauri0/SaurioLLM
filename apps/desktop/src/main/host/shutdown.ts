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
  /** Detiene el `ollama serve` que ESTA app arrancó (no depende de la base; se hace al final para no
   *  demorar el cierre de datos si tarda). */
  stopOwnOllama: () => void;
}

/** Fábrica en vez de una función suelta: permite testear el orden/idempotencia sin depender de
 *  Electron real (`app.on('before-quit', ...)`), y a `main/index.ts` le alcanza con
 *  `app.on('before-quit', createShutdown(deps))`. */
export function createShutdown(deps: ShutdownDeps): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    // 1) Parar tickers/pollers/samplers y cancelar timers (incluye el flush del minuto en curso).
    deps.stopTickers();
    // 2) Limpieza sin dependencia de la base.
    deps.cleanupExtras?.();
    // 3) Cerrar runtime/persistencia — recién ahora nada más puede intentar escribir en ella.
    deps.closePersistence();
    // 4) Detener el Ollama propio.
    deps.stopOwnOllama();
  };
}
