# Documento 03 — Modelo de datos SQLite de SaurioLLM

**Propósito:** especificar el esquema SQLite completo (DDL, índices, PRAGMAs), qué se escribe en cada transición del run para permitir recuperación sin pérdida ni repetición, las consultas típicas de la app, la estrategia de migraciones, retención y backup — como insumo directo para el scaffolding de `packages/runtime/src/persistence/`.

**Leyenda:** `[COMPROBADO EN EQUIPO]` `[VERIFICADO EN DOC OFICIAL]` `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]`

---

## 1. Enfoque general

El modelo sigue la decisión de la columna vertebral (§1.2, ADR-3): **`run_events` es la fuente de verdad** (append-only), y `messages`, `tool_calls`, `runs.state/iteration/metrics_json`, `tasks`, `checkpoints` son **proyecciones** escritas en la misma transacción que el evento que las origina `[DECISIÓN DE DISEÑO]`. Esto es lo que permite `saurio db rebuild`: si una proyección se corrompe o el esquema de una tabla cambia, se puede reconstruir leyendo `run_events` desde el principio, sin perder información. Las tablas que **no** son proyecciones del log (`checkpoints`, `blobs`, `permission_*`, `models`, `settings`, catálogo de modelos, métricas de sistema) tienen su propio ciclo de vida y `saurio db rebuild` no las toca.

Un único archivo `saurio.db` vive en `appData` (ruta de Electron `app.getPath('userData')`), junto con `appData/blobs/<hash>` (pre/post-imágenes de archivos tocados por el agente) y `appData/tool-outputs/<toolCallId>.txt` (salidas de tools que superan 30.000 caracteres). Estos dos últimos son almacenamiento de archivos plano, no SQLite; el DDL de este documento cubre solo `saurio.db`.

Convenciones de tipos `[DECISIÓN DE DISEÑO]`:
- Todos los `id` son `TEXT PRIMARY KEY`. Se generan como **ULID** (26 caracteres, ordenables lexicográficamente por tiempo de creación) salvo `run_events.seq`, que es `INTEGER PRIMARY KEY AUTOINCREMENT` porque necesita ser un contador estrictamente monótono y comparable con `<`/`>` para paginar el log — un ULID también lo permitiría, pero el autoincrement de SQLite es más barato y no requiere generarlo en la capa de aplicación.
- Los sufijos `_json` son `TEXT` que contienen JSON validado con el esquema zod correspondiente al leer (nunca al escribir sin validar). SQLite no tiene tipo JSON nativo; se usa la extensión JSON1 (`json_extract`, `json_each`) para las vistas de agregación y algunas consultas de diagnóstico.
- Los timestamps son `INTEGER` en milisegundos desde epoch (`Date.now()`), nunca `TEXT` de fecha, para que las comparaciones y los índices funcionen sin `strftime`.
- Los enums se validan en dos capas: en TypeScript con los `zod.enum` de `packages/shared/src/enums.ts` (fuente única, §5 de la columna vertebral) y en SQLite con `CHECK (col IN (...))` que replica exactamente esos mismos valores. La columna vertebral no incluye estos `CHECK` en el DDL de su §4; los agregamos aquí porque el brief de este documento los pide explícitamente y porque sin ellos SQLite aceptaría cualquier string y se perdería la garantía de que el esquema y el código comparten una única fuente de verdad de nomenclatura (ver "Desvíos" al final).
- Ninguna tabla usa `ON DELETE CASCADE`: en este dominio casi no se borra (la política de retención es conservadora, ver §7); donde hace falta borrar (p. ej. `permission_rules`), se hace explícitamente desde la app, nunca en cascada implícita, para que quede como evento auditable.

---

## 2. PRAGMAs de conexión

Se aplican una vez por conexión, en `persistence/driver.ts`, antes de cualquier consulta:

```sql
PRAGMA journal_mode = WAL;        -- lecturas concurrentes con la escritura del runtime; necesario para
                                   -- que el panel de rendimiento lea metrics_minute mientras un run escribe
PRAGMA synchronous = NORMAL;      -- seguro con WAL; FULL sería más lento sin beneficio adicional en este modo
                                   -- [VERIFICADO EN DOC OFICIAL: sqlite.org/pragma.html#pragma_synchronous]
PRAGMA foreign_keys = ON;         -- SQLite las trae desactivadas por defecto; sin esto ninguna REFERENCES
                                   -- de esta sección se hace cumplir [VERIFICADO EN DOC OFICIAL: sqlite.org/foreignkeys.html]
PRAGMA busy_timeout = 5000;       -- 5 s de espera ante SQLITE_BUSY antes de fallar; cubre el caso de dos
                                   -- procesos (ventana principal + eval/harness) tocando el archivo a la vez
PRAGMA temp_store = MEMORY;       -- índices temporales de FTS5/JSON1 en RAM, no en disco N:
```

`better-sqlite3` abre una sola conexión por proceso `main` (no hay pool); el `utilityProcess` del `ProjectIndexer` **no** toca `saurio.db` directamente — habla con el runtime por su propio canal y el runtime persiste `repo_map_cache`. Esto evita el caso de dos escritores en WAL desde procesos distintos, que sí puede tener contención real `[HIPÓTESIS A PROBAR: si el `eval/` harness corre en paralelo a la app]`.

---

## 3. Diagrama entidad-relación

```mermaid
erDiagram
  projects ||--o{ agents : "opcional"
  projects ||--o{ chats : contiene
  agents ||--o{ chats : usa
  chats ||--o{ runs : tiene
  runs ||--o{ run_events : genera
  runs ||--o| runs : "parent_run_id (subagentes v0.4)"
  runs ||--o{ messages : proyecta
  runs ||--o{ tool_calls : proyecta
  runs ||--o{ tasks : proyecta
  runs ||--o{ checkpoints : origina
  runs ||--o{ run_adjustments : registra
  tool_calls ||--o| checkpoints : "dispara (si mutating)"
  tool_calls ||--o| permission_decisions : "si ask"
  checkpoints ||--o{ checkpoint_files : detalla
  checkpoint_files }o--o| blobs : referencia
  permission_decisions }o--o| permission_rules : "aplica / crea"
  providers ||--o{ models : expone
  providers ||--o{ downloads : "descarga en"
  models ||--o{ model_load_samples : "cada carga real"
  models ||--o{ model_compat : "benchmark (v0.3)"
  model_compat ||--o{ benchmark_runs : origina
  models ||--o{ token_calibration : calibra
  chats }o--o| profiles : "perfil opcional"
  agents }o--o| profiles : "perfil por defecto"

  projects {
    TEXT id PK
    TEXT path UK
    TEXT name
    INTEGER created_at
  }
  chats {
    TEXT id PK
    TEXT project_id FK
    TEXT agent_id FK
    TEXT mode
  }
  runs {
    TEXT id PK
    TEXT chat_id FK
    TEXT parent_run_id FK
    TEXT state
  }
  run_events {
    INTEGER seq PK
    TEXT run_id FK
    TEXT type
    TEXT payload_json
  }
  messages {
    TEXT id PK
    TEXT chat_id FK
    TEXT run_id FK
    INTEGER seq
  }
  tool_calls {
    TEXT id PK
    TEXT run_id FK
    TEXT status
    TEXT checkpoint_id FK
  }
  checkpoints {
    TEXT id PK
    TEXT run_id FK
    TEXT tool_call_id FK
    TEXT status
  }
  checkpoint_files {
    TEXT checkpoint_id PK_FK
    TEXT rel_path PK
    TEXT pre_hash
    TEXT post_hash
  }
  blobs {
    TEXT hash PK
    INTEGER size
    INTEGER refcount
  }
```

