// Migración 4 — packages/runtime/src/persistence/migrations/0004_agent_profiles.ts.
// Doc 19 §1.1 (E2a "Mis agentes"): extiende `agents` con identidad de usuario (`owner_kind` discrimina
// builtin/personal/worker/coordinator, doc 19 §0) y crea `agent_memories` con procedencia explícita
// (doc 19 §1.7, filtro de privacidad por proyecto de T09). Ambos cambios son aditivos: `ALTER TABLE ...
// ADD COLUMN` con default fijo (no reconstruye `agents`, filas existentes quedan con
// `owner_kind='builtin'`) + `CREATE TABLE` nueva. Sin `CHECK` sobre `owner_kind`/`model_mode` (doc 19
// §1.1: se valida en la capa zod de @saurio/shared, igual que otras columnas TEXT de `agents` sin CHECK
// en el DDL) — evita pagar el costo de reconstrucción de tabla si hiciera falta ensanchar un enum acá
// en una entrega futura (mismo costo que ya pagó la migración 0002 para `downloads.status`).
import type { Migration } from './types.js';

export const migration0004: Migration = {
  version: 4,
  name: '0004_agent_profiles',
  sql: `
ALTER TABLE agents ADD COLUMN owner_kind    TEXT NOT NULL DEFAULT 'builtin';
ALTER TABLE agents ADD COLUMN avatar_emoji  TEXT;
ALTER TABLE agents ADD COLUMN avatar_color  TEXT;
ALTER TABLE agents ADD COLUMN description   TEXT;
ALTER TABLE agents ADD COLUMN model_mode    TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE agents ADD COLUMN created_at    INTEGER;
ALTER TABLE agents ADD COLUMN archived_at   INTEGER;
UPDATE agents SET created_at = updated_at WHERE created_at IS NULL;

CREATE TABLE agent_memories (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  project_id     TEXT REFERENCES projects(id),
  content        TEXT NOT NULL,
  source_kind    TEXT NOT NULL CHECK (source_kind IN ('user_stated','inferred','file_derived')),
  confidence     TEXT NOT NULL CHECK (confidence IN ('confirmed','hypothesis')),
  origin_ref     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  expires_at     INTEGER,
  invalidated_at INTEGER
);
CREATE INDEX agent_memories_scope ON agent_memories(agent_id, project_id);
`,
};
