// Migración 6 — packages/runtime/src/persistence/migrations/0006_chat_preset_effort_and_project_recents.ts.
// Feedback real v0.2.1 (usuario) + pedido del director (puntos 1a/1b/12 del encargo): columnas
// aditivas simples, ninguna reconstruye tabla (mismo patrón que 0005_delegation.ts).
//
// - chats.permission_preset / chats.effort: NULL = "sin preferencia de chat, usar la del agente"
//   (comportamiento previo a esta tarea) — ver RunController.applyChatPermissionPreset/applyChatEffort.
// - chats.deleted_at: soft-delete (chat:delete). Deliberadamente NO es un DELETE real: `messages`,
//   `tool_calls`, `checkpoints`, `runs`, `tasks` referencian `chats.id` por FK sin ON DELETE CASCADE
//   (doc 03 §4.2/§4.3) — borrar la fila de verdad exigiría un cascade explícito y bien probado sobre
//   varias tablas a la vez, que no entra en el alcance de esta tarea sin arriesgar dejar huérfanos o
//   romper `foreign_keys=ON`. `chat:delete` marca `deleted_at` y los repositorios lo excluyen de
//   listados; el historial real queda igual en disco (recuperable a mano si hiciera falta).
// - projects.removed_from_recents: `project:remove` ("sacar de la lista sin borrar archivos ni
//   historial") — mismo criterio de soft-flag, `project:list`/`project:recent` lo excluyen pero
//   `project:open` con un `path` existente lo puede reabrir igual (reingresa a la lista).
import type { Migration } from './types.js';

export const migration0006: Migration = {
  version: 6,
  name: '0006_chat_preset_effort_and_project_recents',
  sql: `
ALTER TABLE chats    ADD COLUMN permission_preset    TEXT;
ALTER TABLE chats    ADD COLUMN effort               TEXT;
ALTER TABLE chats    ADD COLUMN deleted_at           INTEGER;
ALTER TABLE projects ADD COLUMN removed_from_recents INTEGER NOT NULL DEFAULT 0;
`,
};
