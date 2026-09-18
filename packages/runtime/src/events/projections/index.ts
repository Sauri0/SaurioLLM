// Compone todas las proyecciones del log de eventos en un único EventProjector (doc 02 §1,
// doc 04 §6 EventProjector) — packages/runtime/src/events/projections/index.ts.
// Cada submódulo (runs/messages/toolCalls/tasks/checkpoints) escribe SOLO las tablas de su
// dominio; `saurio db rebuild` (persistence/rebuild.ts) reutiliza este mismo compuesto para
// reproyectar bit a bit desde run_events, evento por evento.
import type { SqliteDriver } from '../../persistence/driver.js';
import type { EventProjector, RunEvent } from '../../persistence/types.js';
import { applyToRuns } from './runs.js';
import { applyToMessages } from './messages.js';
import { applyToToolCalls } from './toolCalls.js';
import { applyToTasks } from './tasks.js';
import { applyToCheckpoints } from './checkpoints.js';

/** Crea el EventProjector compuesto contra `driver`. No abre transacción propia: quien lo invoca
 *  (EventStore.append, o rebuild.ts) ya está dentro de la transacción correspondiente. */
export function createProjector(driver: SqliteDriver): EventProjector {
  return {
    apply(event: RunEvent): void {
      applyToRuns(driver, event);
      applyToMessages(driver, event);
      applyToToolCalls(driver, event);
      applyToTasks(driver, event);
      applyToCheckpoints(driver, event);
    },
  };
}
