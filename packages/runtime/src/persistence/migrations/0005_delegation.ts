// Migración 5 — packages/runtime/src/persistence/migrations/0005_delegation.ts.
// Doc 19 §2.1 (E3a "Delegación desde el chat"): dos columnas aditivas simples, ninguna reconstruye
// tabla. No hace falta tocar `tool_calls.category` (ya admite 'delegate' desde la migración 0001) ni
// `runs.parent_run_id` (ya existe desde la migración 0001) — es la reutilización literal que doc 17
// dejó preparada como placeholder sin productor real.
import type { Migration } from './types.js';

export const migration0005: Migration = {
  version: 5,
  name: '0005_delegation',
  sql: `
ALTER TABLE runs  ADD COLUMN delegation_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN origin_run_id    TEXT REFERENCES runs(id);
`,
};
