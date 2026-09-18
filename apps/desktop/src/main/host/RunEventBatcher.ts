// Emisión de RunEvent[] a renderer con batching de 30 ms por 'runtime:event' (doc 01 §4.1/§6,
// doc 04 RendererEvents['runtime:event']: "batched cada 30 ms"). Utilidad pura sin dependencia de
// Electron, para poder testearla con vitest sin levantar un BrowserWindow; quien la usa (main/index.ts)
// le pasa `emit` = `(events) => webContents.send('runtime:event', events)`.
import type { RunEvent } from '@saurio/shared';

export const DEFAULT_BATCH_INTERVAL_MS = 30;

export class RunEventBatcher {
  private buffer: RunEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly emit: (events: RunEvent[]) => void,
    private readonly intervalMs: number = DEFAULT_BATCH_INTERVAL_MS,
  ) {}

  /** Encola un evento; programa un flush a `intervalMs` si no hay uno ya pendiente. */
  push(event: RunEvent): void {
    this.buffer.push(event);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
    }
  }

  /** Vacía el buffer inmediatamente (no-op si está vacío); cancela el timer pendiente si lo había. */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    this.emit(events);
  }

  /** Cancela cualquier timer pendiente y descarta el buffer sin emitir (cierre de ventana/app). */
  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.buffer = [];
  }

  pendingCount(): number {
    return this.buffer.length;
  }
}
