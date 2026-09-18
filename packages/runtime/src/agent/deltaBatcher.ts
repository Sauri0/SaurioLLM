// Agrupa fragmentos de streaming ('message.delta') en ventanas de ~30 ms antes de persistirlos como
// eventos — packages/runtime/src/agent/deltaBatcher.ts.
// Define: doc 16 §4 ítem 9 ("Batching de message.delta a 30 ms dentro del RunController: menos
// eventos, mismo contenido, sin romper el orden ni la persistencia"). `RunEventBatcher` (apps/desktop,
// fuera de esta zona) ya agrupa eventos antes de mandarlos al renderer por IPC; esto agrupa un nivel
// más abajo, ANTES de que el evento llegue siquiera al `EventStore`/SQLite — menos filas en
// `run_events` por el mismo streaming, sin cambiar qué contenido termina viendo el cliente ni el
// orden relativo dentro de cada `field` ('content'/'thinking' se acumulan y emiten por separado).
export type DeltaField = 'content' | 'thinking';

/** Handle mínimo de un timer, para poder inyectar uno determinístico en tests sin depender de
 *  temporizadores reales de Node. */
export interface DeltaTimerHandle { clear(): void }

export interface DeltaBatcherDeps {
  /** ms de la ventana de agrupación (doc: "~30 ms"). */
  intervalMs?: number;
  /** Inyectable para tests; por defecto usa `setTimeout` real (con `unref()` para no mantener vivo
   *  el proceso por un timer de streaming olvidado si el run termina sin flushear por algún camino
   *  no contemplado). */
  setTimer?: (cb: () => void, ms: number) => DeltaTimerHandle;
  /** Vuelca el texto acumulado de un `field` como un evento `message.delta` real. */
  emit(field: DeltaField, text: string): void;
}

const DEFAULT_INTERVAL_MS = 30;

function defaultSetTimer(cb: () => void, ms: number): DeltaTimerHandle {
  const handle = setTimeout(cb, ms);
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref(): void }).unref();
  }
  return { clear: () => clearTimeout(handle) };
}

export class MessageDeltaBatcher {
  private readonly intervalMs: number;
  private readonly setTimer: (cb: () => void, ms: number) => DeltaTimerHandle;
  private readonly emitFn: (field: DeltaField, text: string) => void;
  private readonly buffers = new Map<DeltaField, string>();
  private timer: DeltaTimerHandle | undefined;

  constructor(deps: DeltaBatcherDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.setTimer = deps.setTimer ?? defaultSetTimer;
    this.emitFn = deps.emit;
  }

  /** Encola un fragmento; arranca el timer de la ventana si no había uno corriendo ya. No emite
   *  nada todavía — eso lo hace `flush()`, a mano o cuando vence la ventana. */
  push(field: DeltaField, text: string): void {
    if (text.length === 0) return;
    this.buffers.set(field, (this.buffers.get(field) ?? '') + text);
    if (!this.timer) {
      this.timer = this.setTimer(() => this.flush(), this.intervalMs);
    }
  }

  /** Vuelca lo acumulado como, a lo sumo, un evento por `field` (orden de inserción del `Map`:
   *  'content' antes que 'thinking' si ambos tienen pendiente en el mismo flush). Se llama siempre
   *  antes de cualquier evento terminal del turno (`message.done`, mensaje truncado, error) para no
   *  perder ni reordenar nada — "sin romper el orden ni la persistencia" del encargo. Idempotente: un
   *  flush sin nada pendiente no emite eventos vacíos. */
  flush(): void {
    this.timer?.clear();
    this.timer = undefined;
    for (const [field, text] of this.buffers) {
      if (text.length > 0) this.emitFn(field, text);
    }
    this.buffers.clear();
  }
}
