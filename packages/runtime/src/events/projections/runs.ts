// Proyección de runs.state/iteration/metrics_json/last_event_seq desde run_events — doc 03 §6
// (tabla "qué se escribe en cada transición") y doc 04 §6 (RunEvent). packages/runtime/src/events/projections/runs.ts.
//
// DEVIATION: la fila `runs` (created, chat_id, agent_id, mode, model_ref_json, effective_config_json)
// se inserta en `run:start`, un paso que en doc 03 §6 ocurre en la MISMA transacción que el primer
// `run_events` pero que NO es en sí mismo un RunEvent (no hay variante `type: 'run.created'` en el
// discriminated union de doc 04 §6/packages/shared/src/events.ts). Esa fila la crea el módulo que
// orquesta el run (agent/RunController, fuera del alcance persistence/events de esta tarea); esta
// proyección solo hace UPDATE sobre una fila `runs` preexistente. Documentado en la salida de la tarea.
import type { SqliteDriver } from '../../persistence/driver.js';
import type { RunEvent } from '@saurio/shared';

const touchRun = (
  driver: SqliteDriver,
  runId: string,
  seq: number,
  patch: { state?: string; stateReason?: string | null; finishedAt?: number; errorJson?: string; metricsJson?: string },
): void => {
  const sets: string[] = ['last_event_seq = ?'];
  const params: unknown[] = [seq];
  if (patch.state !== undefined) { sets.push('state = ?'); params.push(patch.state); }
  if (patch.stateReason !== undefined) { sets.push('state_reason = ?'); params.push(patch.stateReason); }
  if (patch.finishedAt !== undefined) { sets.push('finished_at = ?'); params.push(patch.finishedAt); }
  if (patch.errorJson !== undefined) { sets.push('error_json = ?'); params.push(patch.errorJson); }
  if (patch.metricsJson !== undefined) { sets.push('metrics_json = ?'); params.push(patch.metricsJson); }
  params.push(runId);
  driver.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
};

/** Aplica las variantes de RunEvent que tocan `runs` (doc 03 §6: run.state, run.error, run.recovered;
 *  `run.adjustment` además inserta en `run_adjustments`, ver doc 03 §4.8). No hace nada con las demás
 *  variantes (responsabilidad de otras proyecciones en events/projections/*). */
export function applyToRuns(driver: SqliteDriver, event: RunEvent): void {
  switch (event.type) {
    case 'run.state': {
      touchRun(driver, event.runId, event.seq, {
        state: event.to,
        stateReason: event.reason ?? null,
        ...(event.to === 'completed' || event.to === 'cancelled' || event.to === 'failed'
          ? { finishedAt: event.ts }
          : {}),
      });
      break;
    }
    case 'run.error': {
      touchRun(driver, event.runId, event.seq, { errorJson: JSON.stringify(event.error) });
      break;
    }
    case 'run.adjustment': {
      touchRun(driver, event.runId, event.seq, {});
      driver.prepare(
        `INSERT INTO run_adjustments (id, run_id, param, requested_json, applied_json, reason, source, evidence_compat_id, reverted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        `${event.runId}:${event.seq}`,
        event.runId,
        event.adjustment.param,
        JSON.stringify(event.adjustment.requested ?? null),
        JSON.stringify(event.adjustment.applied ?? null),
        event.adjustment.reason,
        event.adjustment.source,
        event.adjustment.evidenceCompatId ?? null,
        event.ts,
      );
      break;
    }
    case 'run.recovered': {
      touchRun(driver, event.runId, event.seq, {});
      break;
    }
    default:
      touchRun(driver, event.runId, event.seq, {});
  }
}
