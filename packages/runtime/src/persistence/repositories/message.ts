// MessageRepository (doc 03 §4.3, doc 04 §2 ChatMessage) — packages/runtime/src/persistence/repositories/message.ts.
// `append` es la vía directa fuera del EventStore (p. ej. el mensaje `role: 'user'` de `run:start`,
// doc 03 §6, que no es en sí mismo un RunEvent — ver deviation en events/projections/runs.ts);
// `message.done` de un turno del asistente pasa por SqliteEventStore.append, no por acá.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { MessageRepository } from '../types.js';
import type { ChatMessage } from '@saurio/shared';

interface MessageRow extends SqliteRow {
  id: string; chat_id: string; run_id: string | null; seq: number; role: string;
  content: string | null; thinking: string | null; tool_calls_json: string | null;
  tool_call_id: string | null; tool_name: string | null; token_estimate: number | null;
  response_metrics_json: string | null; truncated: number; compacted_by: string | null; created_at: number;
  // Migración 0003 (doc 16 §10.4/§10.9, punto 4 del encargo): puede faltar en un `SELECT *` contra
  // una base que todavía no corrió esa migración... no puede pasar en este runtime (runMigrations
  // corre siempre antes de abrir repositorios), pero se lee igual con `??` por las dudas de una fila
  // vieja (de antes de la migración) donde la columna existe pero vale NULL.
  model_ref_json: string | null;
}

function rowToMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role as ChatMessage['role'],
    content: row.content ?? '',
    thinking: row.thinking ?? undefined,
    toolCalls: row.tool_calls_json ? JSON.parse(row.tool_calls_json) : undefined,
    toolCallId: row.tool_call_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    tokenEstimate: row.token_estimate ?? undefined,
    // doc 07 §4.5 / doc 16 §4 ítem 5: `truncated` viaja desde la columna homónima, antes ignorada
    // acá (rowToMessage no la mapeaba pese a que `truncated` ya existía en el DDL).
    truncated: row.truncated === 1 ? true : undefined,
    // Cambio aditivo mínimo (encargo de apps/desktop, punto 4: "mostrar tokens de entrada/salida");
    // `response_metrics_json` ya se escribía desde antes de esta tarea (`events/projections/
    // messages.ts`), pero nunca se leía de vuelta acá — packages/runtime no es zona de ese encargo,
    // documentado acá y en docs/architecture/16-estado-de-implementacion.md.
    metrics: row.response_metrics_json ? JSON.parse(row.response_metrics_json) : undefined,
    modelRef: row.model_ref_json ? JSON.parse(row.model_ref_json) : undefined,
  };
}

export function createMessageRepository(driver: SqliteDriver): MessageRepository {
  return {
    async append(chatId: string, message: ChatMessage): Promise<ChatMessage> {
      const row = driver.prepare<{ max: number | null }>('SELECT MAX(seq) AS max FROM messages WHERE chat_id = ?').get(chatId);
      const seq = (row?.max ?? 0) + 1;
      driver.prepare(
        `INSERT INTO messages (id, chat_id, run_id, seq, role, content, thinking, tool_calls_json, tool_call_id, tool_name, token_estimate, response_metrics_json, truncated, compacted_by, created_at, model_ref_json)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      ).run(
        message.id, chatId, seq, message.role, message.content, message.thinking ?? null,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null, message.toolCallId ?? null,
        message.toolName ?? null, message.tokenEstimate ?? null, message.truncated ? 1 : 0, Date.now(),
        message.modelRef ? JSON.stringify(message.modelRef) : null,
      );
      return message;
    },
    async listByChat(chatId: string): Promise<ChatMessage[]> {
      return driver.prepare<MessageRow>('SELECT * FROM messages WHERE chat_id = ? ORDER BY seq ASC')
        .all(chatId).map(rowToMessage);
    },
    async markCompacted(ids: string[], summaryMessageId: string): Promise<void> {
      if (ids.length === 0) return;
      const stmt = driver.prepare('UPDATE messages SET compacted_by = ? WHERE id = ?');
      for (const id of ids) stmt.run(summaryMessageId, id);
    },
  };
}
