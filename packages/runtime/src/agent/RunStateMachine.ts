// RunStateMachine: valida transiciones de RunState contra RUN_TRANSITIONS — packages/runtime/src/agent/RunStateMachine.ts.
// Define: doc 05 §1 (máquina de estados) + doc 10 §2 (la misma máquina, reproducida porque doc 10
// depende de cada arista). RUN_TRANSITIONS ya está definido en ./types.ts (no se modifica); esta clase
// es la única que decide si una arista es válida, para no duplicar la tabla en cada call site de
// RunController.
import type { RunState } from '@saurio/shared';
import { RUN_TRANSITIONS } from './types.js';

export class InvalidTransitionError extends Error {
  constructor(public readonly from: RunState, public readonly to: RunState) {
    super(`Transición de run inválida: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/** `interrupted` solo la emite `recover()` (doc 04 §5, comentario en RUN_TRANSITIONS); el resto del
 *  runtime (RunController en operación normal) nunca debe producirla, aunque la tabla la liste como
 *  arista válida — se distingue con un flag explícito en `assert`. */
export class RunStateMachine {
  canTransition(from: RunState, to: RunState): boolean {
    return RUN_TRANSITIONS[from]?.includes(to) ?? false;
  }

  /** Lanza `InvalidTransitionError` si la arista no existe en RUN_TRANSITIONS. `allowRecoverOnly`
   *  se pasa en `true` únicamente desde `recover.ts`, para dejar constancia de que una transición a
   *  `interrupted` fuera de `recover()` sigue siendo un error de programación aunque la tabla la
   *  liste (documento 04 §5, nota sobre RUN_TRANSITIONS). */
  assert(from: RunState, to: RunState, opts: { allowRecoverOnly?: boolean } = {}): void {
    if (to === 'interrupted' && !opts.allowRecoverOnly) {
      throw new InvalidTransitionError(from, to);
    }
    if (!this.canTransition(from, to)) throw new InvalidTransitionError(from, to);
  }
}
