// Schema drizzle de saurio.db (doc 03-modelo-de-datos.md §4; ORM elegido en ADR-004).
// DDL literal (tipos, PK/FK, CHECK, índices) vive en migrations/0001_init.ts porque drizzle-orm
// 0.45 no expresa CHECK/índices parciales/FTS5/triggers en su DSL de forma 1:1 con el SQL del doc 03;
// este archivo define las tablas con drizzle-orm/sqlite-core para tipar selects/inserts en los
// repositorios (doc 03 §1 "convenciones de tipos") — ver deviations en la salida de esta tarea.
// Solo tablas "Imprescindible para el MVP" (doc 03 §12) tienen repositorio real; el resto se define
// igual para que `saurio db rebuild`/migraciones no tengan que tocar el esquema después (Principio 8).
import { sqliteTable, text, integer, real, primaryKey, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

// ── 4.1 Proyectos, agentes, chats ────────────────────────────────────────────

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),
  name: text('name'),
  createdAt: integer('created_at').notNull(),
  lastOpenedAt: integer('last_opened_at'),
  settingsJson: text('settings_json'),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id),
  name: text('name').notNull(),
  role: text('role').notNull(),
  modelRefJson: text('model_ref_json').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  systemPromptHash: text('system_prompt_hash').notNull(),
  allowedToolsJson: text('allowed_tools_json').notNull(),
  permissionPolicyJson: text('permission_policy_json').notNull(),
  contextPolicyJson: text('context_policy_json').notNull(),
  memoryPolicyJson: text('memory_policy_json'),
  defaultMode: text('default_mode').notNull(),
  temperature: real('temperature'),
  thinking: text('thinking').notNull(),
  toolTransport: text('tool_transport').notNull(),
  maxIterations: integer('max_iterations').notNull(),
  workingDir: text('working_dir'),
  fileScope: text('file_scope'), // v0.4
  profileId: text('profile_id').references((): AnySQLiteColumn => profiles.id),
  isBuiltin: integer('is_builtin').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  agentId: text('agent_id').notNull().references(() => agents.id),
  title: text('title'),
  mode: text('mode').notNull(),
  modelRefJson: text('model_ref_json'),
  profileId: text('profile_id').references((): AnySQLiteColumn => profiles.id),
  overrideJson: text('override_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  archived: integer('archived').notNull().default(0),
});

// ── 4.2 Runs y log de eventos (fuente de verdad) ─────────────────────────────
// runs.owner_session_id / heartbeat_at: doc 10 §5.0 (single instance lock, MVP imprescindible).
// tool_calls.expected_pre_hash (abajo, §4.3): doc 10 §3/§5.2/§6 caso (13), MVP imprescindible.

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id),
  parentRunId: text('parent_run_id'), // subagentes v0.4; FK a runs(id) declarada en el DDL literal
  agentId: text('agent_id').notNull().references(() => agents.id),
  mode: text('mode').notNull(),
  modelRefJson: text('model_ref_json').notNull(),
  effectiveConfigJson: text('effective_config_json').notNull(),
  state: text('state').notNull(),
  stateReason: text('state_reason'),
  iteration: integer('iteration').notNull().default(0),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
  errorJson: text('error_json'),
  metricsJson: text('metrics_json'),
  lastEventSeq: integer('last_event_seq'),
  ownerSessionId: text('owner_session_id'),
  heartbeatAt: integer('heartbeat_at'),
});

export const runEvents = sqliteTable('run_events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull().references(() => runs.id),
  chatId: text('chat_id').notNull().references(() => chats.id),
  ts: integer('ts').notNull(),
  type: text('type').notNull(),
  payloadJson: text('payload_json').notNull(),
});

// ── 4.3 Proyecciones: mensajes y tool calls ──────────────────────────────────

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id),
  runId: text('run_id').references(() => runs.id),
  seq: integer('seq').notNull(), // contador monotónico POR CHAT (no es run_events.seq, doc 03 desvío 2)
  role: text('role').notNull(),
  content: text('content'),
  thinking: text('thinking'),
  toolCallsJson: text('tool_calls_json'),
  toolCallId: text('tool_call_id'),
  toolName: text('tool_name'),
  tokenEstimate: integer('token_estimate'),
  responseMetricsJson: text('response_metrics_json'),
  truncated: integer('truncated').notNull().default(0),
  compactedBy: text('compacted_by'),
  createdAt: integer('created_at').notNull(),
});

