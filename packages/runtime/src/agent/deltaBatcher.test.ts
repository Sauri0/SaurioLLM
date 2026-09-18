import { describe, expect, it, vi } from 'vitest';
import { MessageDeltaBatcher, type DeltaField, type DeltaTimerHandle } from './deltaBatcher.js';

/** Timer fake: no dispara solo — permite controlar exactamente cuándo "vence" la ventana. */
function makeManualTimer(): { setTimer: (cb: () => void, ms: number) => DeltaTimerHandle; fireAll: () => void; pendingCount: () => number } {
  const pending: Array<() => void> = [];
  return {
    setTimer: (cb) => {
      pending.push(cb);
      return { clear: () => { const i = pending.indexOf(cb); if (i >= 0) pending.splice(i, 1); } };
    },
    fireAll: () => { while (pending.length > 0) pending.shift()!(); },
    pendingCount: () => pending.length,
  };
}

describe('agent/MessageDeltaBatcher (doc 16 §4 ítem 9)', () => {
  it('agrupa varios push() del mismo field en un solo emit, con el texto concatenado en orden', () => {
    const emitted: { field: DeltaField; text: string }[] = [];
    const timer = makeManualTimer();
    const batcher = new MessageDeltaBatcher({ setTimer: timer.setTimer, emit: (field, text) => emitted.push({ field, text }) });

    batcher.push('content', 'Hola');
    batcher.push('content', ', ');
    batcher.push('content', 'mundo');
    expect(emitted).toEqual([]); // nada todavía: la ventana no venció

    timer.fireAll();
    expect(emitted).toEqual([{ field: 'content', text: 'Hola, mundo' }]);
  });

  it('acumula content y thinking por separado y los emite como eventos distintos', () => {
    const emitted: { field: DeltaField; text: string }[] = [];
    const timer = makeManualTimer();
    const batcher = new MessageDeltaBatcher({ setTimer: timer.setTimer, emit: (field, text) => emitted.push({ field, text }) });

    batcher.push('thinking', 'pensando');
    batcher.push('content', 'Hola');
    batcher.push('content', ' mundo');
    timer.fireAll();

    expect(emitted).toEqual([
      { field: 'thinking', text: 'pensando' },
      { field: 'content', text: 'Hola mundo' },
    ]);
  });

  it('flush() manual vuelca lo pendiente inmediatamente y cancela el timer en curso', () => {
    const emitted: { field: DeltaField; text: string }[] = [];
    const timer = makeManualTimer();
    const batcher = new MessageDeltaBatcher({ setTimer: timer.setTimer, emit: (field, text) => emitted.push({ field, text }) });

    batcher.push('content', 'parcial');
    expect(timer.pendingCount()).toBe(1);
    batcher.flush();
    expect(emitted).toEqual([{ field: 'content', text: 'parcial' }]);
    expect(timer.pendingCount()).toBe(0);
  });

  it('flush() sin nada pendiente no emite eventos vacíos', () => {
    const emitted: unknown[] = [];
    const timer = makeManualTimer();
    const batcher = new MessageDeltaBatcher({ setTimer: timer.setTimer, emit: (field, text) => emitted.push({ field, text }) });
    batcher.flush();
    expect(emitted).toEqual([]);
  });

  it('tras un flush, un push nuevo arranca una ventana nueva (no se pierde ni se junta con la anterior)', () => {
    const emitted: { field: DeltaField; text: string }[] = [];
    const timer = makeManualTimer();
    const batcher = new MessageDeltaBatcher({ setTimer: timer.setTimer, emit: (field, text) => emitted.push({ field, text }) });

    batcher.push('content', 'primero');
    timer.fireAll();
    batcher.push('content', 'segundo');
    timer.fireAll();

    expect(emitted).toEqual([
      { field: 'content', text: 'primero' },
      { field: 'content', text: 'segundo' },
    ]);
  });

  it('usa un timer real (unref) por defecto: el contenido se emite después del intervalo configurado', async () => {
    vi.useFakeTimers();
    try {
      const emitted: { field: DeltaField; text: string }[] = [];
      const batcher = new MessageDeltaBatcher({ intervalMs: 30, emit: (field, text) => emitted.push({ field, text }) });
      batcher.push('content', 'x');
      expect(emitted).toEqual([]);
      vi.advanceTimersByTime(29);
      expect(emitted).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(emitted).toEqual([{ field: 'content', text: 'x' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
