# Documento 19 — Agentes personales, equipos y delegación: diseño implementable

**Propósito.** Diseño construible en una pasada para cuatro entregas chicas (E2a, E3a, E3b, E4a) que cubren R03-R08 y R10 de `Investigacion_App_IA_Local.md`, sin reescribir el core validado (`RunController`, `Scheduler`/`ModelGateway`, `PermissionEngine`, checkpoints). Parte del diagnóstico de doc 17: hoy no existe `AgentDefinition`, `Team` ni motor de proactividad; solo hay placeholders reservados (`runs.parent_run_id`, `tool_calls.category='delegate'`, `ToolDefinition.source.kind='delegate'`, prioridad `'subagent'` en el Scheduler) sin ningún productor real. Este documento decide, contra la advertencia explícita de doc 17 §4 ("no reutilizar el esquema `agents` actual sin revisarlo"), **extender la tabla `agents` existente en vez de crear una entidad paralela** — la justificación va en §0.

**Leyenda:** `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]` — se reutiliza la de los docs 00-18. Todas las migraciones son **aditivas** (`ADD COLUMN` o `CREATE TABLE`); ninguna reconstruye una tabla existente, así que no hay riesgo de romper filas ya persistidas.

---

## 0. Decisión de fondo: extender `agents`, no duplicarlo

`AgentConfig` (`packages/runtime/src/agent/types.ts:21-31`) ya tiene el 90% de lo que "Mis agentes" necesita: nombre, rol, modelo, `systemPrompt`, `allowedTools`, `permissions`, `memory`, `workingDir`. Lo que falta es identidad de usuario (avatar, descripción, si es persistente o desechable) y alcance de memoria con procedencia. Crear una entidad nueva (`AgentDefinition`) obligaría a mantener dos resolutores de modelo/tools/permisos en paralelo (`AgentConfigResolver` para runs y otro para la vitrina de "Mis agentes"), duplicando exactamente la lógica que `RunController` ya prueba.

**[DECISIÓN DE DISEÑO]** Extender `agents` con una columna discriminadora `owner_kind` (`'builtin' | 'personal' | 'worker' | 'coordinator'`) en vez de crear `agent_definitions`. Beneficio: `AgentConfigResolver`, `RunController` y la migración 0001 no se tocan; un agente personal ES un `AgentConfig` válido desde el día uno. Costo: la tabla mezcla conceptualmente "configuración de ejecución" (builtin) con "identidad" (personal), lo que doc 17 señalaba como riesgo — se mitiga filtrando siempre por `owner_kind` en cada query nueva y nunca exponiendo `owner_kind='worker'`/`'coordinator'` en la UI de "Mis agentes". Los "subagentes de delegación" de v0.4 (`parent_run_id`) y los *workers temporales* de esta entrega son la misma mecánica de ejecución pero con ciclo de vida de persistencia distinto — un worker SÍ necesita una fila en `agents` (FK obligatoria de `runs.agent_id`), pero se filtra de toda lista visible y no cuenta como "agente creado" para R03/T07.

**[DECISIÓN DE DISEÑO]** No agregar chats sin proyecto. En vez de relajar `chats.project_id NOT NULL` (exigiría reconstruir la tabla), se crea un **proyecto personal sintético** (`PERSONAL_PROJECT_ID` fijo, oculto del selector de proyectos) al primer arranque. Un chat directo con un agente personal fuera de cualquier proyecto abierto vive ahí. Beneficio: cero cambios de esquema en `chats`/`projects`; toda la UI de chat existente (lista, historial, checkpoints) funciona sin ramas nuevas. Costo: un proyecto "fantasma" en la base que hay que excluir explícitamente de `project:list` y de cualquier selector visible.

---

## 1. Entrega E2a — "Mis agentes"

### 1.1 Migración `0004_agent_profiles.ts`

```sql
ALTER TABLE agents ADD COLUMN owner_kind    TEXT NOT NULL DEFAULT 'builtin';
ALTER TABLE agents ADD COLUMN avatar_emoji  TEXT;
ALTER TABLE agents ADD COLUMN avatar_color  TEXT;
ALTER TABLE agents ADD COLUMN description   TEXT;
ALTER TABLE agents ADD COLUMN model_mode    TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE agents ADD COLUMN created_at    INTEGER;
ALTER TABLE agents ADD COLUMN archived_at   INTEGER;
UPDATE agents SET created_at = updated_at WHERE created_at IS NULL;

CREATE TABLE agent_memories (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  project_id   TEXT REFERENCES projects(id),   -- NULL = memoria global del agente
  content      TEXT NOT NULL,
  source_kind  TEXT NOT NULL CHECK (source_kind IN ('user_stated','inferred','file_derived')),
  confidence   TEXT NOT NULL CHECK (confidence IN ('confirmed','hypothesis')),
  origin_ref   TEXT,                            -- run_id o ruta de archivo que lo originó
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  invalidated_at INTEGER
);
CREATE INDEX agent_memories_scope ON agent_memories(agent_id, project_id);
```

