// Proyección de `messages` desde run_events (`message.done`) — doc 03 §4.3/§6, doc 04 §6.
// packages/runtime/src/events/projections/messages.ts.
// `message.delta` no se persiste (doc 03 §6, fila "Mensaje del asistente cerrado"): esta proyección
// no hace nada con esa variante; solo `message.done` escribe una fila.
import type { SqliteDriver } from '../../persistence/driver.js';
import type { RunEvent } from '@saurio/shared';

function nextSeq(driver: SqliteDriver, chatId: string): number {
  const row = driver.prepare<{ max: number | null }>(
    'SELECT MAX(seq) AS max FROM messages WHERE chat_id = ?',
  ).get(chatId);
  return (row?.max ?? 0) + 1;
}

export function applyToMessages(driver: SqliteDriver, event: RunEvent): void {
  if (event.type === 'context.compacted') {
    // doc 07 §7.4 / doc 16 §4 ítem 5: marca los mensajes reemplazados, nunca los borra. Sin
    // `replacedMessageIds` (eventos viejos, o el "Plan B" de nivel 1 puro sin resumen) no hay nada
    // que marcar acá.
    if (event.replacedMessageIds && event.summaryMessageId) {
      const stmt = driver.prepare('UPDATE messages SET compacted_by = ? WHERE id = ?');
      for (const id of event.replacedMessageIds) stmt.run(event.summaryMessageId, id);
    }
    return;
  }
  if (event.type !== 'message.done') return;
  const { message, metrics } = event;
  driver.prepare(
    `INSERT INTO messages (
       id, chat_id, run_id, seq, role, content, thinking, tool_calls_json, tool_call_id, tool_name,
       token_estimate, response_metrics_json, truncated, compacted_by, created_at, model_ref_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    event.chatId,
    event.runId,
    nextSeq(driver, event.chatId),
    message.role,
    message.content,
    message.thinking ?? null,
    message.toolCalls ? JSON.stringify(message.toolCalls) : null,
    message.toolCallId ?? null,
    message.toolName ?? null,
    message.tokenEstimate ?? null,
    JSON.stringify(metrics),
    // doc 07 §4.5 / doc 16 §4 ítem 5: antes hardcodeado a 0, perdía la marca de mensaje parcial.
    message.truncated ? 1 : 0,
    null,
    event.ts,
    // Migración 0003 / punto 4 del encargo: `message.modelRef` (RunController lo completa con
    // `live.effectiveConfig.model` antes de emitir `message.done`) queda persistido junto con el
    // mensaje que efectivamente generó ese modelo — la fuente de verdad histórica del badge NUBE
    // por mensaje, doc 16 §10.4/§10.9.
    message.modelRef ? JSON.stringify(message.modelRef) : null,
  );
}