El diagrama omite (por claridad, no por ausencia) `permission_rules`, `permission_decisions`, `project_memory`, `repo_map_cache`, `token_calibration`, `metrics_minute`, `settings`, `audit_log`, que se detallan en el DDL con sus propias relaciones débiles (por `id` de texto libre, no todas con FK — ver justificación por tabla).

---

## 4. DDL completo

### 4.1 Proyectos, agentes, chats

```sql
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  path            TEXT UNIQUE NOT NULL,
  name            TEXT,
  created_at      INTEGER NOT NULL,
  last_opened_at  INTEGER,
  settings_json   TEXT
);

CREATE TABLE agents (
  id                       TEXT PRIMARY KEY,
  project_id               TEXT REFERENCES projects(id),   -- NULL = agente global (built-in)
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
  file_scope               TEXT,                            -- v0.4
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
  override_json TEXT,                                          -- override puntual de ProfileConfig para este chat; no crea fila en profiles (doc 15 §7/§12)
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
);
CREATE INDEX chats_project ON chats(project_id, updated_at DESC);
```

**Justificación.** `projects.path` es `UNIQUE` porque abrir la misma carpeta dos veces debe reutilizar el proyecto, no duplicarlo (paso 1 del recorrido de validación, §15 de la columna vertebral). `agents.project_id` es nullable para los agentes built-in (el "Coder" por defecto) que no pertenecen a un proyecto y se instancian igual en cualquiera; `is_builtin` los distingue en la UI de edición de agentes (v0.4). `system_prompt_hash` se guarda aparte del texto porque `effective_config_json` de cada run solo necesita el hash para el prefijo cacheado (§8 de la columna vertebral) — comparar hashes es más barato que comparar strings largos al decidir si el prompt cambió entre runs. `chats.mode` es el modo con el que se creó el chat pero cada `run` puede cambiar de modo (el usuario alterna plan/agent en la misma conversación, paso 4 del recorrido), por eso `runs.mode` es la fuente real por ejecución y `chats.mode` es solo el default para el próximo `run:start`. `chats.override_json` guarda el override puntual de `ProfileConfig` para ese chat específico (nivel más específico de la cadena de precedencia de perfiles, doc 15 §7): es la alternativa más económica a crear una fila efímera en `profiles` por cada ajuste manual de un solo chat.

### 4.2 Runs y log de eventos (fuente de verdad)

```sql
CREATE TABLE runs (
  id                     TEXT PRIMARY KEY,
  chat_id                TEXT NOT NULL REFERENCES chats(id),
  parent_run_id          TEXT REFERENCES runs(id),          -- subagentes (v0.4); columna desde la migración 1
  agent_id               TEXT NOT NULL REFERENCES agents(id),
  mode                   TEXT NOT NULL CHECK (mode IN ('plan','ask','edit','agent')),
  model_ref_json         TEXT NOT NULL,
  effective_config_json  TEXT NOT NULL,                     -- inmutable al iniciar: numCtx, think, tools, promptHash, profileId
  state                  TEXT NOT NULL CHECK (state IN (
                            'created','preparing','queued','generating','parsing','awaiting_permission',
                            'executing_tool','compacting','cancelling','completed','cancelled','failed','interrupted')),
  state_reason           TEXT,
  iteration              INTEGER NOT NULL DEFAULT 0,
  started_at             INTEGER,
  finished_at            INTEGER,
  error_json             TEXT,
  metrics_json           TEXT,
  last_event_seq         INTEGER
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
```

**Justificación.** `runs_active` es un índice parcial (`WHERE state IN (...)`) porque la consulta más caliente del arranque de la app (`recover()`) y del selector "¿hay un run corriendo en este chat?" filtra exactamente por esos estados; un índice parcial es más chico y más rápido que uno sobre toda la columna `state`, que en régimen permanente tiene mayoría de filas en `completed`. `run_events.type` no tiene `CHECK` con la lista completa de `RunEvent` (a diferencia de los enums de estado) porque esa lista es un `z.discriminatedUnion` con 15 variantes que puede crecer en cada versión menor sin tocar el esquema SQL — validar el tipo de evento es responsabilidad de zod al leer/escribir `payload_json`, no de SQLite; forzarlo aquí duplicaría el mantenimiento en dos lugares cada vez que se agregue un tipo de evento. `parent_run_id` existe desde la migración 1 aunque no se use hasta v0.4 (Principio 8, excepción explícita de la columna vertebral) para no tener que hacer un `ALTER TABLE` sobre una tabla con foreign keys activas el día que se implemente delegación.

### 4.3 Proyecciones: mensajes y tool calls

```sql
CREATE TABLE messages (
  id                     TEXT PRIMARY KEY,
  chat_id                TEXT NOT NULL REFERENCES chats(id),
  run_id                 TEXT REFERENCES runs(id),
  seq                    INTEGER NOT NULL,                  -- contador monotónico POR CHAT (no es run_events.seq)
  role                   TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content                TEXT,
  thinking               TEXT,
  tool_calls_json        TEXT,
  tool_call_id           TEXT,
  tool_name              TEXT,
  token_estimate         INTEGER,
  response_metrics_json  TEXT,
  truncated              INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  compacted_by           TEXT REFERENCES messages(id),      -- id del mensaje-resumen que lo reemplaza; nunca se borra
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
  match_level           TEXT CHECK (match_level IN ('exact','eol','indent','whitespace','fuzzy'))  -- solo edit_file
);
CREATE INDEX tool_calls_run ON tool_calls(run_id, iteration);
CREATE INDEX tool_calls_open ON tool_calls(status) WHERE status IN
  ('pending','awaiting_permission','approved','running','awaiting_input');
CREATE INDEX tool_calls_args_hash ON tool_calls(run_id, args_hash);  -- detectar repeticiones (§12: "ya intentaste esto")
```