**[DECISIÓN DE DISEÑO]** No se agrega `CHECK` sobre `owner_kind`/`model_mode` en `agents` (columna nueva, no reconstruye tabla): la migración 0002 mostró que ensanchar un `CHECK` existente exige reconstrucción completa; para evitar pagar ese costo en la próxima entrega, estas dos columnas se validan solo en la capa zod (`packages/shared/src`), igual que ya ocurre con otras columnas TEXT de `agents` que no tienen `CHECK` en el drizzle schema.

### 1.2 Tipos y schemas (`packages/shared/src`)

`enums.ts`: agregar `AgentOwnerKind`, `ModelMode = z.enum(['fixed','auto'])`, `MemorySourceKind`, `MemoryConfidence`.

`domain.ts`: `AgentProfileSchema` (extiende el `AgentConfigSchema` existente con `ownerKind, avatarEmoji, avatarColor, description, modelMode, createdAt, archivedAt`); `AgentMemorySchema`; `AgentCreateInputSchema` (name, description?, role, modelMode, model?, allowedTools, permissionPreset, memoryScope: `'global' | 'project'`, projectId? — sin plantilla obligatoria: todos los campos salvo `name` tienen default sensato, satisface "sin que sea requisito para usar la app").

### 1.3 Eventos

Ninguno nuevo en `RunEventSchema` (crear/editar un agente no es un evento de run). Se agrega un evento de aplicación fuera de esa unión, en el canal de eventos IPC (no en `runtime:event`): `'agent:changed': { agentId: string; kind: 'created'|'updated'|'archived' }`.

### 1.4 Canales IPC nuevos (`packages/shared/src/ipc.ts`, mismo patrón `{input, output}` zod)

```
'agents:list':          { input: { projectId?: string; includeArchived?: boolean }, output: AgentProfileSchema[] }
'agents:create':        { input: AgentCreateInputSchema,                             output: AgentProfileSchema }
'agents:update':        { input: { id, patch: Partial<AgentCreateInputSchema> },      output: AgentProfileSchema }
'agents:archive':       { input: { id },                                             output: void }
'agents:duplicate':     { input: { id, name? },                                      output: AgentProfileSchema }
'agent-memory:list':    { input: { agentId, projectId? },                            output: AgentMemorySchema[] }
'agent-memory:upsert':  { input: AgentMemorySchema.partial(),                         output: AgentMemorySchema }
'agent-memory:delete':  { input: { id },                                             output: void }
```
Evento: `'agent:changed'` agregado al mapa de eventos junto a `models:changed`.

### 1.5 Runtime — archivos y funciones concretas

- `packages/runtime/src/persistence/repositories/agent.ts`: agregar a `AgentRepository` los métodos `list(filter: {projectId?, ownerKind?, includeArchived?})`, `archive(id)`, `duplicate(id, name?)`; `list` **siempre** filtra `owner_kind IN ('personal')` cuando lo llama la UI de "Mis agentes" (nunca expone `'worker'`/`'coordinator'`).
- `packages/runtime/src/persistence/repositories/agentMemory.ts` (nuevo): `AgentMemoryRepository { list(agentId, projectId), upsert(row), delete(id) }`; `list` ejecuta `WHERE agent_id = ? AND (project_id = ? OR project_id IS NULL)` — esta única cláusula es el mecanismo de privacidad de T09 (§1.7).
- `packages/runtime/src/agent/defaults.ts`: agregar `createPersonalAgentDefaults(input: AgentCreateInput): AgentConfig` (id `agent_personal_<uuid>`, hereda `DEFAULT_ALLOWED_TOOLS` menos `delegate`, que se habilita aparte).
- `packages/runtime/src/agent/modelPolicy.ts` (nuevo): `resolveModelRef(agent: AgentProfile, gatewayStatus): ModelRef`. Si `model_mode==='fixed'`, comportamiento actual sin cambios (`chat.modelRef ?? agent.model`). Si `'auto'`: **[HIPÓTESIS A PROBAR]** heurística mínima — preferir el modelo ya cargado según `ModelGateway.status()`/`ModelManager.listLoaded()` si cabe en el `numCtx` pedido (`MemoryEstimator.fits()`), si no, caer al modelo builtin (`qwen3:8b`). No hay selección "inteligente" por tarea todavía; medir antes de sofisticar. Se invoca desde `RunController.start()` en el punto donde hoy se resuelve `chat.modelRef ?? resolvedAgent.model` (RunController.ts ~162-165), como paso intermedio.
- `packages/runtime/src/agent/personalProject.ts` (nuevo): `PERSONAL_PROJECT_ID`, `ensurePersonalProject(projects: ProjectRepository)`, llamado una vez desde `apps/desktop/src/main/host/createRuntime.ts` en el boot.
- `packages/runtime/src/context/*` (el ensamblador de contexto de doc 07, no explorado en detalle en esta tarea — se referencia por nombre): agregar un paso que llama `agentMemoryRepository.list(agentId, projectId)` e inyecta cada fila con su procedencia visible en el prompt (`[memoria confirmada, 2026-08-01, origen: usuario] ...` vs `[hipótesis, origen: archivo x.ts]`), nunca como hecho plano.
- `apps/desktop/src/main/ipc/agents.ts` (nuevo, mismo patrón que el handler de `providers:*` ya existente): expone los 7 canales de §1.4 contra los repositorios de arriba.

