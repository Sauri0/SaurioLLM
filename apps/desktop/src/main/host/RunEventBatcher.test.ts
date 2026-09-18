// Test del batching de 30 ms de RunEventBatcher (doc 04 RendererEvents['runtime:event']).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '@saurio/shared';
import { RunEventBatcher } from './RunEventBatcher.js';

function makeEvent(seq: number): RunEvent {
  return { seq, runId: 'run-1', chatId: 'chat-1', ts: seq, type: 'run.state', from: 'created', to: 'preparing' };
}

describe('RunEventBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no emite nada antes de que pasen 30 ms', () => {
    const emit = vi.fn();
    const batcher = new RunEventBatcher(emit);
    batcher.push(makeEvent(1));
    vi.advanceTimersByTime(29);
    expect(emit).not.toHaveBeenCalled();
  });

  it('emite un único batch con todos los eventos encolados en la ventana de 30 ms', () => {
    const emit = vi.fn();
    const batcher = new RunEventBatcher(emit);
    batcher.push(makeEvent(1));
    vi.advanceTimersByTime(10);
    batcher.push(makeEvent(2));
    vi.advanceTimersByTime(10);
    batcher.push(makeEvent(3));
    vi.advanceTimersByTime(10);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith([makeEvent(1), makeEvent(2), makeEvent(3)]);
  });

  it('un segundo lote de eventos dispara un segundo flush independiente', () => {
    const emit = vi.fn();
    const batcher = new RunEventBatcher(emit);
    batcher.push(makeEvent(1));
    vi.advanceTimersByTime(30);
    expect(emit).toHaveBeenCalledTimes(1);

    batcher.push(makeEvent(2));
    vi.advanceTimersByTime(30);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(2, [makeEvent(2)]);
  });

  it('flush() manual vacía el buffer y cancela el timer pendiente', () => {
    const emit = vi.fn();
    const batcher = new RunEventBatcher(emit);
    batcher.push(makeEvent(1));
    batcher.flush();
    expect(emit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30);
    expect(emit).toHaveBeenCalledTimes(1); // no segundo flush vacío
  });

  it('flush() sin eventos pendientes no emite', () => {
    const emit = vi.fn();
    const batcher = new RunEventBatcher(emit);
    batcher.flush();
    expect(emit).not.toHaveBeenCalled();
  });

  it('dispose() descarta el buffer sin emitir', () => {
    const emit = vi.fn();
    const batcher = new RunEventBatcher(emit);
    batcher.push(makeEvent(1));
    batcher.dispose();
    vi.advanceTimersByTime(60);
    expect(emit).not.toHaveBeenCalled();
    expect(batcher.pendingCount()).toBe(0);
  });
});
