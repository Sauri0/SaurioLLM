// ActiveRunTracker — apps/desktop/src/main/services/updater/activeRunTracker.ts.
// Parte del punto 2 del encargo de auto-actualización ("nunca interrumpir un run activo (si hay forma
// simple de saberlo, posponé el aviso; si no, solo avisá)"). La forma simple que ya existe en el
// código: `RuntimeHost.onRunEvent` (apps/desktop/src/main/host/RuntimeHost.ts) reenvía cada `RunEvent`
// ya persistido, y el evento `run.state` (packages/shared/src/events.ts) trae `to: RunState` — alcanza
// con contar runIds que están en un estado no terminal para saber si hay al menos un run "vivo", sin
// tocar RuntimeHost ni el contrato de eventos.
import { RunState, type RunEvent } from '@saurio/shared';

// Únicos estados terminales de RunState (packages/shared/src/enums.ts); cualquier otro valor del enum
// (incluido uno que se agregue más adelante) se trata como "run en curso" — más seguro para esta
// heurística equivocarse pensando que hay un run activo (se pospone el aviso, sin costo real) que al
// revés (se interrumpiría un run activo con un diálogo modal).
const TERMINAL_RUN_STATES = new Set<RunState>(['completed', 'cancelled', 'failed', 'interrupted']);

/** Mantiene el conjunto de `runId` actualmente no-terminales a partir de la secuencia de eventos
 *  `run.state`, y notifica (`onIdle`) el momento exacto en que ese conjunto pasa de no-vacío a vacío
 *  (para reintentar un aviso de actualización que se había pospuesto). */
export class ActiveRunTracker {
  private readonly activeRunIds = new Set<string>();

  constructor(private readonly onIdle?: () => void) {}

  /** Se conecta a una fuente de RunEvent (p. ej. `host.onRunEvent`) y devuelve la desuscripción. */
  attach(subscribe: (cb: (event: RunEvent) => void) => () => void): () => void {
    return subscribe((event) => this.handleEvent(event));
  }

  handleEvent(event: RunEvent): void {
    if (event.type !== 'run.state') return;
    const wasActive = this.activeRunIds.size > 0;
    if (TERMINAL_RUN_STATES.has(event.to)) {
      this.activeRunIds.delete(event.runId);
    } else {
      this.activeRunIds.add(event.runId);
    }
    if (wasActive && this.activeRunIds.size === 0) this.onIdle?.();
  }

  hasActiveRun(): boolean {
    return this.activeRunIds.size > 0;
  }
}