### 1.6 Renderer

- `apps/desktop/src/renderer/src/stores/agentsStore.ts` (nuevo, Zustand): `personalAgents`, `load()`, `create()`, `update()`, `archive()`, `duplicate()`.
- `features/agents/AgentsPanel.tsx` (nuevo): lista con avatar/nombre/rol, botón "+ Nuevo agente".
- `features/agents/AgentEditorModal.tsx` (nuevo): nombre, emoji+color, rol (`AgentRole` existente), modelo fijo (selector actual de `providersStore`) o "automático", checklist de herramientas (reusa el registro de tools builtin), preset de permisos (`strict/balanced/trusting`, reusa el selector que ya existe en Ajustes), alcance de memoria (`global` vs "solo este proyecto"). Ningún campo es obligatorio salvo `name` — sin plantilla, cumple R01/E2a explícitamente.
- `Sidebar.tsx`: nueva sección colapsable "Mis agentes" debajo de "Chats"; click en un agente llama `chatStore.createChat({ projectId: currentProjectId ?? PERSONAL_PROJECT_ID, agentId })` reusando el flujo de creación de chat ya existente.
- `features/chat/ChatHeader.tsx`: cuando `chat.agentId` no es el builtin, mostrar nombre+avatar del agente junto al selector de modelo — es el requisito explícito de R04 ("identidad y alcance visibles").

### 1.7 Privacidad de memoria (T09)

El filtro vive en un solo lugar (`AgentMemoryRepository.list`, §1.5) y se aplica también al ensamblador de contexto: un agente personal usado en el proyecto B nunca recibe filas con `project_id` distinto de B (solo las globales, `project_id IS NULL`). **[HIPÓTESIS A PROBAR]** esto garantiza que el *recuperador* no exponga contenido ajeno, pero no impide que el modelo de 8B "recuerde" algo por el propio texto de la conversación si el usuario lo pegó ahí — eso es un límite del LLM, no del sistema de memoria, y se documenta como tal en vez de prometer una garantía que el runtime no puede dar.

### 1.8 Pruebas de aceptación → tests

| Prueba | Test automático | Paso de harness real (qwen3:8b) |
|---|---|---|
| T03 Identidades propias | Unit: dos `saurio.db` en directorios distintos (dos "instalaciones"), crear agente en una, `agents:list` en la otra devuelve solo el builtin | — |
| T04 Chat directo | Integración: crear agente, `chat:create` con su `agentId`, `chat:history` refleja `agentId`; render test: `ChatHeader` muestra nombre/avatar | Abrir chat con un agente personal y pedirle que se identifique; la respuesta usa el `systemPrompt` configurado |
| T09 Contexto privado | Unit: `agentMemoryRepository.list(agentId, 'proj-B')` con una fila `project_id='proj-A'` devuelve `[]` | Guardar una memoria en proyecto A ("mi apodo es X"), abrir el mismo agente en proyecto B, preguntar el apodo — no debe aparecer en el prompt ensamblado (verificar con log de contexto, no solo con la respuesta del modelo) |

---

## 2. Entrega E3a — Delegación desde el chat principal

### 2.1 Migración `0005_delegation.ts`

```sql
ALTER TABLE runs  ADD COLUMN delegation_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN origin_run_id    TEXT REFERENCES runs(id);
```
No hace falta tocar `tool_calls.category` (ya admite `'delegate'` desde la migración 1) ni `runs.parent_run_id` (ya existe) — es la reutilización literal que doc 17 dejó preparada.

### 2.2 Tipos y schemas

`domain.ts`: `DelegationRequestSchema { targetAgentId?: string; role?: AgentRole; task: string; expectedDeliverable: string; budget?: { maxIterations?: number; timeoutMs?: number } }` (esquema deliberadamente chico — mitigación central contra la falta de fiabilidad de 8B, ver §5). `DelegationResultSchema { status: 'completed'|'failed'|'needs_input'; summary: string; artifacts?: {path:string; description:string}[]; uncertainties?: string[]; nextAction?: string }` — traduce literal el protocolo de entrega de la investigación (§08).

