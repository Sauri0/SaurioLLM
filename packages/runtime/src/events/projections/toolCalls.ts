// Proyección de `tool_calls` (+ `permission_decisions`, `permission_rules` si "permitir siempre")
// desde run_events — doc 03 §4.3/§4.4/§6, doc 04 §6. packages/runtime/src/events/projections/toolCalls.ts.
import type { SqliteDriver } from '../../persistence/driver.js';
import type { RunEvent } from '@saurio/shared';

/** `tool.registered`: write-ahead — la fila existe antes de cualquier chequeo de permisos o ejecución
 *  (doc 03 §6, doc 10 §3 "registrar antes de actuar"). */
function onRegistered(driver: SqliteDriver, event: Extract<RunEvent, { type: 'tool.registered' }>): void {
  const c = event.call;
  driver.prepare(
    `INSERT INTO tool_calls (
       id, run_id, message_id, iteration, tool_name, args_json, args_hash, category, risk, transport,
       status, permission_decision_id, checkpoint_id, started_at, finished_at, result_preview,
       result_path, result_is_error, error_json, match_level, expected_pre_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.id, c.runId, c.messageId ?? null, c.iteration, c.toolName, JSON.stringify(c.args), c.argsHash,
    c.category, c.risk, c.transport, c.status, c.permissionDecisionId ?? null, c.checkpointId ?? null,
    c.startedAt ?? null, c.finishedAt ?? null, c.resultPreview ?? null, c.resultPath ?? null,
    c.resultIsError === undefined ? null : (c.resultIsError ? 1 : 0),
    c.error ? JSON.stringify(c.error) : null, c.matchLevel ?? null, null,
  );
}

/** `tool.permission`: la tarjeta de permiso completa viaja en el evento para poder re-mostrarla tras
 *  un reinicio (doc 03 §6). Solo cambia estado acá; `PermissionRequest` no tiene tabla propia. */
function onPermission(driver: SqliteDriver, event: Extract<RunEvent, { type: 'tool.permission' }>): void {
  driver.prepare('UPDATE tool_calls SET status = ? WHERE id = ?')
    .run('awaiting_permission', event.request.toolCallId);
}

/** `tool.decision`: inserta `permission_decisions` y, si "permitir siempre", la `permission_rules`
 *  correspondiente en la MISMA transacción (doc 03 §6, fila "Usuario responde"). */
function onDecision(driver: SqliteDriver, event: Extract<RunEvent, { type: 'tool.decision' }>): void {
  const d = event.decision;
  if (!('answer' in d)) {
    // PermissionDecision (doc 04 §7): { decision: allow|deny, decidedBy, ruleId?, reason } | { decision: ask, request }
    if (d.decision === 'ask') {
      driver.prepare('UPDATE tool_calls SET status = ? WHERE id = ?').run('awaiting_permission', event.toolCallId);
      return;
    }
    driver.prepare(
      `INSERT INTO permission_decisions (id, tool_call_id, decision, rule_id, decided_by, reason, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(`${event.toolCallId}:${event.seq}`, event.toolCallId, d.decision, d.ruleId ?? null, d.decidedBy, d.reason, event.ts);
    driver.prepare('UPDATE tool_calls SET status = ?, permission_decision_id = ? WHERE id = ?')
      .run(d.decision === 'allow' ? 'approved' : 'denied', `${event.toolCallId}:${event.seq}`, event.toolCallId);
    return;
  }
  // PermissionAnswer (doc 04 §7): respuesta directa del usuario en la tarjeta de permiso.
  //
  // Hallazgo real (doc 16 §4 ítem 1, encontrado corriendo eval/harness.ts contra SQLite real por
  // primera vez con el preset `strict`/una regla `write: ask` — el preset por defecto `balanced`
  // nunca dispara `awaiting_permission`, así que este código nunca se había ejercitado, doc 17 §5):
  // la sentencia insertaba 7 columnas con solo 5 placeholders `?` (`rule_id`/`decided_by` quedaban
  // como literales `NULL`/'user' en el texto de la SQL) pero el `.run()` de abajo solo pasaba 4
  // argumentos — le faltaba directamente el valor de `decision`. better-sqlite3 lo rechazaba con
  // "Too few parameter values were provided" en la primera respuesta real a una `PermissionRequest`,
  // dejando el run en `failed` sin haber registrado la decisión. Fix: agregar el argumento faltante.
  const answer = d;
  const decision = answer.answer === 'deny' ? 'deny' : 'allow';
  driver.prepare(
    `INSERT INTO permission_decisions (id, tool_call_id, decision, rule_id, decided_by, reason, decided_at)
     VALUES (?, ?, ?, NULL, 'user', ?, ?)`,
  ).run(`${event.toolCallId}:${event.seq}`, event.toolCallId, decision, answer.reason ?? null, event.ts);
  if (answer.answer === 'allow_always' && answer.rememberScope && answer.pattern) {
    const tc = driver.prepare<{ tool_name: string }>('SELECT tool_name FROM tool_calls WHERE id = ?').get(event.toolCallId);
    driver.prepare(
      `INSERT INTO permission_rules (id, scope, project_id, tool_name, pattern, decision, source, created_at, source_tool_call_id)
       VALUES (?, ?, NULL, ?, ?, 'allow', 'user', ?, ?)`,
    ).run(`rule:${event.toolCallId}:${event.seq}`, answer.rememberScope, tc?.tool_name ?? '', answer.pattern, event.ts, event.toolCallId);
  }
  driver.prepare('UPDATE tool_calls SET status = ?, permission_decision_id = ? WHERE id = ?')
    .run(decision === 'allow' ? 'approved' : 'denied', `${event.toolCallId}:${event.seq}`, event.toolCallId);
}

function onStatus(driver: SqliteDriver, event: Extract<RunEvent, { type: 'tool.status' }>): void {
  const startedAtPatch = event.status === 'running' ? ', started_at = COALESCE(started_at, ?)' : '';
  const finishedAtPatch = ['done', 'failed', 'cancelled', 'orphaned', 'abandoned'].includes(event.status)
    ? ', finished_at = ?' : '';
  const params: unknown[] = [event.status];
  if (startedAtPatch) params.push(event.ts);
  if (finishedAtPatch) params.push(event.ts);
  if (event.resultPreview !== undefined) params.push(event.resultPreview);
  if (event.error !== undefined) params.push(event.error);
  params.push(event.toolCallId);
  driver.prepare(
    `UPDATE tool_calls SET status = ?${startedAtPatch}${finishedAtPatch}` +
    (event.resultPreview !== undefined ? ', result_preview = ?' : '') +
    (event.error !== undefined ? ', error_json = ?' : '') +
    ' WHERE id = ?',
  ).run(...params);
}

export function applyToToolCalls(driver: SqliteDriver, event: RunEvent): void {
  switch (event.type) {
    case 'tool.registered': onRegistered(driver, event); break;
    case 'tool.permission': onPermission(driver, event); break;
    case 'tool.decision': onDecision(driver, event); break;
    case 'tool.status': onStatus(driver, event); break;
    default: break;
  }
}