**Justificación.** `messages.seq` es un contador que el `AgentRuntime` incrementa por `chat_id` (no es el mismo número que `run_events.seq`, que es global a toda la base): un chat acumula mensajes a través de varios `runs` sucesivos (plan, luego agent, luego un `run:continue`), y la UI necesita un orden total y compacto dentro del chat para paginar sin tener que hacer `JOIN` con `runs.started_at`. Esta distinción no está explícita en la columna vertebral, que usa el nombre `seq` en ambas tablas; se documenta en "Desvíos" para que el scaffolding no comparta el contador por error. `messages.compacted_by` tiene FK a la propia tabla porque el mensaje resumen (nivel 2 de compactación, §8) es también una fila de `messages`; nunca se hace `DELETE`, así que el historial completo se puede auditar aunque la mayoría del contexto ya no se envíe al modelo. FTS5 en modo `content='messages'` (contentless-adjacent, en realidad "external content") evita duplicar el texto: la tabla virtual solo guarda el índice invertido y usa `rowid` para ir a buscar el contenido real; los tres triggers son el patrón estándar recomendado para mantenerlo sincronizado `[VERIFICADO EN DOC OFICIAL: sqlite.org/fts5.html §4.1 "External Content Tables"]`. `tool_calls.category`/`risk` se congelan en el momento del registro (no se recalculan después) porque son la base de la decisión de permisos que ya se tomó; si `PermissionEngine` cambiara de idea retroactivamente, el usuario perdería la trazabilidad de por qué se le preguntó lo que se le preguntó. `tool_calls_args_hash` sostiene la funcionalidad de "ya intentaste esto antes del cierre" del punto 5 de `recover()` en la columna vertebral (§12).

### 4.4 Permisos

```sql
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
```

**Justificación.** `permission_rules.pattern` es `TEXT` libre (no `CHECK`) porque el patrón es un glob para paths o un prefijo de tokens para comandos según `tool_name`; validarlo en SQL requeriría reimplementar el `CommandParser` en SQL, así que la validación de forma vive en la capa de aplicación y aquí solo se persiste el string ya validado. `git_push` nunca aparece con `decision = 'allow'` en una fila creada desde el diálogo del chat (invariante de negocio, §7 de la columna vertebral); esto **no** se refuerza con un `CHECK` porque Settings → Permisos sí puede, en teoría, guardar una regla explícita fuera del flujo del chat (la propia columna vertebral lo permite como única excepción) — un `CHECK` lo bloquearía sin distinguir el origen, así que la invariante queda en `PermissionEngine.evaluate`, no en el esquema. `permission_decisions.rule_id` es nullable porque una decisión puede venir de una elección puntual del usuario ("permitir una vez") sin crear regla.

### 4.5 Checkpoints

```sql
CREATE TABLE checkpoints (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  chat_id      TEXT NOT NULL REFERENCES chats(id),
  tool_call_id TEXT REFERENCES tool_calls(id),
  iteration    INTEGER,
  label        TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('tool','revert')),
  created_at   INTEGER NOT NULL,
  stats_json   TEXT,                                        -- { files, added, removed }
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reverted','partial')),
  reverted_at  INTEGER
);
CREATE INDEX checkpoints_run ON checkpoints(run_id, created_at);
CREATE INDEX checkpoints_chat ON checkpoints(chat_id, created_at DESC);

CREATE TABLE checkpoint_files (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
  rel_path      TEXT NOT NULL,
  change        TEXT NOT NULL CHECK (change IN ('created','modified','deleted')),
  pre_hash      TEXT,                                        -- NULL si change='created'
  post_hash     TEXT,                                        -- NULL si change='deleted'
  pre_eol       TEXT,
  pre_bom       INTEGER CHECK (pre_bom IN (0,1)),
  pre_mode      INTEGER,
  blob_missing  INTEGER NOT NULL DEFAULT 0 CHECK (blob_missing IN (0,1)),  -- >20 MB: hash sin blob en disco
  PRIMARY KEY (checkpoint_id, rel_path)
);

CREATE TABLE blobs (
  hash        TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  refcount    INTEGER NOT NULL DEFAULT 1 CHECK (refcount >= 0)
);
```

**Justificación.** `checkpoint_files.pre_hash`/`post_hash` **no** llevan `REFERENCES blobs(hash)` a propósito: pueden ser `NULL` (archivo creado o borrado) y, sobre todo, un archivo de más de 20 MB se registra con `blob_missing = 1` y **sin** fila en `blobs` (la columna vertebral decide no guardar el contenido de archivos grandes, solo su hash, para no inflar `appData/blobs`); una foreign key obligatoria rompería ese caso. `blobs.refcount` empieza en 1 al crear el blob y se incrementa si el mismo contenido exacto vuelve a aparecer como pre-imagen o post-imagen de otro archivo (deduplicación por contenido, típico cuando dos ediciones sucesivas dejan el archivo igual a un estado anterior); en el MVP nunca se decrementa porque no hay borrado de checkpoints, así que no hay recolección de blobs huérfanos (se declara explícitamente como "previsto para más adelante" en §8, no como bug). `checkpoints.status = 'partial'` cubre el caso de un revert con conflictos donde algunos archivos se restauraron y otros no (§13 de la columna vertebral, revert a tres vías).

### 4.6 Tasks, memoria de proyecto, repo map

```sql
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
```

**Justificación.** `tasks.ord` en vez de depender del orden de inserción: el modelo puede reordenar el plan (`task_update` manda la lista completa) y `ord` es lo que la UI usa para renderizar el checklist en el orden que el agente decidió, no en el orden en que las filas se crearon en SQLite (que podría no coincidir tras un `UPDATE`). `repo_map_cache` se invalida por `(mtime, size)` en vez de por hash de contenido porque calcular el hash de cada archivo del proyecto en cada `fs.watch` sería más caro que lo que ahorra — comparar `mtime`/`size` es la misma heurística que usa git para `git status` rápido `[VERIFICADO EN DOC OFICIAL: git-scm.com/docs/git-update-index, "racy git"]`, con el mismo riesgo aceptado (falso negativo si un archivo cambia dentro del mismo milisegundo con igual tamaño, extremadamente improbable en uso interactivo).

### 4.7 Providers y modelos

```sql
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
  estimated_vram   INTEGER,                                 -- lo que predijo MemoryEstimator ANTES de cargar
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
```