export const toolCalls = sqliteTable('tool_calls', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  messageId: text('message_id').references(() => messages.id),
  iteration: integer('iteration'),
  toolName: text('tool_name').notNull(),
  argsJson: text('args_json').notNull(),
  argsHash: text('args_hash').notNull(),
  category: text('category').notNull(),
  risk: text('risk').notNull(),
  transport: text('transport').notNull(),
  status: text('status').notNull(),
  permissionDecisionId: text('permission_decision_id').references((): AnySQLiteColumn => permissionDecisions.id),
  checkpointId: text('checkpoint_id').references((): AnySQLiteColumn => checkpoints.id),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
  resultPreview: text('result_preview'),
  resultPath: text('result_path'),
  resultIsError: integer('result_is_error'),
  errorJson: text('error_json'),
  matchLevel: text('match_level'),
  expectedPreHash: text('expected_pre_hash'), // doc 10 §3/§5.2, MVP imprescindible
});

// ── 4.4 Permisos ──────────────────────────────────────────────────────────────

export const permissionRules = sqliteTable('permission_rules', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull(),
  projectId: text('project_id').references(() => projects.id),
  toolName: text('tool_name').notNull(),
  pattern: text('pattern'),
  decision: text('decision').notNull(),
  source: text('source').notNull(),
  createdAt: integer('created_at').notNull(),
  sourceToolCallId: text('source_tool_call_id').references(() => toolCalls.id),
});

export const permissionDecisions = sqliteTable('permission_decisions', {
  id: text('id').primaryKey(),
  toolCallId: text('tool_call_id').notNull().references(() => toolCalls.id),
  decision: text('decision').notNull(),
  ruleId: text('rule_id').references(() => permissionRules.id),
  decidedBy: text('decided_by').notNull(),
  reason: text('reason'),
  decidedAt: integer('decided_at').notNull(),
});

// ── 4.5 Checkpoints ────────────────────────────────────────────────────────────

export const checkpoints = sqliteTable('checkpoints', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  chatId: text('chat_id').notNull().references(() => chats.id),
  toolCallId: text('tool_call_id').references(() => toolCalls.id),
  iteration: integer('iteration'),
  label: text('label'),
  kind: text('kind').notNull(),
  createdAt: integer('created_at').notNull(),
  statsJson: text('stats_json'),
  status: text('status').notNull().default('active'),
  revertedAt: integer('reverted_at'),
});

export const checkpointFiles = sqliteTable('checkpoint_files', {
  checkpointId: text('checkpoint_id').notNull().references(() => checkpoints.id),
  relPath: text('rel_path').notNull(),
  change: text('change').notNull(),
  preHash: text('pre_hash'),
  postHash: text('post_hash'),
  preEol: text('pre_eol'),
  preBom: integer('pre_bom'),
  preMode: integer('pre_mode'),
  blobMissing: integer('blob_missing').notNull().default(0),
}, (table) => [primaryKey({ columns: [table.checkpointId, table.relPath] })]);

export const blobs = sqliteTable('blobs', {
  hash: text('hash').primaryKey(),
  size: integer('size').notNull(),
  createdAt: integer('created_at').notNull(),
  refcount: integer('refcount').notNull().default(1),
});

// ── 4.6 Tasks, memoria de proyecto, repo map ──────────────────────────────────

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id),
  runId: text('run_id').references(() => runs.id),
  ord: integer('ord').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const projectMemory = sqliteTable('project_memory', {
  projectId: text('project_id').notNull().references(() => projects.id),
  key: text('key').notNull(),
  content: text('content').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [primaryKey({ columns: [table.projectId, table.key] })]);

export const repoMapCache = sqliteTable('repo_map_cache', {
  projectId: text('project_id').notNull().references(() => projects.id),
  relPath: text('rel_path').notNull(),
  mtime: integer('mtime').notNull(),
  size: integer('size').notNull(),
  lang: text('lang'),
  tagsJson: text('tags_json'),
}, (table) => [primaryKey({ columns: [table.projectId, table.relPath] })]);

// ── 4.7 Providers y modelos ────────────────────────────────────────────────────

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  transport: text('transport').notNull(),
  baseUrl: text('base_url').notNull(),
  isLoopback: integer('is_loopback').notNull(),
  enabled: integer('enabled').notNull().default(1),
  mode: text('mode').notNull(),
  maxConcurrency: integer('max_concurrency').notNull().default(1),
  configJson: text('config_json'),
});

export const models = sqliteTable('models', {
  providerId: text('provider_id').notNull().references(() => providers.id),
  name: text('name').notNull(),
  digest: text('digest'),
  size: integer('size'),
  detailsJson: text('details_json'),
  capabilitiesJson: text('capabilities_json'),
  modelInfoJson: text('model_info_json'),
  contextMax: integer('context_max'),
  locality: text('locality').notNull(),
  refreshedAt: integer('refreshed_at').notNull(),
}, (table) => [primaryKey({ columns: [table.providerId, table.name] })]);