### 2.3 Eventos

Agregar a `RunEventSchema`: `{ type: 'run.delegated'; runId; chatId; ts; parentRunId; childRunId; targetAgentId: string; task: string }`. Es aditivo (una variante más del discriminated union); no rompe consumidores existentes de `runStore.applyEvents`.

### 2.4 Canales IPC

Ninguno nuevo: la delegación se dispara como una tool call dentro de un run existente (`run:start` ya cubierto). Se extiende el **output** de `run:cancel`/eventos existentes para que la UI pueda pedir `checkpoint:list`/`chat:history` del `childChatId` cuando el usuario quiera "ver la conversación completa" — reutiliza canales ya existentes, sin agregar superficie IPC nueva.

### 2.5 Runtime

- `packages/runtime/src/tools/builtin/delegate.ts` (nuevo): `ToolDefinition` con `source: {kind:'delegate'}` y el `DelegationRequestSchema` como input. **No** se agrega a `DEFAULT_ALLOWED_TOOLS` del builtin — solo un agente que la tenga explícitamente en su `allowedTools` puede delegar (mitigación "delegación solo por tool explícita").
- `RunController.ts`, nuevo método privado `runDelegateTool(call, live)`, llamado desde el switch de dispatch de tools que ya existe:
  1. Si `run.delegationDepth >= 1` → `ToolResult` de error ("profundidad máxima de delegación alcanzada"), no excepción — el run padre sigue vivo y puede reaccionar.
  2. Si ya hay ≥3 `tool_calls.category='delegate'` para este `run_id` → mismo tipo de error ("límite de delegaciones por run").
  3. Resuelve destino: agente personal existente por `targetAgentId`, o crea uno efímero (`owner_kind='worker'`, `createPersonalAgentDefaults` con `role` pedido) — persistido (la FK de `runs.agent_id` lo exige) pero filtrado de toda lista visible.
  4. Crea chat hijo (`origin_run_id = parentRunId`, mismo `project_id` del padre) y run hijo (`parent_run_id`, `delegation_depth = padre+1`).
  5. Llama `this.start(childChatId, task, defaultMode)` y espera a que termine (el loop de tools ya es síncrono dentro de una iteración; no se introduce concurrencia nueva).
  6. Intenta parsear el último mensaje del hijo como `DelegationResultSchema` (reusa el parser de `TextToolProtocol` ya construido para tool-calling en texto); si no valida, envuelve el texto crudo como `{status:'completed', summary: <texto>, uncertainties:['formato no estructurado']}` — nunca falla la delegación completa por un formato imperfecto de un modelo de 8B.
  7. Emite `run.delegated` y devuelve el JSON de `DelegationResultSchema` como contenido del `ToolResult` (categoría `'delegate'` en `tool_calls`, ya soportada).
- Una línea de una-sola-línea real: en la llamada a `this.deps.gateway.chat(ref, req, { runId, signal, authorizedLocality, priority: 'interactive' })` (RunController.ts ~650), cambiar a `priority: run.parentRunId ? 'subagent' : 'interactive'`. Esto activa el orden de prioridades que el Scheduler ya implementa (`PRIORITY_ORDER`) pero que hoy es código muerto — sin tocar `Scheduler.ts` ni `ModelGateway.ts`.

Con 1 slot de inferencia medido en el equipo del usuario, padre e hijo **ya están serializados por construcción** (no hay dos inferencias simultáneas posibles); el cambio de prioridad importa para cuando haya más slots (v0.4) o varias delegaciones encoladas.

### 2.6 Renderer

- `runStore.ts`: manejar `run.delegated` → `childRunsByParent: Record<string,string[]>`.
- `features/chat/DelegationCard.tsx` (nuevo): se renderiza donde ocurrió el `tool_call` de categoría `delegate`; muestra agente destino (o "worker temporal"), tarea, preset de permisos usado, y — cuando el run hijo termina — el resumen estructurado con un enlace "ver conversación completa" que abre el `childChatId`.

### 2.7 Pruebas de aceptación

| Prueba | Test automático | Harness qwen3:8b |
|---|---|---|
| T06 Delegación controlada | Integración: run con tool `delegate` hacia un agente existente crea fila en `runs` con `parent_run_id` correcto y `tool_calls.category='delegate'`; UI snapshot de `DelegationCard` | Pedir en el chat principal "delegale la revisión del módulo X a mi agente revisor"; verificar que el modelo emite la tool call con `targetAgentId` correcto (no inventa un id) |
| T07 Worker temporal | Unit: delegar sin `targetAgentId` crea fila `agents` con `owner_kind='worker'`; `agents:list` (filtro personal) no la incluye | Repetir la misma subtarea dos veces y confirmar que no aparecen "agentes nuevos" en Mis Agentes |
| T10 Recursos compartidos | `Scheduler.status()` nunca reporta más de 1 slot ocupado durante una delegación | — |