**Justificación.** `model_load_samples` y `model_compat` están deliberadamente separadas aunque se parecen (ambas guardan `size_vram`, `load_ms`, etc.): la primera la escribe **`ModelManager`** en cada carga real durante el uso normal (dato incidental, sin metodología de medición controlada — puede haber otro proceso usando la GPU al mismo tiempo); la segunda la escribe **únicamente `Benchmark`** (v0.3) bajo condiciones controladas (slot exclusivo, warm-up, repeticiones, mediana). Mezclarlas haría que una carga "sucia" contaminara el badge "probado" que ve el usuario en el Centro de modelos — la separación de responsabilidades entre ambas tablas es la que impone la condición 11.C del usuario ("Cualquier ajuste automático debe ser visible y reversible" y "guardar el resultado como compatibilidad probada" son cosas distintas). `models` no tiene columna `installed_at` porque Ollama no expone esa fecha por API; `refreshed_at` es cuándo `ModelManager` lo vio por última vez en `/api/tags`, que es lo único medible. `token_calibration` usa PK compuesta `(provider_id, model_name)` en vez de un `id` propio porque es un acumulador (un EMA, §8 de la columna vertebral) con una sola fila vigente por modelo, no un historial — no hay motivo para tener múltiples filas.

### 4.8 Perfiles, ajustes, métricas, settings, auditoría

```sql
CREATE TABLE profiles (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id),                -- NULL = perfil global (rapido|equilibrado|calidad)
  name         TEXT NOT NULL,
  is_builtin   INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0,1)),
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),  -- perfil preseleccionado para chats/agentes nuevos (doc 15 §12)
  config_json  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

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
  quality_json   TEXT NOT NULL                                -- 'measured'|'estimated'|'unavailable' por campo
);

CREATE TABLE settings (
  key         TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id  TEXT REFERENCES projects(id),                      -- NULL = global; ver Desvíos (unicidad real vive en los índices, no en una PK)
  CHECK ((scope = 'global' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
);
-- SQLite trata cada NULL como distinto en un UNIQUE/PK, así que `project_id` nullable no puede ir en la
-- clave primaria (permitiría múltiples filas 'global' para la misma key): la unicidad real se declara con
-- dos índices únicos parciales, uno por rama de `scope`.
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
```

**Justificación.** `settings` cambia la clave respecto de la columna vertebral: en §4 de la columna vertebral figura `PRIMARY KEY(key)` implícito (columna `key TEXT PRIMARY KEY`), pero la misma sección declara `scope` (`global`/`project`) y `project_id`, lo que implica que la **misma clave** (`inference.slots`, por ejemplo) puede existir a nivel global y, superpuesta, a nivel de un proyecto puntual — con `key` como PK sola, guardar el override de un proyecto pisaría el valor global. Una PK compuesta `(key, scope, project_id)` con `project_id` nullable no alcanza para corregirlo: SQLite considera cada `NULL` distinto de cualquier otro a efectos de unicidad, así que la fila global (`scope='global'`, `project_id=NULL`) podría insertarse repetidas veces sin violar la PK, justo el caso que es el 100% de los settings del MVP. Se corrige dejando `project_id` como columna simple (sin PK propia) y declarando la unicidad con dos índices únicos parciales — `settings_global` para `project_id IS NULL` y `settings_project` para `project_id IS NOT NULL` — que sí distinguen ambas ramas correctamente; ver "Desvíos". `schema_migrations` es una tabla que la columna vertebral no menciona por nombre pero que este documento agrega (ver §6, Migraciones) para poder auditar qué migraciones corrieron y detectar un archivo corrupto o una migración a medias, complementando — no reemplazando — `PRAGMA user_version`. `audit_log.kind` es texto libre (no enum) porque cubre eventos heterogéneos y de bajo volumen que crecen con el tiempo: cambios de `settings`, decisiones de localidad no local, reinicios, migraciones aplicadas — forzar un enum aquí obligaría a tocar el esquema por cada tipo nuevo de auditoría, algo que para una tabla de solo-lectura-ocasional no se justifica.

---

## 5. Vistas de agregación (JSON1, sin tablas redundantes)

```sql
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
```

`v_model_stats` agrupa por `provider_id`/`model_name` extraídos de `r.model_ref_json` (`GROUP BY 1, 2`), no por columnas de `messages` (que no tiene `provider_id` ni un `tool_name` que identifique al modelo — `tool_name` en `messages` es el nombre de la tool invocada, no del modelo). Ambas vistas leen directamente `response_metrics_json`/`metrics_json`, que ya están en `measured`/`estimated` según el proveedor (§18 de la columna vertebral); no se materializan como tablas para no duplicar información que ya vive en `messages`/`runs` — a la escala de un usuario solo (cientos de runs, no millones), una vista calculada al vuelo con índices sobre `chat_id`/`run_id` es suficiente `[HIPÓTESIS A PROBAR: tiempo de respuesta de la vista pasados varios miles de runs]`.

---

## 6. Qué se escribe en cada transición del run (recuperación, condición 4)

Cada fila de esta tabla es una transacción SQLite (`BEGIN IMMEDIATE` / `COMMIT`) que el `AgentRuntime` ejecuta como una unidad antes de notificar a la UI por IPC. El orden de escritura dentro de la transacción no importa (es atómica), pero el orden **entre** transacciones es el que reconstruye la máquina de estados en `recover()`.

