# Migraciones de saurio.db

Numeradas correlativamente (0001, 0002, ...), embebidas en el binario y aplicadas en el bootstrap de
`main` antes de `recover()` (doc 02 §1, ADR-004 y ADR-005 en `docs/architecture/12-decisiones.md`).
Cada migración corre en su propia transacción (`runMigrations`, `index.ts`); nunca se edita una
migración ya publicada — un cambio de esquema siempre es una migración nueva.

- **0001_init**: DDL completo de doc 03 §4 (28 tablas, CHECK, índices parciales, FTS5 + triggers,
  vistas JSON1), más `runs.owner_session_id`/`heartbeat_at` (doc 10 §5.0) y
  `tool_calls.expected_pre_hash` (doc 10 §3/§5.2/§6 caso 13).
- **0002_downloads_status_and_git_head**: `downloads.status` admite `'insufficient_space'` (doc 13 §5
  punto 1) — reconstruye la tabla porque SQLite no permite ensanchar un `CHECK` con `ALTER TABLE`; y
  `checkpoints.git_head` (doc 09 §2.2/§5.3), columna simple vía `ADD COLUMN`, para que `planRevert()`
  pueda poblar `RevertPlan.branchChanged`.
- **0003_messages_model_ref**: `messages.model_ref_json` (doc 16 §10.4/§10.9, punto 4 del encargo) —
  columna simple vía `ADD COLUMN`, guarda `{ providerId, name, locality }` del modelo que generó ESE
  mensaje puntual, para que el badge NUBE por mensaje deje de reflejar solo el modelo vigente del chat.