---

## 3. Entrega E3b — Equipos

### 3.1 Migración `0006_teams.ts`

```sql
CREATE TABLE teams (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT REFERENCES projects(id),
  name                  TEXT NOT NULL,
  description           TEXT,
  coordinator_agent_id  TEXT NOT NULL REFERENCES agents(id),
  default_agent_id      TEXT REFERENCES agents(id),
  created_at            INTEGER NOT NULL,
  archived_at           INTEGER
);
CREATE TABLE team_members (
  team_id   TEXT NOT NULL REFERENCES teams(id),
  agent_id  TEXT NOT NULL REFERENCES agents(id),
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, agent_id)
);
ALTER TABLE chats    ADD COLUMN team_id  TEXT REFERENCES teams(id);
ALTER TABLE messages ADD COLUMN agent_id TEXT REFERENCES agents(id);
```
`messages.agent_id` (nullable, `NULL` = usar `chats.agent_id`) es lo que permite que un chat grupal muestre qué integrante habló en cada turno sin tocar el resto del pipeline de mensajes.

**[DECISIÓN DE DISEÑO]** Un equipo se asigna a **un** proyecto a la vez (`teams.project_id`), no a varios — evita una tabla puente adicional en esta entrega; ampliar a N proyectos queda fuera (§6) y es aditivo si hiciera falta después.

### 3.2 Tipos, eventos, IPC

`domain.ts`: `TeamSchema`, `TeamMemberSchema`. Evento de aplicación `'team:changed'`. Canales IPC: `teams:list`, `teams:create`, `teams:update`, `teams:archive`, `teams:addMember`, `teams:removeMember`, `teams:assignProject` — mismo patrón `{input,output}` zod que el resto.

`RunEventSchema`: agregar `{ type: 'team.turnAssigned'; runId; chatId; ts; teamId; speakerAgentId; reason: 'mention'|'default'|'ambiguous' }` para que la UI muestre por qué habló ese agente sin inferirlo del lado del cliente.

### 3.3 Runtime

- `packages/runtime/src/team/coordinator.ts` (nuevo, sin dependencias de LLM): `resolveSpeaker(members: {agentId,name}[], userMessage: string, defaultAgentId: string): { agentId: string; reason: 'mention'|'default'|'ambiguous' }`. Parser de `@nombre` (case-insensitive, contra los nombres de `team_members`); un solo match → ese agente; cero matches → `defaultAgentId`; dos o más matches distintos → `reason:'ambiguous'`, y el runtime devuelve un mensaje de sistema pidiendo que se aclare a quién, **sin gastar una inferencia**. Esta función es 100% determinista — es la mitigación central contra la falta de fiabilidad de un coordinador basado en 8B (ver §5).
- `packages/runtime/src/persistence/repositories/team.ts` (nuevo): CRUD de `teams`/`team_members`.
- `RunController.start()`: agregar parámetro opcional `agentIdOverride?: string`. Cuando está presente, el `AgentConfig` efectivo del run es el del override (no el de `chats.agent_id`, que para un chat de equipo apunta al `coordinator_agent_id`, una fila `owner_kind='coordinator'` casi vacía que solo existe para satisfizar la FK); al persistir el mensaje de la respuesta, `messages.agent_id = agentIdOverride`.
- `apps/desktop/src/main/ipc/run.ts` (handler existente de `run:start`): si `chat.teamId != null`, llama primero a `coordinator.resolveSpeaker(...)`; si `reason==='ambiguous'`, responde sin invocar `RunController.start`; si no, pasa `agentIdOverride` al controller.
- Un chat de equipo sigue teniendo **un run activo a la vez** (la regla `RunController.start()` de "un chat = un run" no cambia) — cumple literalmente el criterio de salida de E3 en doc de investigación: "la ejecución secuencial ya satisface esta etapa; el paralelismo se habilita solo después de medirlo."

### 3.4 Renderer

- `stores/teamsStore.ts` (nuevo).
- `features/agents/TeamsPanel.tsx` (nuevo, sub-pestaña de "Mis agentes"): crear equipo, agregar/quitar miembros (multi-select sobre agentes personales), asignar a proyecto.
- `ChatHeader.tsx`: para chats de equipo, tira horizontal de avatares de los miembros con un punto de estado (esperando / hablando) alimentado por `runStore` + evento `team.turnAssigned`.
- Componente de burbuja de mensaje existente: leer `message.agentId` (fallback a `chat.agentId`) para mostrar nombre/avatar correctos por turno — cumple R05/T05 ("sin abrir una ventana por integrante").

### 3.5 Pruebas de aceptación