| Transición | Tablas escritas | Nota de recuperación |
|---|---|---|
| `run:start` recibido | `runs` (`created`) + `run_events` + `messages` (rol `user`) | Si el proceso muere aquí, al reiniciar no hay run en estado activo previo — el mensaje del usuario puede quedar huérfano sin run asociado; se decide en el arranque de la UI, no en `recover()` (no es un caso de la tabla de fallos, ver nota abajo) |
| `preparing` | `runs.state`, `run_events`, `run_adjustments` (si hubo cap de `num_ctx`) | `effective_config_json` se escribe **antes** de la primera llamada al Gateway; es lo que permite reconstruir con qué configuración exacta corrió cada iteración |
| Tool call detectada (antes de cualquier chequeo) | `tool_calls` (`pending`) + `run_events` (`tool.registered`) | Esta es la escritura de **write-ahead** que pide la condición 4: la fila existe en SQLite antes de que `PermissionEngine` decida nada y antes de que se ejecute cualquier efecto |
| Permiso requerido | `tool_calls.status = awaiting_permission`, `runs.state = awaiting_permission`, `run_events` (`tool.permission` con el `PermissionRequest` completo) | El `PermissionRequest` viaja completo dentro del evento (no solo un id) para poder re-mostrar la tarjeta de permiso tras un reinicio sin tener que recalcular el diff en seco |
| Usuario responde | `permission_decisions` (+ `permission_rules` si "permitir siempre"), `run_events` (`tool.decision`), `tool_calls.status = approved|denied` | Si "permitir siempre", la regla se inserta en la misma transacción que la decisión — no puede existir una decisión "allow" sin la regla que la originó si el usuario pidió recordarla |
| Antes de ejecutar (si `mutating`) | `CheckpointService.begin`: pre-imágenes a `appData/blobs/<hash>` (fuera de SQLite) + fila `checkpoints` + `checkpoint_files` (columnas `pre_*`; `post_hash` aún NULL) | Las pre-imágenes se escriben a disco **antes** de tocar el archivo real; si el proceso muere entre esto y la ejecución, el archivo original sigue intacto en `appData/blobs` |
| Ejecución (`executing_tool`) | `tool_calls.status = running`, `started_at`, `checkpoint_id`; `runs.state = executing_tool` | Esta es la fila que, si el proceso muere aquí, `recover()` encuentra en `running` y marca `orphaned` (nunca se re-ejecuta sola) |
| Tool terminó | `checkpoint_files.post_hash` + `checkpoints.stats_json` (commit) + `tool_calls.status = done|failed`, `result_preview`, `result_path` + `run_events` (`tool.status`, `checkpoint.created`) | `result_path` apunta a `tool-outputs/<id>.txt` solo si el resultado superó 30.000 caracteres |
| Mensaje del asistente cerrado | `messages` (rol `assistant`, `response_metrics_json`) + `run_events` (`message.done`) | Los chunks del streaming (`message.delta`) **no** se persisten; solo el mensaje final. Si el proceso muere a mitad de un stream, el mensaje parcial se guarda con `truncated = 1` recién al detectarse el corte (ver fila siguiente) |
| Stream cortado / cancelación | `messages` (parcial, `truncated = 1`) + `run_events` (`run.error` o transición a `cancelling`/`cancelled`) + `tool_calls` en `pending|approved|awaiting_permission → cancelled` | Ninguna tool en `running` se cancela "hacia atrás": su proceso hijo recibe la señal y termina o vence el timeout; su fila queda en el estado que corresponda cuando el handler retorne |
| Compactación | `messages` (mensaje resumen) + `UPDATE messages SET compacted_by` en los reemplazados + `run_events` (`context.compacted`) | Los mensajes reemplazados nunca se borran; `compacted_by` es la única marca |
| Cada iteración | `runs.iteration += 1`, `runs.last_event_seq` | `last_event_seq` es lo que le permite a un cliente reconectado (o a `chat:history`) pedir "eventos desde X" sin releer todo el log |
| Fin del run | `runs.state = completed|failed|cancelled`, `finished_at`, `metrics_json` + `run_events` (`run.state`) | `metrics_json` se calcula una sola vez al cerrar, agregando todos los `response_metrics_json` de los mensajes del run — no se recalcula en cada iteración |
| Arranque de la app | `run_events` (`run.recovered` con `orphaned`/`abandoned`) + `runs.state = interrupted` para los que no estaban en `awaiting_permission` | Ver algoritmo completo en §12 de la columna vertebral; esta es la única transición que se dispara sin que medie un `run:start`/`permission:answer` del usuario |

**Nota sobre `run:start` a mitad de la primera escritura.** Es el único hueco de la tabla anterior donde, en teoría, `better-sqlite3` podría morir entre el `INSERT INTO runs` y el `COMMIT` de esa misma transacción — pero como es una única transacción SQLite, o se aplica entera o no se aplica nada (atomicidad de SQLite `[VERIFICADO EN DOC OFICIAL: sqlite.org/atomiccommit.html]`); no hay estado intermedio posible a nivel de fila. El caso real a cubrir es que el proceso `main` muera **entre** el commit de `runs(created)` y el primer commit de `preparing`: `recover()` encuentra ese run en `created` (que está en `runs_active`), lo pasa a `interrupted` sin `orphaned`/`abandoned` (no llegó a haber tool calls) y la UI ofrece simplemente "continuar" (nuevo run que retoma el mismo mensaje de usuario).

---

## 7. Consultas típicas

**Cargar un chat completo (`chat:history`).**

```sql
-- Mensajes (orden de aparición en el chat, no por run)
SELECT * FROM messages WHERE chat_id = :chatId ORDER BY seq ASC;

-- Tool calls de todos los runs del chat, con su tool_name y estado
SELECT tc.*
FROM tool_calls tc
JOIN runs r ON r.id = tc.run_id
WHERE r.chat_id = :chatId
ORDER BY tc.run_id, tc.iteration;

-- Checkpoints del chat, más nuevos primero (usa checkpoints_chat)
SELECT * FROM checkpoints WHERE chat_id = :chatId ORDER BY created_at DESC;

-- Tasks vigentes (las del último run que las tocó; TaskManager sobreescribe, no acumula por run)
SELECT * FROM tasks WHERE chat_id = :chatId ORDER BY ord ASC;
```

**Reconstruir un run interrumpido al iniciar (`recover()`).**

```sql
-- 1. Runs que quedaron activos (usa el índice parcial runs_active)
SELECT * FROM runs WHERE state IN
  ('created','preparing','queued','generating','parsing','awaiting_permission',
   'executing_tool','compacting','cancelling');

-- 2. Para cada run que NO está en awaiting_permission: sus tool calls a reclasificar
SELECT * FROM tool_calls
WHERE run_id = :runId AND status = 'running';          -- -> orphaned

SELECT * FROM tool_calls
WHERE run_id = :runId AND status IN ('pending','approved');   -- -> abandoned

-- 3. Diagnóstico por hash de un orphaned de edit_file/write_file/delete_file
SELECT cf.pre_hash, cf.post_hash, cf.rel_path
FROM tool_calls tc
JOIN checkpoints ck ON ck.id = tc.checkpoint_id
JOIN checkpoint_files cf ON cf.checkpoint_id = ck.id
WHERE tc.id = :toolCallId;
-- luego, en la capa de aplicación: hash(archivo actual en disco) se compara contra pre_hash/post_hash
```

**Listar checkpoints de un run (con sus archivos, para la tarjeta "cambió N archivos").**

```sql
SELECT
  ck.id, ck.kind, ck.status, ck.created_at, ck.stats_json,
  cf.rel_path, cf.change, cf.pre_hash, cf.post_hash, cf.blob_missing
FROM checkpoints ck
JOIN checkpoint_files cf ON cf.checkpoint_id = ck.id
WHERE ck.run_id = :runId
ORDER BY ck.created_at ASC, cf.rel_path ASC;
```

**Otras consultas de apoyo mencionadas en la columna vertebral:**