export const modelLoadSamples = sqliteTable('model_load_samples', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull().references(() => providers.id),
  modelName: text('model_name').notNull(),
  modelDigest: text('model_digest'),
  numCtx: integer('num_ctx').notNull(),
  size: integer('size'),
  sizeVram: integer('size_vram'),
  contextLength: integer('context_length'),
  loadMs: integer('load_ms'),
  estimatedVram: integer('estimated_vram'),
  sampledAt: integer('sampled_at').notNull(),
});

export const modelCompat = sqliteTable('model_compat', { // v0.3
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull().references(() => providers.id),
  modelName: text('model_name').notNull(),
  modelDigest: text('model_digest'),
  hardwareFingerprint: text('hardware_fingerprint').notNull(),
  numCtx: integer('num_ctx').notNull(),
  kvCacheType: text('kv_cache_type'),
  think: text('think'),
  ollamaVersion: text('ollama_version'),
  driverVersion: text('driver_version'),
  size: integer('size'),
  sizeVram: integer('size_vram'),
  offloadRatio: real('offload_ratio'),
  loadMs: integer('load_ms'),
  promptTps: real('prompt_tps'),
  genTps: real('gen_tps'),
  ttftMs: integer('ttft_ms'),
  peakVramMib: integer('peak_vram_mib'),
  peakRamMib: integer('peak_ram_mib'),
  qualityScore: real('quality_score'),
  status: text('status').notNull(),
  error: text('error'),
  testedAt: integer('tested_at').notNull(),
});

export const benchmarkRuns = sqliteTable('benchmark_runs', { // v0.3
  id: text('id').primaryKey(),
  suiteId: text('suite_id').notNull(),
  modelName: text('model_name').notNull(),
  modelDigest: text('model_digest'),
  configJson: text('config_json').notNull(),
  resultsJson: text('results_json').notNull(),
  perTaskJson: text('per_task_json'),
  compatId: text('compat_id').references(() => modelCompat.id),
  createdAt: integer('created_at').notNull(),
});

export const downloads = sqliteTable('downloads', { // v0.2
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull().references(() => providers.id),
  modelName: text('model_name').notNull(),
  status: text('status').notNull(),
  total: integer('total'),
  completed: integer('completed'),
  layersJson: text('layers_json'),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
  error: text('error'),
});

export const tokenCalibration = sqliteTable('token_calibration', {
  providerId: text('provider_id').notNull().references(() => providers.id),
  modelName: text('model_name').notNull(),
  ratio: real('ratio').notNull(),
  samples: integer('samples').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [primaryKey({ columns: [table.providerId, table.modelName] })]);

// ── 4.8 Perfiles, ajustes, métricas, settings, auditoría ──────────────────────

export const profiles = sqliteTable('profiles', { // filas reales v0.2; 3 built-in estáticas desde MVP
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id),
  name: text('name').notNull(),
  isBuiltin: integer('is_builtin').notNull().default(0),
  isDefault: integer('is_default').notNull().default(0),
  configJson: text('config_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const runAdjustments = sqliteTable('run_adjustments', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  param: text('param').notNull(),
  requestedJson: text('requested_json'),
  appliedJson: text('applied_json'),
  reason: text('reason'),
  source: text('source').notNull(),
  evidenceCompatId: text('evidence_compat_id').references(() => modelCompat.id),
  reverted: integer('reverted').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const metricsMinute = sqliteTable('metrics_minute', { // v0.2
  tsMinute: integer('ts_minute').primaryKey(),
  cpuAvg: real('cpu_avg'),
  cpuMax: real('cpu_max'),
  ramUsedAvg: integer('ram_used_avg'),
  ramUsedMax: integer('ram_used_max'),
  gpuUtilAvg: real('gpu_util_avg'),
  gpuUtilMax: real('gpu_util_max'),
  vramUsedAvg: integer('vram_used_avg'),
  vramUsedMax: integer('vram_used_max'),
  gpuTempMax: real('gpu_temp_max'),
  powerAvg: real('power_avg'),
  appRssMax: integer('app_rss_max'),
  samples: integer('samples').notNull(),
  qualityJson: text('quality_json').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').notNull(),
  valueJson: text('value_json').notNull(),
  scope: text('scope').notNull(),
  projectId: text('project_id').references(() => projects.id),
  // unicidad real en índices únicos parciales (settings_global/settings_project, doc 03 desvío 4),
  // no en esta definición drizzle (sin PK propia, igual que el DDL literal)
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts').notNull(),
  kind: text('kind').notNull(),
  payloadJson: text('payload_json').notNull(),
});

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  checksum: text('checksum').notNull(),
  appliedAt: integer('applied_at').notNull(),
});