| Prueba | Test automático | Harness qwen3:8b |
|---|---|---|
| T05 Grupo asignado | Integración: crear equipo con 2 agentes, asignar a proyecto, un solo `chatId`; dos mensajes de usuario con `@nombre` distinto producen `messages.agent_id` distintos | Conversación real de dos turnos mencionando a cada integrante; confirmar que cada respuesta usa el `systemPrompt` del agente correcto |
| T08 Modos independientes | Unit: agente A `model_mode='auto'`+`collaboration_mode='manual'`, agente B `model_mode='fixed'`+`collaboration_mode='auto'`, ambos persisten y se leen sin interferencia cruzada | — |

---

## 4. Entrega E4a — Automatización y proactividad acotada

### 4.1 Migración `0007_automation.ts`

```sql
ALTER TABLE agents ADD COLUMN collaboration_mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE agents ADD COLUMN proactivity_mode   TEXT NOT NULL DEFAULT 'off';

CREATE TABLE reminders (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  project_id    TEXT REFERENCES projects(id),
  kind          TEXT NOT NULL CHECK (kind IN ('cron','once','file_watch')),
  schedule      TEXT,               -- expresión cron o ISO datetime, según kind
  watch_path    TEXT,               -- solo kind='file_watch'
  description   TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_fired_at INTEGER,
  next_fire_at  INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('info','result','decision','failure')),
  title       TEXT NOT NULL,
  body        TEXT,
  project_id  TEXT REFERENCES projects(id),
  agent_id    TEXT REFERENCES agents(id),
  run_id      TEXT REFERENCES runs(id),
  dedup_key   TEXT,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);
CREATE INDEX notifications_dedup   ON notifications(dedup_key);
CREATE INDEX notifications_project ON notifications(project_id, created_at DESC);
```

### 4.2 Tipos, eventos, IPC

`enums.ts`: `CollaborationMode = z.enum(['manual','suggest','auto'])`, `ProactivityMode = z.enum(['off','suggest','act'])`. `domain.ts`: `ReminderSchema`, `NotificationSchema`.

Canales: `reminders:list/create/update/delete`, `notifications:list`, `notifications:markRead`. Eventos: `'notification:new': NotificationSchema`.

### 4.3 Runtime

- `packages/runtime/src/proactivity/` (carpeta nueva, no toca `agent/` ni `gateway/`):
  - `types.ts`: `ProactiveEvent = { kind:'run_completed'; runId } | { kind:'file_changed'; projectId; relPath } | { kind:'reminder_due'; reminderId }`.
  - `evaluator.ts`: función pura `decide(agent: {proactivityMode}, event): 'ignore'|'notify'|'act'` — si `proactivityMode==='off'`, siempre `'ignore'` sin evaluar nada más (ni se suscribe a eventos: coincide con "Desactivada: únicamente responde a solicitudes").
  - `fileWatcher.ts`: **[DECISIÓN DE DISEÑO]** usar `fs.watch` nativo de Node por proyecto observado, no agregar `chokidar` como dependencia nueva — doc 17 ya registró que sumar dependencias nativas complicó `better-sqlite3`/`node-pty` en Electron 44; `chokidar` es JS puro pero igual sube superficie. **[HIPÓTESIS A PROBAR]**: si `fs.watch` da falsos negativos en Windows con archivos grandes, migrar a `chokidar` en una iteración posterior, no de entrada.
  - `reminderScheduler.ts`: `setInterval` de 60s comparando `next_fire_at` contra la hora actual; **solo corre mientras el proceso vive** — no hay cron a nivel de SO, coherente con "si el runtime termina... no hay ejecución local activa".
  - `notificationService.ts`: escribe en `notifications` con `dedup_key = `${kind}:${entityId}:${dateBucket}`` y descarta duplicados antes de emitir `notification:new`.
  - `reconcilePendingReminders()`: al boot (llamado desde `createRuntime.ts`), agrupa recordatorios vencidos por agente en **una** notificación consolidada ("3 recordatorios pendientes de cuando la app estuvo cerrada") en vez de disparar cada uno — cumple literalmente el criterio de salida de E4.
- `apps/desktop/src/main/tray.ts` (nuevo): crea el ícono de bandeja **solo si** `settings.get('automation.closeToTray') === true` (default `false`, coherente con la advertencia explícita de la investigación de no instalar continuidad por defecto). Si está activado, `window.on('close')` hace `preventDefault()` + `hide()`; `before-quit` (ya existente) sigue siendo el único camino de cierre real del proceso.

### 4.4 Renderer

- `stores/notificationsStore.ts` (nuevo), suscrito a `notification:new`.
- `layout/StatusBar.tsx`: ícono de campana con contador de no leídas → `features/notifications/NotificationsPanel.tsx` (lista, marcar leído, click salta al run/chat vía `uiNavStore`) — es la "bandeja de actividad" que pide el flujo B de la investigación.
- `AgentEditorModal.tsx` (de E2a, extendido): tres selectores independientes — colaboración (manual/sugerir/automática), modelo (fijo/automático, ya existe desde E2a), proactividad (apagada/sugerencias/acciones) — nunca un único interruptor de "autonomía".
- `features/settings/AutomationSettings.tsx` (nuevo, dentro de la pestaña "Ajustes" del `RightPanel`): defaults globales de los tres controles + toggle "cerrar a la bandeja" (default apagado) + horarios de silencio.