```sql
-- Config efectiva de un run + sus ajustes automáticos (panel "Config efectiva", §19)
SELECT r.effective_config_json, ra.*
FROM runs r
LEFT JOIN run_adjustments ra ON ra.run_id = r.id
WHERE r.id = :runId;

-- Última muestra de carga real de un modelo, para el Centro de modelos
SELECT * FROM model_load_samples
WHERE provider_id = :providerId AND model_name = :modelName
ORDER BY sampled_at DESC LIMIT 1;

-- Compatibilidad probada más reciente para el hardware actual (badge "Probado el DD/MM")
SELECT * FROM model_compat
WHERE model_digest = :digest AND num_ctx = :numCtx AND hardware_fingerprint = :fingerprint
ORDER BY tested_at DESC LIMIT 1;

-- Búsqueda de texto completo en un chat (FTS5)
SELECT m.* FROM messages_fts f
JOIN messages m ON m.rowid = f.rowid
WHERE f.content MATCH :query AND m.chat_id = :chatId
ORDER BY rank;
```

---

## 8. Estrategia de migraciones

**Mecanismo** `[DECISIÓN DE DISEÑO]`. `PRAGMA user_version` es la fuente de verdad de "qué versión de esquema tiene este archivo" — es un entero embebido en la cabecera del propio archivo SQLite, no una fila de una tabla, por lo que sigue siendo legible incluso si `schema_migrations` no existiera todavía (migración 0 → 1) `[VERIFICADO EN DOC OFICIAL: sqlite.org/pragma.html#pragma_user_version]`. Cada migración es un archivo numerado en `packages/runtime/src/persistence/migrations/NNNN_nombre.ts` que exporta `up(db: Database): void`; drizzle-kit genera el SQL a partir de `schema.ts` y el runtime aplica el resultado envuelto en su propia transacción.

**Secuencia al abrir la base:**
1. Abrir el archivo, aplicar los PRAGMAs de conexión (§2).
2. Leer `PRAGMA user_version`.
3. Si es `0` y el archivo está vacío: aplicar la migración 1 completa (crea **todas** las tablas de este documento, incluidas las que quedan vacías hasta v0.2/v0.3, Principio 8 de la columna vertebral) dentro de una transacción, terminar con `PRAGMA user_version = 1` y una fila en `schema_migrations`.
4. Si `user_version < versión_del_código`: aplicar cada migración pendiente, **una por una**, cada una en su propia transacción (`BEGIN IMMEDIATE` → DDL/DML → `INSERT INTO schema_migrations` → `PRAGMA user_version = N` → `COMMIT`). No se agrupan varias migraciones en una sola transacción para poder identificar exactamente cuál falló.
5. Si `user_version > versión_del_código` (el usuario abrió con una versión de SaurioLLM más vieja que la que escribió el archivo): la app **rehúsa** abrir ese proyecto y muestra "esta base de datos es de una versión más nueva de SaurioLLM"; no intenta migrar hacia atrás.

**Si una migración falla a mitad de camino:** la transacción de esa migración hace `ROLLBACK` automático (SQLite revierte todo el DDL/DML de esa migración puntual); `user_version` queda en el valor anterior (la migración fallida nunca llegó a actualizarlo); la app no arranca ese proyecto, muestra el error crudo y ofrece "abrir de todos modos en modo solo lectura" (consulta sin escribir, para que el usuario pueda al menos exportar su historial) y "restaurar backup" (§10). No hay migración automática hacia atrás: revertir un `ALTER TABLE` de SQLite a veces requiere recrear la tabla completa (SQLite tiene soporte limitado de `ALTER TABLE`, sin `DROP COLUMN` con constraints hasta versiones recientes `[VERIFICADO EN DOC OFICIAL: sqlite.org/lang_altertable.html]`), así que el plan de rollback de cada migración se decide caso por caso al escribirla, no de forma genérica.

**`schema_migrations` vs `PRAGMA user_version`.** Son complementarios, no redundantes: `user_version` es lo único que SQLite garantiza leer sin ambigüedad incluso con el esquema corrupto; `schema_migrations` guarda el `checksum` del SQL aplicado y `applied_at`, que sirve para detectar el caso "alguien tocó el archivo de migraciones después de que ya corrió en este `saurio.db`" (mismatch de checksum → advertencia, no bloqueo automático, porque puede ser un cambio de formato/comentarios sin efecto real).

**`saurio db rebuild` no es una migración.** Es una operación de mantenimiento que reconstruye `messages`, `tool_calls`, `tasks`, `runs.state/iteration/metrics_json` desde `run_events` (§4 de la columna vertebral); no cambia el esquema ni `user_version`. Se ofrece como comando de diagnóstico (v0.2, accesible desde Settings) para cuando una proyección quedó inconsistente por un bug, no como parte del arranque normal.

Como `PRAGMA foreign_keys = ON` está activo (§2) y hay FKs cruzadas entre las tablas a reconstruir y `checkpoints` (`tool_calls.checkpoint_id → checkpoints(id)`, `checkpoints.tool_call_id → tool_calls(id)`, `messages.compacted_by → messages(id)`) sin `ON DELETE CASCADE` (Decisión de diseño, §1), borrarlas sin un orden definido falla con `SQLITE_CONSTRAINT`. El procedimiento, dentro de una única transacción `BEGIN IMMEDIATE`:

1. `PRAGMA defer_foreign_keys = ON` (las FKs se verifican recién al `COMMIT`, no fila por fila, lo que permite el orden de abajo sin violaciones intermedias) `[VERIFICADO EN DOC OFICIAL: sqlite.org/pragma.html#pragma_defer_foreign_keys]`.
2. `UPDATE tool_calls SET checkpoint_id = NULL` — desvincula `tool_calls` de `checkpoints` antes de borrar `tool_calls`; `checkpoints`/`checkpoint_files` **no se borran** (no son proyecciones del log, §1).
3. `UPDATE messages SET compacted_by = NULL` — rompe la auto-referencia antes de borrar `messages`.
4. `DELETE FROM tool_calls`, luego `DELETE FROM tasks`, luego `DELETE FROM messages` — en ese orden, porque `checkpoints.tool_call_id` ya quedó en `NULL` por el paso 2 pero `tool_calls` sigue referenciando `messages(id)` hasta que se borra.
5. Reproyectar desde `run_events`, en orden de `seq`, regenerando `messages`, `tool_calls`, `tasks` y `runs.state/iteration/metrics_json` con los mismos `id` (los eventos guardan los ids originales en su `payload_json`).
6. `UPDATE tool_calls SET checkpoint_id = :id` para cada `checkpoint_id` capturado antes del paso 2 — vuelve a vincular cada `checkpoint` existente con la fila de `tool_calls` reproyectada que tiene el mismo `id`.
7. `COMMIT` (dispara la verificación diferida de FKs de una vez).

