// Migración 1: crea TODAS las tablas de doc 03-modelo-de-datos.md §4 (DDL literal), incluidas
// las que quedan vacías hasta v0.2/v0.3 (Principio 8 de la columna vertebral, doc 03 §12) —
// packages/runtime/src/persistence/migrations/0001_init.ts.
// Agrega, por encima del DDL literal de doc 03, dos columnas que doc 10-fallos-y-recuperacion.md
// marca "Imprescindible para el MVP" pero que doc 03 no lista (doc 03 §14 punto 5 ya anticipa este
// tipo de desvío para otros casos): `runs.owner_session_id`/`runs.heartbeat_at` (doc 10 §5.0, single
// instance lock) y `tool_calls.expected_pre_hash` (doc 10 §3/§5.2/§6 caso 13) — ver deviations.
import type { Migration } from './types.js';

export const migration0001: Migration = {
  version: 1,
  name: '0001_init',
  sql: `
-- 4.1 Proyectos, agentes, chats -----------------------------------------------------------------
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  path            TEXT UNIQUE NOT NULL,
  name            TEXT,
  created_at      INTEGER NOT NULL,
  last_opened_at  INTEGER,
  settings_json   TEXT
);

CREATE TABLE profiles (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id),
  name         TEXT NOT NULL,
  is_builtin   INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0,1)),
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  config_json  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE agents (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT REFERENCES projects(id),
  name                     TEXT NOT NULL,
  role                     TEXT NOT NULL CHECK (role IN ('lead','coder','reviewer','explorer','custom')),
  model_ref_json           TEXT NOT NULL,
  system_prompt            TEXT NOT NULL,
  system_prompt_hash       TEXT NOT NULL,
  allowed_tools_json       TEXT NOT NULL,
  permission_policy_json   TEXT NOT NULL,
  context_policy_json      TEXT NOT NULL,
  memory_policy_json       TEXT,
  default_mode             TEXT NOT NULL CHECK (default_mode IN ('plan','ask','edit','agent')),
  temperature              REAL,
  thinking                 TEXT NOT NULL CHECK (thinking IN ('off','on','auto')),
  tool_transport            TEXT NOT NULL CHECK (tool_transport IN ('auto','native','text')),
  max_iterations           INTEGER NOT NULL CHECK (max_iterations > 0),
  working_dir              TEXT,
  file_scope               TEXT,
  profile_id               TEXT REFERENCES profiles(id),
  is_builtin               INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0,1)),
  updated_at               INTEGER NOT NULL
);
CREATE INDEX agents_project ON agents(project_id);

CREATE TABLE chats (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  title        TEXT,
  mode         TEXT NOT NULL CHECK (mode IN ('plan','ask','edit','agent')),
  model_ref_json TEXT,
  profile_id   TEXT REFERENCES profiles(id),
  override_json TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
);
CREATE INDEX chats_project ON chats(project_id, updated_at DESC);

-- 4.2 Runs y log de eventos (fuente de verdad) ---------------------------------------------------
CREATE TABLE runs (
  id                     TEXT PRIMARY KEY,
  chat_id                TEXT NOT NULL REFERENCES chats(id),
  parent_run_id          TEXT REFERENCES runs(id),
  agent_id               TEXT NOT NULL REFERENCES agents(id),
  mode                   TEXT NOT NULL CHECK (mode IN ('plan','ask','edit','agent')),
  model_ref_json         TEXT NOT NULL,
  effective_config_json  TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK (state IN (
                            'created','preparing','queued','generating','parsing','awaiting_permission',
                            'executing_tool','compacting','cancelling','completed','cancelled','failed','interrupted')),
  state_reason           TEXT,
  iteration              INTEGER NOT NULL DEFAULT 0,
  started_at             INTEGER,
  finished_at            INTEGER,
  error_json             TEXT,
  metrics_json           TEXT,
  last_event_seq         INTEGER,
  owner_session_id       TEXT,
  heartbeat_at           INTEGER
);
CREATE INDEX runs_chat ON runs(chat_id, started_at);
CREATE INDEX runs_parent ON runs(parent_run_id);
CREATE INDEX runs_active ON runs(state) WHERE state IN
  ('created','preparing','queued','generating','parsing','awaiting_permission','executing_tool','compacting','cancelling');

CREATE TABLE run_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  chat_id      TEXT NOT NULL REFERENCES chats(id),
  ts           INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX run_events_run ON run_events(run_id, seq);
CREATE INDEX run_events_chat ON run_events(chat_id, seq);

-- 4.3 Proyecciones: mensajes y tool calls ---------------------------------------------------------
CREATE TABLE messages (
  id                     TEXT PRIMARY KEY,
  chat_id                TEXT NOT NULL REFERENCES chats(id),
  run_id                 TEXT REFERENCES runs(id),
  seq                    INTEGER NOT NULL,
  role                   TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content                TEXT,
  thinking               TEXT,
  tool_calls_json        TEXT,
  tool_call_id           TEXT,
  tool_name              TEXT,
  token_estimate         INTEGER,
  response_metrics_json  TEXT,
  truncated              INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  compacted_by           TEXT REFERENCES messages(id),
  created_at             INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_chat_seq ON messages(chat_id, seq);
CREATE INDEX messages_run ON messages(run_id);

CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE checkpoints (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  chat_id      TEXT NOT NULL REFERENCES chats(id),
  tool_call_id TEXT REFERENCES tool_calls(id),
  iteration    INTEGER,
  label        TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('tool','revert')),
  created_at   INTEGER NOT NULL,
  stats_json   TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reverted','partial')),
  reverted_at  INTEGER
);
CREATE INDEX checkpoints_run ON checkpoints(run_id, created_at);
CREATE INDEX checkpoints_chat ON checkpoints(chat_id, created_at DESC);

CREATE TABLE tool_calls (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES runs(id),
  message_id            TEXT REFERENCES messages(id),
  iteration             INTEGER,
  tool_name             TEXT NOT NULL,
  args_json             TEXT NOT NULL,
  args_hash             TEXT NOT NULL,
  category              TEXT NOT NULL CHECK (category IN ('read','write','delete','terminal','git_commit','git_push','network','mcp','delegate')),
  risk                  TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  transport              TEXT NOT NULL CHECK (transport IN ('native','text')),
  status                TEXT NOT NULL CHECK (status IN (
                            'pending','awaiting_permission','approved','denied','running',
                            'awaiting_input','done','failed','cancelled','orphaned','abandoned')),
  permission_decision_id TEXT REFERENCES permission_decisions(id),
  checkpoint_id         TEXT REFERENCES checkpoints(id),
  started_at            INTEGER,
  finished_at           INTEGER,
  result_preview        TEXT,
  result_path           TEXT,
  result_is_error       INTEGER CHECK (result_is_error IN (0,1)),
  error_json            TEXT,
  match_level           TEXT CHECK (match_level IN ('exact','eol','indent','whitespace','fuzzy')),
  expected_pre_hash     TEXT
);
CREATE INDEX tool_calls_run ON tool_calls(run_id, iteration);
CREATE INDEX tool_calls_open ON tool_calls(status) WHERE status IN
  ('pending','awaiting_permission','approved','running','awaiting_input');
CREATE INDEX tool_calls_args_hash ON tool_calls(run_id, args_hash);

-- 4.4 Permisos --------------------------------------------------------------------------------
CREATE TABLE permission_rules (
  id                    TEXT PRIMARY KEY,
  scope                 TEXT NOT NULL CHECK (scope IN ('session','project','global')),
  project_id            TEXT REFERENCES projects(id),
  tool_name             TEXT NOT NULL,
  pattern               TEXT,
  decision              TEXT NOT NULL CHECK (decision IN ('allow','ask','deny')),
  source                TEXT NOT NULL CHECK (source IN ('user','preset','mode','settings')),
  created_at            INTEGER NOT NULL,
  source_tool_call_id   TEXT REFERENCES tool_calls(id)
);
CREATE INDEX permission_rules_scope ON permission_rules(scope, project_id, tool_name);

CREATE TABLE permission_decisions (
  id            TEXT PRIMARY KEY,
  tool_call_id  TEXT NOT NULL REFERENCES tool_calls(id),
  decision      TEXT NOT NULL CHECK (decision IN ('allow','deny','ask')),
  rule_id       TEXT REFERENCES permission_rules(id),
  decided_by    TEXT NOT NULL CHECK (decided_by IN ('user','rule','mode')),
  reason        TEXT,
  decided_at    INTEGER NOT NULL
);
CREATE INDEX permission_decisions_tool_call ON permission_decisions(tool_call_id);

-- 4.5 Checkpoints (archivos y blobs) -----------------------------------------------------------
CREATE TABLE checkpoint_files (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
  rel_path      TEXT NOT NULL,
  change        TEXT NOT NULL CHECK (change IN ('created','modified','deleted')),
  pre_hash      TEXT,
  post_hash     TEXT,
  pre_eol       TEXT,
  pre_bom       INTEGER CHECK (pre_bom IN (0,1)),
  pre_mode      INTEGER,
  blob_missing  INTEGER NOT NULL DEFAULT 0 CHECK (blob_missing IN (0,1)),
  PRIMARY KEY (checkpoint_id, rel_path)
);

CREATE TABLE blobs (
  hash        TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  refcount    INTEGER NOT NULL DEFAULT 1 CHECK (refcount >= 0)
);

-- 4.6 Tasks, memoria de proyecto, repo map -------------------------------------------------------
CREATE TABLE tasks (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats(id),
  run_id     TEXT REFERENCES runs(id),
  ord        INTEGER NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('pending','in_progress','done','skipped')),
  updated_at INTEGER NOT NULL
);
CREATE INDEX tasks_chat ON tasks(chat_id, ord);

CREATE TABLE project_memory (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  key         TEXT NOT NULL,
  content     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);

CREATE TABLE repo_map_cache (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  rel_path    TEXT NOT NULL,
  mtime       INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  lang        TEXT,
  tags_json   TEXT,
  PRIMARY KEY (project_id, rel_path)
);

-- 4.7 Providers y modelos -----------------------------------------------------------------------
CREATE TABLE providers (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('ollama','openai-compat','cloud')),
  transport        TEXT NOT NULL,
  base_url         TEXT NOT NULL,
  is_loopback      INTEGER NOT NULL CHECK (is_loopback IN (0,1)),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  mode             TEXT NOT NULL CHECK (mode IN ('attach','managed')),
  max_concurrency  INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency >= 1),
  config_json      TEXT
);

CREATE TABLE models (
  provider_id       TEXT NOT NULL REFERENCES providers(id),
  name              TEXT NOT NULL,
  digest            TEXT,
  size              INTEGER,
  details_json      TEXT,
  capabilities_json TEXT,
  model_info_json   TEXT,
  context_max       INTEGER,
  locality          TEXT NOT NULL CHECK (locality IN ('local','lan','proxied-cloud','cloud')),
  refreshed_at      INTEGER NOT NULL,
  PRIMARY KEY (provider_id, name)
);

CREATE TABLE model_load_samples (
  id               TEXT PRIMARY KEY,
  provider_id      TEXT NOT NULL REFERENCES providers(id),
  model_name       TEXT NOT NULL,
  model_digest     TEXT,
  num_ctx          INTEGER NOT NULL,
  size             INTEGER,
  size_vram        INTEGER,
  context_length   INTEGER,
  load_ms          INTEGER,
  estimated_vram   INTEGER,
  sampled_at       INTEGER NOT NULL
);
CREATE INDEX model_load_samples_model ON model_load_samples(provider_id, model_name, sampled_at DESC);

CREATE TABLE model_compat (
  id                   TEXT PRIMARY KEY,
  provider_id          TEXT NOT NULL REFERENCES providers(id),
  model_name           TEXT NOT NULL,
  model_digest         TEXT,
  hardware_fingerprint TEXT NOT NULL,
  num_ctx              INTEGER NOT NULL,
  kv_cache_type        TEXT,
  think                TEXT,
  ollama_version       TEXT,
  driver_version       TEXT,
  size                 INTEGER,
  size_vram            INTEGER,
  offload_ratio        REAL,
  load_ms              INTEGER,
  prompt_tps           REAL,
  gen_tps              REAL,
  ttft_ms              INTEGER,
  peak_vram_mib        INTEGER,
  peak_ram_mib         INTEGER,
  quality_score        REAL,
  status               TEXT NOT NULL CHECK (status IN ('fits','partial','failed')),
  error                TEXT,
  tested_at            INTEGER NOT NULL
);
CREATE INDEX model_compat_lookup ON model_compat(model_digest, num_ctx, hardware_fingerprint, tested_at DESC);

CREATE TABLE benchmark_runs (
  id            TEXT PRIMARY KEY,
  suite_id      TEXT NOT NULL,
  model_name    TEXT NOT NULL,
  model_digest  TEXT,
  config_json   TEXT NOT NULL,
  results_json  TEXT NOT NULL,
  per_task_json TEXT,
  compat_id     TEXT REFERENCES model_compat(id),
  created_at    INTEGER NOT NULL
);

CREATE TABLE downloads (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL REFERENCES providers(id),
  model_name   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued','running','paused','cancelled','done','failed')),
  total        INTEGER,
  completed    INTEGER,
  layers_json  TEXT,
  started_at   INTEGER,
  finished_at  INTEGER,
  error        TEXT
);
CREATE INDEX downloads_status ON downloads(status, started_at DESC);

CREATE TABLE token_calibration (
  provider_id  TEXT NOT NULL REFERENCES providers(id),
  model_name   TEXT NOT NULL,
  ratio        REAL NOT NULL,
  samples      INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_name)
);

-- 4.8 Ajustes, métricas, settings, auditoría (profiles ya creada antes de agents) ----------------
CREATE TABLE run_adjustments (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs(id),
  param              TEXT NOT NULL,
  requested_json     TEXT,
  applied_json       TEXT,
  reason             TEXT,
  source             TEXT NOT NULL CHECK (source IN ('auto','user')),
  evidence_compat_id TEXT REFERENCES model_compat(id),
  reverted           INTEGER NOT NULL DEFAULT 0 CHECK (reverted IN (0,1)),
  created_at         INTEGER NOT NULL
);
CREATE INDEX run_adjustments_run ON run_adjustments(run_id);

CREATE TABLE metrics_minute (
  ts_minute      INTEGER PRIMARY KEY,
  cpu_avg        REAL,
  cpu_max        REAL,
  ram_used_avg   INTEGER,
  ram_used_max   INTEGER,
  gpu_util_avg   REAL,
  gpu_util_max   REAL,
  vram_used_avg  INTEGER,
  vram_used_max  INTEGER,
  gpu_temp_max   REAL,
  power_avg      REAL,
  app_rss_max    INTEGER,
  samples        INTEGER NOT NULL,
  quality_json   TEXT NOT NULL
);

CREATE TABLE settings (
  key         TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id  TEXT REFERENCES projects(id),
  CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
);
CREATE UNIQUE INDEX settings_global ON settings(key) WHERE project_id IS NULL;
CREATE UNIQUE INDEX settings_project ON settings(key, project_id) WHERE project_id IS NOT NULL;

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX audit_log_kind ON audit_log(kind, ts DESC);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

-- 5. Vistas de agregación (JSON1) ----------------------------------------------------------------
CREATE VIEW v_model_stats AS
SELECT
  json_extract(r.model_ref_json, '$.providerId')                  AS provider_id,
  json_extract(r.model_ref_json, '$.name')                        AS model_name,
  COUNT(*)                                                        AS turns,
  SUM(json_extract(m.response_metrics_json, '$.evalTokens'))      AS tokens_out,
  SUM(json_extract(m.response_metrics_json, '$.promptTokens'))    AS tokens_in,
  AVG(
    1.0 * json_extract(m.response_metrics_json, '$.evalTokens')
    / NULLIF(json_extract(m.response_metrics_json, '$.evalMs'), 0) * 1000
  )                                                                AS gen_tps_avg,
  AVG(
    1.0 * json_extract(m.response_metrics_json, '$.cachedPromptTokens')
    / NULLIF(json_extract(m.response_metrics_json, '$.promptTokens'), 0)
  )                                                                AS cache_hit_ratio_avg
FROM messages m
JOIN runs r ON r.id = m.run_id
WHERE m.role = 'assistant' AND m.response_metrics_json IS NOT NULL
GROUP BY 1, 2;

CREATE VIEW v_chat_stats AS
SELECT
  c.id AS chat_id,
  COUNT(DISTINCT r.id)                                            AS run_count,
  SUM(json_extract(r.metrics_json, '$.evalTokens'))               AS tokens_out_total,
  SUM(json_extract(r.metrics_json, '$.promptTokens'))             AS tokens_in_total,
  AVG(json_extract(r.metrics_json, '$.ttftClientMs'))             AS ttft_avg_ms,
  MAX(r.finished_at)                                              AS last_activity_at
FROM chats c
LEFT JOIN runs r ON r.chat_id = c.id
GROUP BY c.id;
`,
};