### 4.5 Pruebas de aceptación

| Prueba | Test automático | Harness / manual |
|---|---|---|
| T08 (extendida) | `proactivity_mode='suggest'` genera fila en `notifications`, nunca dispara un run; `'act'` sí dispara `RunController.start` con origen `'proactive'` | — |
| Cierre/bandeja/suspensión | Unit: `closeToTray=false` (default) → cerrar ventana termina el proceso, sin `Tray` creado | Manual: activar bandeja, cerrar ventana, confirmar que no hay ejecución con la PC suspendida y que al reabrir aparecen recordatorios agrupados, no 25 avisos sueltos |

---

## 5. Riesgos con modelos de 8B y mitigaciones

- **Delegación poco confiable** (qwen3:8b puede inventar `targetAgentId`, olvidar `expectedDeliverable`, o no llamar la tool cuando correspondería). Mitigación: esquema de entrada mínimo (`DelegationRequestSchema` de 4 campos), tool no incluida por defecto (activación explícita por agente), profundidad máxima 1 y máximo 3 delegaciones por run — un bucle nunca puede crecer sin límite aunque el modelo insista. **[HIPÓTESIS A PROBAR]**: si en la práctica el modelo delega de más incluso con la tool oculta por defecto, bajar el límite de 3 a 1 delegación por run antes de tocar el prompt.
- **Coordinador de equipo poco confiable si fuera un LLM decidiendo turnos**. Mitigación adoptada: el coordinador es código determinista (`coordinator.ts`, parser de `@mención`), no un agente. Cuesta expresividad (no entiende "que conteste el que sepa de X" sin mención explícita) pero es 100% predecible y no gasta inferencia en decidir quién habla.
- **Formato de entregable no estructurado**: el parser de `DelegationResultSchema` degrada a texto crudo envuelto en vez de fallar la delegación completa — evita que un JSON mal cerrado tire abajo todo el flujo.
- **`model_mode='auto'` con heurística mínima**: puede elegir un modelo subóptimo para la tarea. **[HIPÓTESIS A PROBAR]** — se empieza con "reusar el modelo ya cargado si entra en memoria", se mide antes de agregar lógica de recomendación (que además depende del catálogo/`models:recommend`, fuera de esta entrega).
- **Saturación de recursos**: con 1 slot medido (`[COMPROBADO EN EQUIPO: RTX 3060 Ti 8 GiB]`), padre e hijo de una delegación ya son seriales por construcción — el riesgo real no es "dos inferencias a la vez" sino una cola larga si se abusa de delegación; los límites de profundidad/cantidad de §2.5 acotan también ese caso.
- **Migraciones aditivas con `CHECK` nuevos en tablas nuevas** (`agent_memories`, `reminders`, `notifications`): correctas hoy, pero si más adelante hace falta ensanchar un `CHECK` (ej. agregar un `kind` de recordatorio), habrá que reconstruir esas tablas igual que se hizo con `downloads` en la migración 0002 — costo aceptado, documentado por adelantado.
- **Tray/ciclo de vida de Electron**: tocar `main/index.ts` cerca del *single-instance lock* (`ownerSessionId`/`heartbeatAt`, doc 10) es sensible. Mitigación: el tray es estrictamente opt-in y no cambia el camino de `before-quit` existente; solo intercepta `window.on('close')` cuando el usuario lo activó.

---

## 6. Qué queda explícitamente fuera

Inferencia paralela real (más de 1 slot, v0.4 y gateado por hardware ≥24 GiB VRAM); selección de modelo "inteligente" por tarea (depende del catálogo/recomendador de E2, no de esta entrega); equipos asignados a más de un proyecto a la vez; coordinador de equipo basado en LLM; voz o interrupciones proactivas con la app totalmente cerrada (contradice la advertencia explícita de la investigación); biblioteca/descarga de modelos (es la otra mitad de E2 en la investigación, no pedida en este documento); RBAC fino entre miembros de un equipo (hoy todos los miembros comparten el `permissionPolicy` de su propio `AgentConfig`, sin una capa adicional de permisos "de equipo").

---

## 7. Orden de construcción y tamaño