---

## 9. Retención y limpieza

`[DECISIÓN DE DISEÑO]`, conservador para el MVP:

- **`run_events`, `messages`, `tool_calls`, `checkpoints`, `permission_*`, `model_compat`, `benchmark_runs`:** sin borrado automático. Son el historial que la condición 8 pide conservar entre reinicios, y `run_events` es además la fuente de la que se puede reconstruir todo lo demás — borrar de ahí rompe esa garantía. La única limpieza manual es "eliminar chat" desde la UI (v0.2), que borra en cascada explícita (no `ON DELETE CASCADE` de SQLite) `messages`, `tool_calls`, `checkpoints`/`checkpoint_files` de ese chat y decrementa `blobs.refcount`, purgando blobs que lleguen a `refcount = 0`.
- **`tool-outputs/<id>.txt` y `appData/blobs/<hash>`:** viven fuera de SQLite; no tienen expiración en el MVP. Un job de limpieza (v0.2) puede purgar `tool-outputs` de runs con más de N días **y** `finished_at` no nulo (nunca de un run activo).
- **`metrics_minute`:** única tabla con retención explícita desde el diseño, **30 días** con un job diario (`DELETE FROM metrics_minute WHERE ts_minute < :hace30dias`), tal como fija la condición 11.B; en el MVP esta tabla ni siquiera se llena (el `SystemSampler` continuo es v0.2), así que la retención se activa junto con el sampler.
- **`downloads`:** filas en estado terminal (`done`, `failed`, `cancelled`) más viejas de 30 días se pueden purgar (v0.2); no afecta al modelo ya instalado, que vive en `models`.
- **`audit_log`:** sin retención automática en el MVP (volumen bajo: cambios de settings, decisiones de localidad no local); se revisa si crece más de lo esperado una vez que existan providers cloud (v0.4).
- **`repo_map_cache`:** se sobreescribe por `mtime`/`size`, no crece indefinidamente salvo que se borren archivos del proyecto sin que el indexer lo note; un `VACUUM`-friendly `DELETE` por proyecto al cerrarlo definitivamente ("olvidar proyecto") es v0.2.
- **`VACUUM`:** no se ejecuta automáticamente (bloquea el archivo entero y puede tardar con WAL activo `[VERIFICADO EN DOC OFICIAL: sqlite.org/lang_vacuum.html]`); se ofrece como acción manual en Settings → Mantenimiento junto con el tamaño actual del archivo.

---

## 10. Tamaño esperado `[HIPÓTESIS A PROBAR]`

Estimación gruesa para el uso de un desarrollador solo, a validar una vez que exista telemetría real de uso (`v_chat_stats`, tamaño de archivo por semana):

| Fuente | Estimación por unidad | Supuesto |
|---|---|---|
| `run_events.payload_json` | 200–600 bytes por evento | JSON compacto, sin pretty-print |
| Eventos por run típico | 30–150 | Depende de iteraciones y tool calls; un run de 10 iteraciones con 1 tool cada una ronda 80–120 eventos |
| `messages.content` | 200–3.000 caracteres por mensaje | Mensajes de usuario cortos, respuestas del asistente más largas; el repo map y el resumen de compactación pueden llegar a varios miles |
| `checkpoint_files` + `blobs` | Tamaño real de los archivos tocados × 2 (pre + post) | Sin deduplicación entre ediciones distintas de un mismo archivo si el contenido intermedio difiere siempre |
| `tool-outputs/*.txt` | Solo para resultados > 30.000 caracteres | Poco frecuente fuera de `run_command` con salidas largas (instalaciones, tests) |

Con esos supuestos, una sesión de trabajo de una tarde (5–10 runs de agent, decenas de ediciones chicas) ronda **1–5 MB** de `saurio.db` más los blobs de los archivos tocados (que en un proyecto de código típico son órdenes de magnitud más chicos que binarios); un uso sostenido de varios meses sin limpieza podría llegar a **cientos de MB**, dominado por `blobs/` si el usuario edita archivos grandes repetidamente, no por las tablas relacionales. Esto es una proyección, no una medición: se valida instrumentando `pragma page_count * pragma page_size` semanalmente una vez que el MVP esté en uso real.

---

## 11. Backup

`[DECISIÓN DE DISEÑO]`, sin implementación en el MVP más allá de lo mínimo:

- **MVP:** al iniciar cada migración (§8), copiar `saurio.db` (y, si existen, `saurio.db-wal`/`saurio.db-shm`) a `appData/backups/pre-migration-<version>-<timestamp>.db` **después** de un `PRAGMA wal_checkpoint(TRUNCATE)` (fuerza a que todo el contenido esté en el archivo principal, no repartido en el WAL, antes de copiar) `[VERIFICADO EN DOC OFICIAL: sqlite.org/pragma.html#pragma_wal_checkpoint]`. Es la única copia automática del MVP y su único propósito es poder volver atrás si una migración deja el esquema en un estado peor que antes de abrir esa versión de la app.
- **v0.2:** backup periódico (diario, al cerrar la app o con un timer) usando `VACUUM INTO 'ruta'`, que produce una copia compacta y consistente en una sola sentencia sin bloquear escrituras largas `[VERIFICADO EN DOC OFICIAL: sqlite.org/lang_vacuum.html#vacuuminto]`; se guardan las últimas N copias con rotación simple (borrar la más vieja al crear una nueva).
- **Qué el backup NO cubre:** `appData/blobs` y `appData/tool-outputs` no se incluyen en el backup automático del MVP (pueden pesar mucho más que la base); v0.2 evalúa si el backup debe ser "solo metadatos" (restaura el chat pero los diffs de checkpoints viejos aparecen con `blob_missing`) o un backup completo del directorio `appData` con `robocopy`/`tar`, más caro pero íntegro.
- **Restauración:** manual desde Settings → Mantenimiento en el MVP (el usuario elige un archivo de `appData/backups/` y la app hace `cp` sobre `saurio.db` estando cerrada la conexión activa); no hay UI de "restaurar automáticamente" para no ocultar una pérdida de datos sin confirmación explícita.

---

## 12. Imprescindible para el MVP / Previsto para más adelante

