// Test de ActiveRunTracker (ver comentario del archivo hermano): construye RunEvent 'run.state'
// mínimos a mano en vez de importar fixtures del runtime (no depende de nada además de @saurio/shared).
import { describe, expect, it, vi } from 'vitest';
import type { RunEvent, RunState } from '@saurio/shared';
import { ActiveRunTracker } from './activeRunTracker.js';

function runStateEvent(runId: string, to: RunState, seq: number): RunEvent {
  return { type: 'run.state', seq, runId, chatId: 'chat-1', ts: Date.now(), from: 'created', to };
}

describe('ActiveRunTracker', () => {
  it('sin eventos, no hay run activo', () => {
    const tracker = new ActiveRunTracker();
    expect(tracker.hasActiveRun()).toBe(false);
  });

  it('un run en estado no terminal cuenta como activo', () => {
    const tracker = new ActiveRunTracker();
    tracker.handleEvent(runStateEvent('run-1', 'generating', 1));
    expect(tracker.hasActiveRun()).toBe(true);
  });

  it('al llegar a un estado terminal, el run deja de contar', () => {
    const tracker = new ActiveRunTracker();
    tracker.handleEvent(runStateEvent('run-1', 'generating', 1));
    tracker.handleEvent(runStateEvent('run-1', 'completed', 2));
    expect(tracker.hasActiveRun()).toBe(false);
  });

  it('con dos runs simultáneos, sigue activo hasta que termina el último', () => {
    const tracker = new ActiveRunTracker();
    tracker.handleEvent(runStateEvent('run-1', 'generating', 1));
    tracker.handleEvent(runStateEvent('run-2', 'executing_tool', 1));
    tracker.handleEvent(runStateEvent('run-1', 'completed', 2));
    expect(tracker.hasActiveRun()).toBe(true);
    tracker.handleEvent(runStateEvent('run-2', 'failed', 2));
    expect(tracker.hasActiveRun()).toBe(false);
  });

  it('onIdle se llama solo en la transición de activo a vacío, una vez', () => {
    const onIdle = vi.fn();
    const tracker = new ActiveRunTracker(onIdle);
    tracker.handleEvent(runStateEvent('run-1', 'generating', 1));
    expect(onIdle).not.toHaveBeenCalled();
    tracker.handleEvent(runStateEvent('run-1', 'completed', 2));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('onIdle no se llama si nunca hubo un run activo', () => {
    const onIdle = vi.fn();
    const tracker = new ActiveRunTracker(onIdle);
    tracker.handleEvent(runStateEvent('run-1', 'completed', 1));
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('eventos que no son run.state se ignoran', () => {
    const tracker = new ActiveRunTracker();
    tracker.handleEvent({ type: 'tasks.updated', seq: 1, runId: 'run-1', chatId: 'chat-1', ts: Date.now(), tasks: [] });
    expect(tracker.hasActiveRun()).toBe(false);
  });

  it('attach() se suscribe a la fuente dada y devuelve la desuscripción', () => {
    const tracker = new ActiveRunTracker();
    let capturedCb: ((event: RunEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((cb: (event: RunEvent) => void) => {
      capturedCb = cb;
      return unsubscribe;
    });

    const result = tracker.attach(subscribe);

    expect(subscribe).toHaveBeenCalledTimes(1);
    capturedCb?.(runStateEvent('run-1', 'generating', 1));
    expect(tracker.hasActiveRun()).toBe(true);
    expect(result).toBe(unsubscribe);
  });
});