1. **E2a** primero — es la base de identidad que E3a y E3b necesitan. ~20 archivos: migración, 2 repositorios, `modelPolicy.ts`, `personalProject.ts`, handler IPC, 4-5 archivos de renderer (store, panel, modal, Sidebar, ChatHeader), 2-3 tests.
2. **E3a** — depende de E2a (necesita al menos un agente personal como destino de delegación); reutiliza el Scheduler sin tocarlo. ~15-18 archivos: migración, tool nueva, cambios en `RunController.ts` (un método nuevo + una línea de prioridad), evento nuevo, 1-2 componentes de renderer, tests.
3. **E3b** — depende de E2a y reutiliza el mecanismo de run-hijo de E3a para el enrutamiento de turnos (aunque el turno no crea un chat hijo separado, sino que reusa `agentIdOverride` dentro del mismo chat). ~18-22 archivos: migración, `coordinator.ts`, repositorio de equipos, cambio de firma en `RunController.start()`, 3-4 archivos de renderer, tests.
4. **E4a** — la más grande y la más independiente de las tres anteriores (solo necesita que `agents` tenga las columnas de E2a); toca el proceso principal de Electron (`tray.ts`), que es la zona más sensible. ~20-25 archivos: migración, carpeta `proactivity/` completa (5 archivos), `tray.ts`, 3-4 archivos de renderer, tests.

Se puede cortar después de cualquier entrega sin dejar nada roto: cada migración es aditiva y cada entrega deja el sistema en un estado consistente y probado por su propia tabla de T03-T10.

---

```json
{
  "archivo": "docs/architecture/19-agentes-personales-y-equipos.md",
  "entregas": [
    {
      "id": "E2a",
      "nombre": "Mis agentes",
      "requisitos": ["R01", "R03", "R04"],
      "pruebas": ["T03", "T04", "T09"],
      "migracion": "0004_agent_profiles.ts",
      "archivosEstimados": 20,
      "dependeDe": []
    },
    {
      "id": "E3a",
      "nombre": "Delegación desde el chat",
      "requisitos": ["R06", "R07", "R10"],
      "pruebas": ["T06", "T07", "T10"],
      "migracion": "0005_delegation.ts",
      "archivosEstimados": 17,
      "dependeDe": ["E2a"]
    },
    {
      "id": "E3b",
      "nombre": "Equipos",
      "requisitos": ["R05", "R10"],
      "pruebas": ["T05", "T08"],
      "migracion": "0006_teams.ts",
      "archivosEstimados": 20,
      "dependeDe": ["E2a", "E3a"]
    },
    {
      "id": "E4a",
      "nombre": "Controles de automatización y proactividad",
      "requisitos": ["R07", "R08"],
      "pruebas": ["T08"],
      "migracion": "0007_automation.ts",
      "archivosEstimados": 22,
      "dependeDe": ["E2a"]
    }
  ],
  "migraciones": [
    "0004_agent_profiles.ts: ALTER TABLE agents ADD COLUMN owner_kind/avatar_emoji/avatar_color/description/model_mode/created_at/archived_at; CREATE TABLE agent_memories",
    "0005_delegation.ts: ALTER TABLE runs ADD COLUMN delegation_depth; ALTER TABLE chats ADD COLUMN origin_run_id",
    "0006_teams.ts: CREATE TABLE teams, team_members; ALTER TABLE chats ADD COLUMN team_id; ALTER TABLE messages ADD COLUMN agent_id",
    "0007_automation.ts: ALTER TABLE agents ADD COLUMN collaboration_mode/proactivity_mode; CREATE TABLE reminders, notifications"
  ],
  "canalesIPC": [
    "agents:list", "agents:create", "agents:update", "agents:archive", "agents:duplicate",
    "agent-memory:list", "agent-memory:upsert", "agent-memory:delete",
    "teams:list", "teams:create", "teams:update", "teams:archive", "teams:addMember", "teams:removeMember", "teams:assignProject",
    "reminders:list", "reminders:create", "reminders:update", "reminders:delete",
    "notifications:list", "notifications:markRead"
  ],
  "riesgos": [
    "Delegación poco confiable con qwen3:8b -> esquema mínimo, tool oculta por defecto, profundidad máxima 1, máximo 3 delegaciones por run",
    "Coordinador de equipo basado en LLM sería impredecible -> coordinador determinista por @mención, cero inferencias para decidir turno",
    "Entregable de delegación mal formado -> degradación a texto envuelto en vez de fallar toda la delegación",
    "model_mode=auto con heurística débil -> HIPOTESIS A PROBAR, empezar con reusar modelo cargado, medir antes de sofisticar",
    "Saturación de recursos con 1 slot medido -> ya serializado por el Scheduler existente; límites de profundidad/cantidad acotan colas largas",
    "Tray/ciclo de vida de Electron cerca del single-instance lock -> tray estrictamente opt-in, no cambia el antes-de-antes-de-salir existente",
    "CHECK nuevos en agent_memories/reminders/notifications requerirán reconstrucción de tabla si se ensanchan a futuro -> costo aceptado y documentado"
  ]
}
```