**Imprescindible para el MVP** (tablas creadas y con lectura/escritura real desde el primer hito): `projects`, `agents` (agente built-in único), `chats`, `runs`, `run_events`, `messages` + `messages_fts`, `tool_calls`, `permission_rules`, `permission_decisions`, `checkpoints`, `checkpoint_files`, `blobs`, `tasks`, `providers` (solo Ollama attach), `models`, `model_load_samples`, `token_calibration`, `settings`, `audit_log`, `schema_migrations`. `run_adjustments` se usa desde el MVP aunque solo para un único tipo de ajuste (capear `num_ctx`, ADR-7). `project_memory` y `repo_map_cache` se usan desde el MVP en modo lectura de `SAURIO.md`/cache del indexer.

**Creadas en la migración 1 pero vacías hasta versiones posteriores** (Principio 8, excepción explícita): `runs.parent_run_id` (v0.4), `model_compat` y `benchmark_runs` (v0.3, escritas solo por `Benchmark`), `downloads` (v0.2, `DownloadManager`), `profiles` con filas reales más allá de las 3 built-in estáticas (v0.2), `metrics_minute` (v0.2, `SystemSampler` continuo — en el MVP las métricas viven únicamente en `messages.response_metrics_json`/`runs.metrics_json`, sin agregación por minuto).

---

## 13. Nomenclatura agregada

No agregamos tablas de dominio nuevas fuera de las que ya nombra la columna vertebral, salvo `schema_migrations`. Identificadores nuevos derivados con el mismo estilo de la columna vertebral:

- **`schema_migrations`** (tabla): `version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at INTEGER`. Complementa `PRAGMA user_version` (§8).
- **`checkpoints_run`**, **`checkpoints_chat`** (índices): faltaban en el DDL de la columna vertebral y son necesarios para las consultas típicas del brief ("listar checkpoints de un run/chat").
- **`tasks_chat`** (índice): `tasks(chat_id, ord)`, necesario para renderizar el checklist en el orden que fija `ord`.
- **`permission_rules_scope`** (índice): `permission_rules(scope, project_id, tool_name)`, para la evaluación deny→ask→allow que hace `PermissionEngine` en cada tool call.
- **`model_compat_lookup`**, **`model_load_samples_model`**, **`downloads_status`**, **`tool_calls_args_hash`**, **`agents_project`**, **`runs_parent`**, **`audit_log_kind`** (índices): soportan las consultas descritas en §7 y §9 que no tenían un índice explícito en la columna vertebral.
- **`settings_global`**, **`settings_project`** (índices únicos parciales): reemplazan la PK simple de `settings` para garantizar unicidad real por `key` tanto en la rama global como en la rama por proyecto (ver Desvíos, punto 4).

---

## 14. Desvíos respecto de la columna vertebral

1. **`CHECK` explícitos en columnas enum.** El DDL de la §4 de la columna vertebral no incluye `CHECK` para `state`, `status`, `category`, `risk`, `mode`, `locality`, etc., aunque esos valores sí están fijados como fuente única en los `zod.enum` de la §5. Los agregamos en todo este documento porque el propio brief de este documento los pide ("con tipos, PK, FK, NOT NULL, CHECK") y porque sin ellos el esquema SQLite no hace cumplir la invariante de nomenclatura única que la columna vertebral declara como obligatoria. No cambia ningún nombre ni valor, solo los hace explícitos y verificables por la base.
2. **`messages.seq` vs `run_events.seq`.** La columna vertebral usa el nombre `seq` en ambas tablas. Aclaramos que son contadores independientes con semántica distinta (uno global por toda la base, para `run_events`; uno por `chat_id`, para `messages`), porque un chat abarca varios `runs` sucesivos y necesita un orden total propio que no coincide con la numeración global del log. Sin esta aclaración, una implementación ingenua podría intentar reusar `run_events.seq` como `messages.seq`, lo cual rompería la unicidad por chat en cuanto hubiera dos runs en el mismo chat.
3. **`checkpoint_files.pre_hash`/`post_hash` sin `REFERENCES blobs(hash)`.** No es un cambio de la columna vertebral (que tampoco declara esa FK), pero lo documentamos explícitamente para que nadie la agregue "por prolijidad" durante el scaffolding: archivos `created`/`deleted` tienen uno de los dos hashes en `NULL`, y archivos > 20 MB tienen `blob_missing = 1` sin fila en `blobs`; una FK `NOT NULL` rompería ambos casos previstos por el propio diseño.
4. **`settings` sin PK simple, con índices únicos parciales por rama de `scope`.** La columna vertebral declara `settings(key TEXT PRIMARY KEY, value_json, scope, project_id)`, lo que impide que la misma `key` tenga un valor global **y** un override por proyecto simultáneamente (la fila global se pisaría). Una PK compuesta `(key, scope, project_id)` no alcanza porque SQLite trata cada `NULL` de `project_id` como distinto en una PK/UNIQUE, así que la fila global (`project_id = NULL`) no queda protegida contra duplicados. Se reemplaza la PK por dos índices únicos parciales — `settings_global` (`key` únicos donde `project_id IS NULL`) y `settings_project` (`key, project_id` únicos donde `project_id IS NOT NULL`) — consistente con que la propia columna vertebral describe overrides por proyecto (`settings.toolTransportOverrides`, `settings:get`/`settings:set` con `projectId` opcional en la §5). Es la corrección mínima necesaria para que el propio contrato IPC de la columna vertebral (que sí distingue `projectId`) tenga dónde guardar ambos valores sin colisión ni duplicados.

5. **Columnas y valor de enum usados por otros documentos pero ausentes del DDL de la migración 1.** Los docs 06, 10 y 15 introducen elementos que, de no agregarse desde la migración 1, forzarían un `ALTER TABLE` el día que se implementen — justo lo que el Principio 8 de la columna vertebral quiere evitar. Se agregan aquí: (a) `'delegate'` al `CHECK` de `tool_calls.category` (doc 06 §2/§12 lo usa para tool calls de delegación entre agentes, v0.4); (b) `chats.override_json TEXT` (doc 15 §7/§12, ver justificación de §4.1); (c) `profiles.is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1))` (doc 15 §12). Quedan **fuera del alcance de este documento**, por pertenecer al DDL de tipos TypeScript y no al esquema SQLite: `RunError.code = 'db_write_failed'` (union en doc 04 §5) y `PermissionRequest.noAllowOption` / `PermissionRule.critical` (interfaces en doc 04 §7) — no tienen columna SQL asociada, se aplican en doc 04.

Ninguno de estos desvíos cambia una decisión de arquitectura de la columna vertebral (capas, ADRs, roadmap); son precisiones de tipado y de índices dentro de la sección 4, que el propio documento delega a "los documentos detallados posteriores" (frase inicial de la columna vertebral).

---

## Preguntas abiertas

Ninguna de las precisiones anteriores cambia el diseño ni reabre una decisión de la columna vertebral; no se agregan preguntas nuevas a las seis ya planteadas en su §20.
