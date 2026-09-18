// EventStore decorado que además publica cada RunEvent ya persistido — apps/desktop/src/main/host/BroadcastEventStore.ts.
// Define: doc 04 §6 (EventStore) + doc 04 RendererEvents ('runtime:event', batched cada 30 ms).
// Ninguna interfaz de packages/runtime expone un mecanismo de suscripción push a los RunEvent que
// produce el RunController (EventStore solo tiene append/since/lastSeq, pensados para consulta).
// En vez de ampliar ese contrato, la integración envuelve el EventStore real: `append` delega en el
// store de SQLite (persistencia + proyección en una transacción) y, recién cuando esa transacción
// terminó bien, notifica a los suscriptores — el RunEventBatcher y de ahí el renderer.
import type { EventStore, RunEvent, DistributiveOmit } from '@saurio/runtime/persistence/types';

export class BroadcastEventStore implements EventStore {
  private readonly listeners = new Set<(event: RunEvent) => void>();

  constructor(private readonly inner: EventStore) {}

  append(event: DistributiveOmit<RunEvent, 'seq'>): RunEvent {
    const persisted = this.inner.append(event);
    for (const listener of this.listeners) {
      try {
        listener(persisted);
      } catch (error) {
        // Un suscriptor roto (ventana ya destruida) nunca puede hacer fallar el append.
        console.error('[BroadcastEventStore] un suscriptor de RunEvent lanzó', error);
      }
    }
    return persisted;
  }

  since(runId: string, seq: number): RunEvent[] {
    return this.inner.since(runId, seq);
  }

  lastSeq(runId: string): number {
    return this.inner.lastSeq(runId);
  }

  subscribe(cb: (event: RunEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
