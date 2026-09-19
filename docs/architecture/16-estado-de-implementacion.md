# 16 — Estado de implementación (MVP)

**Fecha:** 2026-09-18
**Alcance:** lo marcado "Imprescindible para el MVP" en `spine-columna-vertebral.md` §16 y en cada documento.
Este documento es un registro de estado, no una fuente de verdad de diseño: la nomenclatura sigue viniendo de los documentos 00 a 15.

## 1. Estado de los gates

| Gate | Comando | Resultado |
|---|---|---|
| Typecheck | `pnpm typecheck` (`tsc --build --force`) | Verde: `@saurio/shared`, `@saurio/runtime`, `@saurio/repomap`, `apps/desktop` (main + preload + renderer) — confirmado de nuevo al cierre de la sesión 2026-09-18 (tercera pasada, §9.8) |
| Tests | `pnpm test` | 623 tests en verde + 2 skipped (repomap 12, runtime 518+2 skipped, desktop 93), tras los siete cabos sueltos de §9 |
| Build | `pnpm build` (`electron-vite build`) | Verde: `out/main`, `out/preload`, `out/renderer` |
| Arranque | `SAURIO_SMOKE=1 pnpm --filter @saurio/desktop run dev` | La ventana abre, `app:ping` y `models:list` responden y la app cierra sola (exit 0). `models:list` devolvió `qwen2.5-coder:7b` y `qwen3:8b` desde Ollama 0.34.1 en `127.0.0.1:11434` |
| Arranque sin smoke | `pnpm --filter @saurio/desktop run dev` | La ventana abre y el renderer sobrevive (ningún `render-process-gone` ni `did-fail-load`) con la mitigación de GPU activa por defecto |

## 2. Qué quedó implementado

- **Persistencia** (`packages/runtime/src/persistence`): driver better-sqlite3 con los 5 PRAGMAs, migración 1 completa (28 tablas, CHECK, índices parciales, FTS5 + triggers, vistas JSON1), `EventStore` con append + proyección en una sola transacción, `rebuild` y repositorios de Project/Chat/Message/ToolCall/Checkpoint/Task/Settings.
- **Gateway** (`gateway/`): `OllamaProvider` (fetch + NDJSON propio + zod, ADR-2) contra `/api/version`, `/api/tags`, `/api/show`, `/api/ps` y `/api/chat` en streaming; `Scheduler` de 1 slot; `ModelGatewayImpl` con la regla de localidad (nunca fallback a nube).
- **Tools** (`tools/`): las 10 builtins, `WorkspaceFs` confinado, `PathLock`/`ReadTracker`, cascada de matching para `edit_file`, y los dos transportes (`NativeToolProtocol` y `TextToolProtocol` con escaneo de `content`).
- **Permisos** (`permissions/`): motor con invariantes antes que reglas, precedencia `session → project → global`, parser de pwsh, comandos críticos y memoria de decisiones. Preset del usuario: `balanced` con `write = allow` dentro del workspace.
- **Checkpoints** (`checkpoint/`): `FileBlobStore` content-addressed con refcount, `FsCheckpointService` (begin/commit/diff/planRevert/revert).
- **Contexto** (`context/`): presupuesto, `TokenEstimator` calibrable, compactación nivel 1+2 y `ContextBuilder` con prefijo estable.
- **Repo map** (`packages/repomap`): pipeline completo (listado → tags tree-sitter → grafo → PageRank personalizado → render por presupuesto) con grammars de `@vscode/tree-sitter-wasm`.
- **Agent runtime** (`agent/`): `RunController` completo (máquina de estados, permisos, checkpoints, loop/degeneración, `recover()`), `TaskManager`.
- **Modelos y telemetría** (`models/`, `telemetry/`): `HardwareProbe` (nvidia-smi), `MemoryEstimator`, `ModelManager` con poller único de `/api/ps`, `MetricsAggregator` y `Diagnostics`.
- **App de escritorio**: `RuntimeHost` con instancias reales, los 34 canales IPC registrados, `TerminalService` (node-pty), `SystemSampler`, y el renderer montando los componentes reales (chat, permisos, tareas, archivos, diff, terminal, modelos, rendimiento, ajustes).

### Piezas que agregó la fase de integración

| Archivo | Por qué |
|---|---|
| `packages/runtime/src/persistence/repositories/run.ts` | `RunRepository` real sobre la tabla `runs`; el puerto lo declaraba `agent/ports.ts` pero nadie lo implementaba |
| `packages/runtime/src/persistence/repositories/agent.ts` | `AgentConfigResolver` sobre la tabla `agents` (FK obligatoria de `chats`/`runs`) |
| `packages/runtime/src/persistence/repositories/checkpointStore.ts` | `CheckpointStoreRepository` + `BlobRefStore` sobre SQLite (antes solo existían en memoria) |
| `packages/runtime/src/agent/defaults.ts` | Agente builtin del MVP: `numCtx` 8192, `thinking: off`, preset `balanced`, las 10 tools |
| `packages/runtime/src/context/engine-repo-map-client.ts` | `RepoMapClient` real sobre `@saurio/repomap` (in-process, con `// TODO utilityProcess v0.2`) |
| `apps/desktop/src/main/host/createRuntime.ts` | Único punto donde se construyen las instancias concretas y se arma el `RunController` por proyecto |
| `apps/desktop/src/main/host/BroadcastEventStore.ts` | Suscripción push a los `RunEvent` ya persistidos, para `runtime:event` |
| `apps/desktop/src/main/smoke.ts` | Verificación de arranque con `SAURIO_SMOKE=1` (ping + `models:list` + cierre automático) |

### Ajustes de integración sobre módulos existentes

- `RunController`: ahora pide el repo map al `RepoMapClient` (antes mandaba `repoMap: ''`), aplica `settings.toolTransportOverrides` cuando el agente pide `toolTransport: 'auto'` (qwen2.5-coder → `text`, medido), toma el modelo del chat (`chats.model_ref_json`) y lo hereda en `run:continue`.
- `ipc/chat.ts`: `chat:history` resuelve los runs del chat y concatena sus tool calls (antes usaba `chatId` como si fuera `runId`).
- `ipc/project.ts`: `project:open` persiste el proyecto y crea el `ProjectRuntime` (es lo que habilita `run:*` y `checkpoint:*`).
- `renderer/src/ipc/client.ts`: la declaración global de `window.saurio` es ahora exactamente `PreloadApi`; antes declaraba `onEvent(cb)` de un solo argumento y `terminalPort(): never`, que compilaba pero no coincidía con el preload real.
- `layout/ChatCenter.tsx` / `AppLayout.tsx`: montan `ChatPanel` y `TaskChecklist` reales y llaman `wireIpcEvents()` una vez.
- `electron.vite.config.ts`: `better-sqlite3`, `@vscode/ripgrep`, `web-tree-sitter` y `@vscode/tree-sitter-wasm` se externalizan a mano. Bundlear better-sqlite3 rompía con `Could not dynamically require .../better_sqlite3.node`.
- `main/index.ts`: la CSP se relaja **solo en dev** (`ELECTRON_RENDERER_URL` presente) para que el preámbulo inline de React Refresh no quede bloqueado; el build empaquetado conserva `script-src 'self'`.

## 3. Qué NO quedó implementado (sigue como interfaz/enum con comentario de versión)

- v0.2: `models:pull` / `models:pullCancel` / `models:delete` (DownloadManager), `profiles:*`, provider `openai-compat`, `CommandParser` de bash, presupuesto de contexto a 32k, `.saurio/rules/*.md`, plan de tareas editable.
- v0.3: MCP (`source.kind = 'mcp'`), `bench:*`, gestión del proceso de Ollama (`services/ollama-process`), carpeta `shadow/`, cuarentena de blobs faltantes.
- v0.4: delegación a subagentes (`parentRunId`), `fileScope`.

## 4. Desvíos heredados de los módulos, todavía abiertos

1. ~~**`PermissionEngine.evaluate`** no recibe `toolCallId` ni `touchedPaths`~~ — **ya estaba resuelto** al empezar esta sesión: `EvaluateCall` (permissions/engine.ts) ya los declara opcionales y `RunController.executeOneToolCall` ya los pasaba. Lo que sí faltaba y se cerró ahora (§7): que `allow_always`/"recordar" persista de verdad.
2. ~~**`PermissionRequestSchema`** no tiene `noAllowOption` / `forceWarning`~~ — **resuelto** (§9.3): campos reales agregados (additive, `packages/shared`); `DefaultPermissionEngine` los produce para los dos invariantes de doc 06 §5 (comando crítico: ambos en `true`; `git_push`: solo `noAllowOption`). `rememberOptions: []` y el prefijo `COMANDO CRÍTICO:` en `triggeredBy` se conservan (compatibilidad).
3. ~~**`RevertPlanSchema`** no tiene `uncoveredEffects`, `branchChanged` ni `editedBy`~~ — **resuelto** (§9.3): los tres campos agregados (additive, `packages/shared`); `FsCheckpointService.planRevert` los calcula de verdad (`uncoveredEffects` vía `run_command` del rango de la selección, `branchChanged` vía `GitHeadReader` + `checkpoints.git_head` nuevo, `editedBy` vía `findLatestFileMatch`). Todos opcionales/con default `[]`: sin las deps nuevas (`gitHead`/`toolCalls` en `CheckpointServiceDeps`), el comportamiento es el previo.
4. ~~**`RUN_TRANSITIONS`** no tiene la arista `parsing → queued`~~ — **resuelto** (§7.7): se agregó la arista real (más `queued → compacting` y `compacting → cancelling`) y se eliminó el bypass de `returnToQueue()`.
5. ~~**Estado `compacting`** nunca se emite~~ — **resuelto** (§7.4): `ContextBuilder` gana `willCompact()` + un `Compactor` real inyectable; `build()` devuelve `compaction` cuando compactó, y `RunController` emite la transición y el evento `context.compacted` con datos reales.
6. ~~**`ChatMessage`** no tiene `truncated`~~ — **resuelto** (§7.4): campo agregado (additive, packages/shared), `RunController.streamChat` persiste el fragmento parcial en cada corte de stream, `ContextBuilder` antepone `[respuesta cortada]` cuando ese mensaje sobrevive a un `run:continue`.
7. ~~**`ContextBudgetReport.used.tools`** queda en 0~~ — **resuelto** (§7.4): `ContextBuilder.build()` acepta `toolsText` (el `RunController` lo arma con `protocol.renderTools()`, movido antes de `context.build` en el loop) y lo estima como tokens `'json'`.
8. ~~**Capado automático de `numCtx` contra `/api/show`** (ADR-7)~~ — **resuelto** (§7.5): `RunControllerDeps.modelContextProbe` (puerto opcional) + `capNumCtxAgainstModel()` en `prepareAndQueue`, con `run_adjustments`/`run.adjustment` reales. **No wireado todavía en `apps/desktop`** (ver "Pendiente" más abajo): `createRuntime.ts` no pasa este puerto, así que el capado solo corre donde `eval/harness.ts` lo cablea a mano.
9. ~~**Batching de `message.delta` a 30 ms** dentro del `RunController` no implementado~~ — **resuelto** (§9.4): `MessageDeltaBatcher` (`agent/deltaBatcher.ts`) agrupa content/thinking en ventanas de ~30 ms antes de emitir el evento, con `flush()` explícito antes de cualquier evento terminal del turno — mismo contenido y mismo orden, menos filas en `run_events`. El `RunEventBatcher` de `apps/desktop/main` sigue agrupando un nivel más arriba (antes de IPC); ahora hay agrupación en ambos niveles.
10. ~~**Reanudar un run rehidratado en `awaiting_permission`** tras reiniciar la app~~ — **resuelto** (§7.2): `RunController.resumeAfterRestart()` + `answerPermission()` rehidratan desde `run_events`/`tool_calls` sin repetir ninguna ejecución; el contrato IPC `permission:answer` no cambia.
11. ~~**`files:tree`** no existe en `packages/shared/src/ipc.ts`~~ — **resuelto** (sesión 2026-09-18, pasada de integración de escritorio): `files:tree`/`files:read` ya están en el contrato, con handler real en `apps/desktop/src/main/ipc/files.ts` (árbol perezoso por carpeta sobre el `WorkspaceFs` del proyecto activo, mismo `.gitignore`/`.saurioignore` que las tools) y `fs.watch` para "modificado externamente" (evento `files:changed`). `FilesPanel` usa el canal tipado y abre un visor de solo lectura con CodeMirror (`FileViewer.tsx`, cargado con `React.lazy`).
12. ~~**Carpeta de modelos detectada** no tiene canal IPC~~ — **resuelto**: `ModelManager.detectedModelsFolder()`/`.attachWarnings()` ya existían implementados (el gap real era solo el canal IPC); se agregó `models:folderInfo` y espacio libre/total vía `fs.statfs` (antes no se calculaba). `ModelsPanel` lo muestra con los avisos de modo attach en modo lectura.
13. **`ProjectIndexer` en `utilityProcess`** (ADR-1): el motor de repo map corre in-process (marcado `// TODO utilityProcess v0.2` en `engine-repo-map-client.ts`).
14. **`ripgrep` real**: `search_code` y el listado del repo map usan `@vscode/ripgrep`; `@saurio/repomap` tiene además un fallback manual porque `rg` no está en el PATH de este equipo de desarrollo.
15. **`ulid`** no está instalado: los ids de checkpoint usan `crypto.randomUUID()` (inyectable).
16. ~~**`edit_file`/`write_file` contra `ReadTracker` en memoria, no contra `tool_calls.expected_pre_hash`**~~ — **resuelto** (§9.2): `RunController.executeOneToolCall` completa `expected_pre_hash` al registrar `edit_file`/`write_file`/`delete_file` (vía `LastReadHashes`, opcional) y los tres handlers (`tools/builtin/`) lo leen de vuelta por `toolCallId` (vía `ExpectedPreHashPort`, opcional) en vez de (solo) `ReadTracker`. Sin las deps nuevas, el comportamiento es el previo (fallback a `ReadTracker`). `eval/harness.ts` ya no necesita esquivar el gap: el paso `(o)` nuevo prueba exactamente el escenario que antes fallaba (reinicio real entre `read_file` y `edit_file`, con un cambio externo en el medio → conflicto detectado contra lo persistido).

## 5. Pendientes de verificación funcional

**Cerrado en esta sesión** (ver §7 para el detalle): permiso `ask` de punta a punta con `allow_once`/`deny`/`allow_always` (persistencia real + aplicación en el siguiente run), reanudar un run `awaiting_permission` tras cerrar y reabrir el runtime, `TextToolProtocol` de punta a punta con `qwen2.5-coder:7b` en modo `agent` con una tool mutante, capado automático de `numCtx`, compactación real (`compacting` + `context.compacted`), tasks persistidas en modo `plan`, y la prueba de recuperación sin pérdida (usuario antes + agente + usuario después + revert `keep_mine`).

**Sigue pendiente:** wireo de `permissionMemory`/`modelContextProbe`/`Compactor`/`readHashes` en `apps/desktop/src/main/host/createRuntime.ts` (ítem 8 de §4 y nota al final de §7; `readHashes` es la contraparte de `RunControllerDeps` que cierra el ítem 16 de §4, ver §9.2) — la lógica del runtime está implementada y probada contra Ollama real vía `eval/harness.ts`, pero la app de escritorio real todavía construye `RunControllerDeps` sin estos cuatro campos opcionales, así que "permitir siempre" no persiste, `numCtx` no se capea, la compactación no dispara y `tool_calls.expected_pre_hash` queda `NULL` **en la app**, aunque los cuatro sí funcionan en el harness (§9.2 agrega el paso `(o)` que lo prueba de punta a punta). El gap de `ReadTracker`/`expected_pre_hash` en sí (ítem 16 de §4) ya no es un gap de diseño — es exclusivamente falta de wireo en `createRuntime.ts`, igual que los otros tres.

## 6. Validación end-to-end del recorrido #1 (`eval/harness.ts`)

**Qué es:** `eval/harness.ts` (ejecutable con `pnpm test:eval` == `tsx eval/harness.ts`, doc 02 §4.1) arma `@saurio/runtime` exactamente igual que `apps/desktop/src/main/host/createRuntime.ts` (reutiliza `createGlobalRuntime`/`initGlobalRuntime`/`createProjectRuntime`, sin Electron), contra un mini proyecto TS fixture (3 archivos + `SAURIO.md`, `src/math.ts` con un bug real: `suma` restando) en una carpeta temporal, con la base SQLite en OTRA carpeta temporal, y corre el recorrido completo contra Ollama real en `127.0.0.1:11434`: (a) listar modelos y elegir `qwen3:8b` (numCtx 8192), (b) run modo `plan`, (c) run modo `agent` que arregla el bug, (d) diff del checkpoint, (e) revert del checkpoint, (f) cerrar y reabrir la base en otra instancia y verificar que el historial se lee.

**Resultado medido (2026-09-18, RTX 3060 Ti 8 GiB, Ollama 0.34.1, `qwen3:8b` Q4_K_M):** 6/6 pasos en verde en dos corridas consecutivas. ~62-66 tok/s de generación por respuesta (`evalTokens/evalMs` de `ResponseMetrics`); una corrida llegó a picos de ~110 tok/s en respuestas cortas de cierre. `fits(qwen3:8b, numCtx=8192)` midió `fitClass: 'no_fit'`/`'partial_offload'` según cuánta VRAM tenía libre el equipo en el momento (otros procesos ocupando GPU) — el modelo igual corrió y respondió con normalidad; el estimador de VRAM es conservador (`source: 'formula'`, no `'model_compat'`). El run en modo `agent` tardó entre 6 y 17 s según cuántas veces el modelo reintentó `edit_file`.

**Hallazgo de robustez del modelo (no es un bug de runtime):** en una corrida, `qwen3:8b` (temperature 0.2, thinking off) llamó `edit_file` con `old_string: "return a - b;"` sin `replace_all`, que matchea tanto `suma` como `resta` (`src/math.ts` fixture) — `replaceAtCascade` lo rechaza como ambiguo (`"old_string ambiguo (match exacto múltiple); agregá más contexto"`, `matching.ts`), correctamente. El modelo repitió la misma llamada ambigua 4 veces sin incorporar el mensaje de error, hasta que el `LoopDetector` abortó el run (`doc 05 §2.10`/`doc 10 caso 10`). En la corrida siguiente (mismo prompt, mismo modelo) sí lo resolvió (usó `replace_all: true` y de paso también cambió `resta`, que no se le había pedido). Se registra como variabilidad del modelo local de 8B, no como defecto del runtime — no se probó `TextToolProtocol`/`qwen2.5-coder:7b` porque `qwen3:8b` sí llama tools nativas correctamente (el problema es de razonamiento/disambiguación, no de transporte de tools).

**Tres bugs de integración reales, nunca ejercitados hasta esta corrida (nunca se había corrido un run completo contra SQLite real + Ollama real a la vez — los tests unitarios usan fakes que no cruzan `EventStore` real y los repositorios reales en el mismo run), arreglados en `packages/runtime/`:**

1. **`messages.id` UNIQUE constraint failed** (`RunController.start()` y el cierre de `streamChat()`): el código insertaba el mensaje dos veces — una vía `MessageRepository.append()` directo y otra vía `events.append({type:'message.done', ...})`, cuya proyección (`events/projections/messages.ts`) hace un `INSERT` simple (no upsert) de la misma fila. Fallaba en la primerísima llamada a `runController.start()`. Fix: no llamar a `messages.append()` para el mensaje que de todos modos va a viajar en el evento `message.done` — la proyección ya lo persiste (coherente con el comentario ya existente en `message.ts`: "`message.done` ... pasa por `SqliteEventStore.append`, no por acá").
2. **`tool_calls.id` UNIQUE constraint failed** (`executeOneToolCall()`): mismo patrón — `toolCalls.upsert(record)` directo antes de `events.append({type:'tool.registered', ...})`, cuya proyección también hace `INSERT` simple ("write-ahead"). Fix: eliminar el `upsert` redundante antes del evento.
3. **`FOREIGN KEY constraint failed` en `tool_calls.checkpoint_id`** (`runHandler()`): al iniciar una tool mutante (`edit_file`/`write_file`/`delete_file`), el código seteaba `tool_calls.checkpoint_id` al id que acababa de reservar `checkpoints.begin()` **antes** de que existiera la fila en `checkpoints` (esa fila recién se crea en `checkpoints.commit()`, después de ejecutar la tool) — viola la FK `tool_calls.checkpoint_id REFERENCES checkpoints(id)` con `foreign_keys=ON`. Fix: no escribir `checkpoint_id` en ese punto; el evento `checkpoint.created` (tras el commit) ya lo setea vía su proyección una vez que el checkpoint existe.
4. **Checkpoints fantasma con diff vacío** (`FsCheckpointService.commit()`, no relacionado con SQLite sino con la semántica): cuando una tool mutante fallaba *antes* de llamar a `ctx.checkpoint.before()/after()` (p. ej. `edit_file` con match ambiguo), `runHandler()` igual llamaba a `checkpoints.commit()`, y `commit()` usaba el placeholder que `begin()` siembra para cada path declarado (`{ existedBefore: false }`) como si fuera un cambio real, generando un checkpoint con `change: 'created'` pero sin `preHash`/`postHash` — `diff()` devolvía vacío y `revert()` no tenía nada que restaurar. Fix: `commit()` ahora excluye los paths cuyo `state.change` sigue `undefined` (nunca pasaron por `before`/`after`), en vez de inventarles un `created` falso.

Los cuatro se descubrieron y arreglaron corriendo `eval/harness.ts` de verdad, en la sesión de validación del 2026-09-18. Los 467 tests unitarios/de integración existentes siguieron en verde después de cada fix (no los detectaban porque ninguno cruza `EventStore` real + repositorios SQLite reales en el mismo run, que es justamente el camino que sí ejercita `RunController` en producción).

## 7. Próxima entrega (doc 17 §5) — cerrada en esta sesión (2026-09-18, segunda pasada)

Cierra los tres huecos que pedía doc 17 §5 (permiso `ask`, `TextToolProtocol` con `qwen2.5-coder:7b`, recuperación sin pérdida) y, además, los ítems 4/5/6/7/8/10 de §4 (compactación real, `numCtx` capeado, arista `parsing → queued`) que quedaban abiertos en `packages/runtime/src/{agent,context,permissions,tasks,events,persistence}`. Todo probado contra Ollama real (`127.0.0.1:11434`, Ollama 0.34.1, RTX 3060 Ti 8 GiB) vía `eval/harness.ts`, extendido con los pasos `(g.1)`–`(n)`.

### 7.1 Contrato de `PermissionEngine.evaluate` (doc 16 §4 ítem 1, primera mitad)

Ya estaba resuelto al empezar: `EvaluateCall` (`permissions/engine.ts`) declara `toolCallId`/`touchedPaths` como opcionales (superconjunto estructural de `ToolClassification & { toolName }`, así que sigue siendo asignable desde el contrato original) y `RunController.executeOneToolCall` ya los pasaba. Lo que faltaba de verdad era la persistencia (§7.2 de este documento).

### 7.2 Permiso `ask` de punta a punta + persistencia de `allow_always` + reanudar tras reinicio

- **`PermissionRuleRepository`/`PermissionDecisionRepository` implementados sobre SQLite** (`persistence/repositories/permission.ts`, nuevo): antes solo existían como interfaces en `permissions/repository.ts`, sin ningún backend. Se agregan a `createRepositories()`.
- **`RunController` ahora persiste "recordar decisión" de verdad**: `afterPermissionAnswered()` (factoreado del viejo cuerpo inline de `executeOneToolCall`, reutilizado también por `resumeAfterRestart()`) llama a `PermissionMemory.recordAnswer()` cuando `RunControllerDeps.permissionMemory` está inyectado. Cada `start()`/`continueRun()`/`resumeAfterRestart()` llama a `withPersistedRules()`, que concatena las reglas de proyecto/global ya persistidas al `AgentConfig.permissions.rules` del run — `PermissionEngine.evaluate()` no necesita cambios porque ya resuelve precedencia por `rule.scope`, sin importar el orden de la lista.
- **`resumeAfterRestart(runId)`**: reconstruye un `LiveRun` mínimo a partir de `runs`/`tool_calls`/`run_events` (sin re-ejecutar nada que ya haya corrido — la tool pasa `approved → running` "por primera vez", doc 10 §5.2) y registra un `pendingPermission` nuevo. `answerPermission()` prueba primero los runs vivos en memoria y, si no encuentra ninguno, busca la `tool_calls` `awaiting_permission` correspondiente y llama a `resumeAfterRestart` automáticamente — **el contrato IPC `permission:answer` no cambia**, así que `apps/desktop` no necesita ningún ajuste para que esto funcione una vez que le pasen `permissionMemory`/`projectId` (ver pendiente en §4 ítem 8/nota final).
- **Bug real encontrado y arreglado** (`events/projections/toolCalls.ts`, `onDecision`): el `INSERT` a `permission_decisions` listaba 7 columnas con 5 placeholders `?`, pero el `.run()` solo pasaba 4 argumentos — faltaba el valor de `decision`. `better-sqlite3` tiraba `"Too few parameter values were provided"` en la **primera** respuesta real a una `PermissionRequest`, dejando el run en `failed` sin registrar nada. Nunca se había detectado porque ningún test cruza `EventStore` real con este camino y ningún run end-to-end anterior usó un preset que dispare `ask` de verdad (el preset por defecto, `balanced`, tiene `write = allow`). Fix de una línea + dos tests de regresión (`events/index.test.ts`, sobre SQLite real).
- ~~**Hallazgo documentado, no arreglado (fuera de zona):**~~ **resuelto en la sesión siguiente** (§9.2): `edit_file`/`write_file`/`delete_file` ahora pueden decidir "¿cambió el archivo desde que lo leí?" contra `tool_calls.expected_pre_hash` en vez de solo `ReadTracker`. Ver §4 ítem 16 y §9.2 para el detalle.

### 7.3 `TextToolProtocol` con `qwen2.5-coder:7b`

MEDIDO contra Ollama 0.34.1 real: el modelo responde el JSON de la tool call de tres formas distintas en la misma corrida — (a) bare, como contenido completo del mensaje; (b) envuelto en un fence ```` ```json ```` con prosa antes; (c) prosa + fence + el mismo JSON repetido bare a continuación — **nunca** dentro de las etiquetas `<tool_call>...</tool_call>` que el `systemSuffix` de `TextToolProtocol` le pide explícitamente. `scanToolCallBlocks` (`tools/protocols/scanToolCalls.ts`) solo buscaba el tag de apertura; en los tres casos el turno se trataba como "sin tool call", y tras tres turnos así el `LoopDetector` forzaba el cierre con la respuesta de texto sin que el modelo llegara a intentar ninguna tool. Fix: si ningún bloque etiquetado matcheó, se busca en el texto restante el **último** objeto JSON balanceado con un campo `name` string (fenced o bare, con o sin prosa alrededor) — "último" cubre el caso de JSON duplicado. Confirmado end-to-end: `read_file` + `edit_file` ambas en transporte `text`, archivo corregido correctamente.

### 7.4 Compactación real + `used.tools` + `[respuesta cortada]`

- **`ContextBuilder` gana `willCompact()` y un segundo parámetro opcional `Compactor`** (`context/types.ts`, `context-builder.ts`): `willCompact()` deja que `RunController` anuncie la transición `run.state → 'compacting'` *antes* de llamar a `build()` (que puede tardar — el nivel 2 le pide un resumen al modelo, doc 07 §7.2, ocupando un slot de inferencia real); `build()` aplica la compactación si corresponde y devuelve `compaction` con el resultado. `CompactionResult` gana `historyAfter: ChatMessage[]` (el historial ya reducido, `[resumen?, ...recientes-con-stubs]`) para que el llamador pueda reemplazar `live.history` sin recalcular nada.
- **`RunController`** reordena el loop: renderiza las tools *antes* de `context.build` (para `toolsText`), chequea `willCompact`, transiciona, llama a `build`, y si compactó: persiste el mensaje-resumen (`messages.append`, fuera del `EventStore` — no tiene métricas reales del provider que inventar), emite `context.compacted` (con `replacedMessageIds` cuando hay resumen) y reemplaza `live.history` por `compaction.historyAfter` — sin esto último, la compactación se hubiera vuelto a disparar cada turno siguiente porque el historial crudo nunca se reducía. `allowCompaction: false` durante un reintento de formato (doc 07 §7.1, "nunca dispara a mitad de una recuperación de parseo").
- **`ContextBudgetReport.used.tools`** ya no está hardcodeado en 0: `toolsText` (el JSON de `protocol.renderTools()`) se estima como tokens `'json'`.
- **`ChatMessage.truncated`** (campo agregado, additive, `packages/shared`): `RunController.streamChat` persiste un mensaje `truncated: true` con el fragmento parcial en cada corte de stream (error, sin `done`, excepción) — antes el fragmento se perdía sin dejar rastro si el run terminaba fallando, pese a que doc 10 caso 3 dice "lo hecho hasta acá está guardado". `ContextBuilder` antepone `[respuesta cortada]` cuando ese mensaje sobrevive a un `run:continue` (el reintento inmediato del mismo turno nunca lo agrega a `live.history`, así que queda excluido sin rama especial).
- Verificado con Ollama real forzando `compactEveryTurns: 1` (paso `(n)` de `eval/harness.ts`): `run.state → compacting`, evento `context.compacted` con `tokensBefore`/`tokensAfter` reales, y los mensajes reemplazados quedan con `compacted_by` en SQLite.
- **Pendiente:** `apps/desktop/src/main/host/createRuntime.ts` construye `ContextBuilder` sin `Compactor` (`createContextBuilder(createTokenEstimator(...))`, un solo argumento) — la compactación no dispara todavía en la app real, solo donde `eval/harness.ts` la cablea a mano.

### 7.5 Capado automático de `numCtx` (ADR-7)

`ModelContextProbe` (puerto opcional nuevo, `agent/ports.ts`) + `RunController.capNumCtxAgainstModel()` en `prepareAndQueue`: si `contextMax` (de `/api/show`, vía el puerto) es menor que el `numCtx` pedido, lo capea y registra un `Adjustment` (`param: 'numCtx', source: 'auto'`) — reutiliza el loop de `run_adjustments`/`run.adjustment` que ya existía para otros ajustes. Verificado con `qwen3:8b` real: `contextMax` medido 40960, `numCtx` pedido 200000 en la `ContextPolicy` del agente, `effectiveConfig.numCtx` terminó en 40960 con el evento `run.adjustment` correspondiente. **Pendiente:** mismo wireo que §7.4 — `createRuntime.ts` no pasa `modelContextProbe` todavía.

### 7.6 Modo plan (`task_update` + `finish`) y `edit_file` ambiguo

- **System suffix de modo plan** (`context-builder.ts`): cuando `mode === 'plan'`, se le pide explícitamente al modelo llamar `task_update` con el checklist completo antes de `finish`. Además, `runHandler`/`runFinish` ahora mapean correctamente el `structured` de `task_update`/`finish` a `Omit<Task,'chatId'>[]` con `id` estable por `chatId:ord` (para que `ON CONFLICT` actualice en vez de duplicar entre llamadas o `run:continue`).
- **Bug real encontrado y arreglado**: el código anterior pasaba `result.structured` (`{ steps: [...] }`, la forma real que devuelve la tool `task_update`) directo a `TaskManager.update()` como si ya fuera un `Task[]` — `tasks.map(...)` dentro de `DefaultTaskManager` explotaba (`{steps:[...]}.map is not a function`) en la primera llamada real contra un modelo, nunca ejercitada hasta ahora.
- **`edit_file` ambiguo devuelve las coincidencias numeradas** (`tools/matching.ts`): `MatchFailure` gana `candidates?: { line, preview }[]`, poblado en los niveles `exact`/`eol`/`indent`/`whitespace`; el mensaje de error de `edit_file.ts` las lista y sugiere agregar contexto o usar `replace_all`. El system prompt (`agent/defaults.ts`) se lo pide explícitamente al modelo — hallazgo directo del caso real de doc 16 §6 (el `LoopDetector` había abortado un run porque `qwen3:8b` repitió una llamada ambigua 4 veces sin cambiar nada).
- Verificado con Ollama real: `tasks` queda persistida tras un run en modo `plan`; `edit_file` con `old_string` ambiguo devuelve el mensaje con las líneas numeradas (probado directo contra el tool handler real, sin necesitar el modelo).

### 7.7 `RUN_TRANSITIONS`: arista `parsing → queued`

Se agrega la arista real (doc 05 §2.5 pasos 23-25: reintento de parseo, "elegí una tool o llamá a finish", permiso denegado — todos vuelven a encolar sin pasar por `executing_tool`), más `queued → compacting` y `compacting → cancelling` (necesarias para §7.4). `RunController.returnToQueue()` ya no escribe el evento a mano: usa `transition()` como cualquier otra arista.

### 7.8 Recuperación sin pérdida (prueba de la investigación, doc 17 §5 punto 3)

Escenario completo contra Ollama real, sin tocar `CheckpointService` (ya se comportaba correctamente): usuario edita el archivo antes del run → el agente lo edita vía `edit_file` (checkpoint real) → el usuario lo edita de nuevo, por fuera del run, después de que el agente ya aplicó su cambio → `planRevert` detecta el conflicto (`hash(actual) ≠ postHash`) → `revert(..., { [relPath]: 'keep_mine' })` no toca el archivo. Verificado: el contenido final es exactamente lo que escribió el usuario la segunda vez — nada de lo ajeno se pierde.

### 7.9 Corridas del harness

`eval/harness.ts` extendido con 11 pasos nuevos (`(g.1)`, `(g.2)`, `(g.3)`, `(g.4)`, `(h)`, `(i)`, `(j)`, `(k)`, `(l)`, `(m)`, `(n)`) sobre los 6 del recorrido #1 original (`(a)`–`(e)` + `(f)`), total **17 pasos**. **17/17 en verde, en dos corridas consecutivas** contra Ollama real (127.0.0.1:11434, Ollama 0.34.1, `qwen3:8b`/`qwen2.5-coder:7b` Q4_K_M, RTX 3060 Ti 8 GiB), ~179s cada una. Los bugs de §7.2/§7.6 arriba se encontraron y arreglaron *durante* estas corridas, no antes — ninguno lo detectaban los 467 tests unitarios existentes porque ninguno cruza `EventStore` real con un preset que dispare `ask` de verdad ni con un modelo real llamando `task_update`.

## 7. Pasada de integración de escritorio (sesión 2026-09-18, tarde)

Alcance: `apps/desktop/**`, `packages/shared/**`, `packages/runtime/src/{models,telemetry,gateway/providers/ollama}` (zona asignada; `packages/runtime/src/{agent,context,permissions,tasks,events,persistence}` y `eval/` quedaron para el otro agente en paralelo).

**Resuelto de punta a punta** (contrato IPC + handler en main + UI real, `pnpm typecheck`/`pnpm test`/`pnpm build` en verde):
- `files:tree`/`files:read` (árbol perezoso por carpeta, `.gitignore`/`.saurioignore` vía el `WorkspaceFs` del proyecto activo, `fs.watch` para "modificado externamente", visor de solo lectura CodeMirror con `React.lazy`).
- `models:folderInfo` (carpeta `OLLAMA_MODELS` detectada + espacio libre/total + avisos de modo attach) — el motor (`ModelManager.detectedModelsFolder()`/`.attachWarnings()`) ya existía; el gap real era solo el canal IPC, como ya registraba este documento.
- `chat:setModel`/`chat:setMode` (cambiar modelo/modo de un chat existente desde la cabecera).
- Terminal: pestañas básicas + limpieza del comentario de `onTerminalPort` (el preload ya lo implementaba de verdad desde una sesión anterior; solo `features/terminal`/`layout/ipcRaw.ts` seguían con el comentario viejo).
- `RuntimeHost.openProject` cancela los runs vivos del proyecto anterior antes de reemplazarlo (un solo proyecto abierto a la vez).
- Code-splitting: `FileViewer` (CodeMirror) y `TerminalPanel` (xterm) se cargan con `React.lazy`, afuera del chunk inicial del renderer.

**No abordado en esta pasada** (queda pendiente, ver `docs/MANUAL.md` §4): `DownloadManager` (`models:pull`/`pullCancel`/`delete` reales con progreso/ETA/cancelación/verificación de espacio), catálogo curado (`resources/model-catalog.json`) y recomendaciones por hardware, Panel de rendimiento v0.2 (muestreo continuo, `metrics_minute`, gráficos), Ajustes v0.2 (mitigación de GPU y `numCtx` por defecto desde la UI), y una limpieza exhaustiva de estilos inline restantes. Motivo: alcance del encargo mucho mayor a lo que se podía completar con verificación real en una sola sesión; se priorizaron los gaps que este mismo documento ya tenía registrados como bloqueantes (§3/§4 puntos 11 y 12) sobre features nuevas más grandes (DownloadManager, Panel de rendimiento v0.2), para no dejar nada a medio hacer.

**Hallazgo de esta sesión, no una regresión introducida acá**: la herramienta de verificación visual (`SAURIO_SMOKE_SHOT`/`SAURIO_SMOKE_UI`) devolvió `rootHtmlLength=0` (renderer en blanco) y el smoke de IPC (`SAURIO_SMOKE=1`) no llegó a responder `app:ping`/`models:list` en esta sesión concreta, con el log de Electron mostrando `ContextResult::kFatalFailure: Failed to create shared context for virtualization` pese a la mitigación de GPU activa por defecto. Se verificó con `git stash` que el mismo síntoma ocurre en el commit `5c63459` (HEAD antes de esta sesión, sin ninguno de los cambios de esta pasada), así que **no es un efecto de este trabajo**: es una condición del entorno concreto donde corrió esta sesión (probablemente sin compositor de GPU real disponible, distinto del equipo de referencia de §6 donde el mismo smoke sí pasó el mismo día). `pnpm typecheck`/`pnpm test`/`pnpm build` sí corrieron en este entorno sin problema porque no dependen de un renderer real. Queda como `[HIPÓTESIS A PROBAR]` en un entorno con GPU/compositor disponible.

## 8. Pasada de Centro de modelos v0.2/v0.3, Panel de rendimiento v0.2, Ajustes y onboarding (sesión 2026-09-18, noche)

**Causa real del `rootHtmlLength=0` del §7, encontrada y resuelta acá**: no era falta de compositor de GPU — era que la corrida de `SAURIO_SMOKE_UI` compartía `%APPDATA%\SaurioLLM` (mismo `userData`) con otra instancia/corrida concurrente de la app. `apps/desktop/src/main/index.ts` ahora lee `SAURIO_USER_DATA=<carpeta>` y llama `app.setPath('userData', ...)` antes de `app.whenReady()` cuando está presente, para que los smokes usen una carpeta aislada. Verificado: con `SAURIO_USER_DATA` en una carpeta temporal, `rootHtmlLength=5931` y la captura (`docs/capturas/smoke-paso0.png`) muestra la UI completa. El log de `ContextResult::kFatalFailure` sigue apareciendo (la mitigación de GPU lo absorbe, como ya documentaba §7) pero ya no impide que la app arranque.

**Resuelto de punta a punta** (contrato IPC + handler en main + UI real + probado contra Ollama real, `pnpm typecheck`/`pnpm test`/`pnpm build` en verde):

- **`DownloadManager`** (`packages/runtime/src/models/DownloadManager.ts`): `checkSpace` contra el manifest real del registry de Ollama (`RegistryClient.ts`) menos las capas ya presentes en `blobs/`, con margen de 2 GiB; `pull` con progreso agregado por capa (velocidad por media móvil, ETA), cancelación por `AbortSignal`, reanudación best-effort (Ollama resuelve el resume del lado servidor); `delete` con `unload` previo si está cargado y rechazo si el scheduler tiene trabajo encolado. `OllamaProvider.pull()`/`.delete()` nuevos sobre `/api/pull` (streaming NDJSON) y `/api/delete`. Probado de punta a punta contra Ollama real: se descargó y borró `all-minilm` (~46 MB) con progreso medido real (pico ~66 MB/s en esta máquina).
- **Persistencia de `downloads`**: `SqlDownloadsRepository` (`apps/desktop/src/main/services/downloads/`) usa SQL directo sobre el `driver` que ya expone `openPersistence()` — no toca `packages/runtime/src/persistence` (zona de otro agente en esta sesión). Se sembró además la fila de `providers` para `'ollama'` (la tabla estaba vacía; nadie insertaba ahí todavía, y `downloads.provider_id` es la primera FK real hacia ella).
- **Catálogo curado** (`resources/model-catalog.json`, 16 entradas): tamaños verificados contra el manifest real del registry (`registry.ollama.ai`), sin inventar; capabilities/contexto medidos vía `/api/show` para los 4 modelos instalados en este equipo, curados con nota explícita de "no confirmado" para el resto.
- **`RecommendationEngine`** (v0.3, `packages/runtime/src/models/RecommendationEngine.ts`): filtra por capability requerida, clasifica `fitClass` (proxy simplificado y documentado como `[HIPÓTESIS A PROBAR]` cuando el modelo no está instalado, porque falta `model_info`/arquitectura de `/api/show`), badge "probado" solo si hay un `TestedLookup` con `hardwareFingerprint` exacto (todavía sin `model_compat`/Benchmark conectado — eso es v0.3 de otro documento).
- **UI del Centro de modelos**: pestañas Instalados/Explorar/Descargas (`ModelsPanel.tsx`, `ExploreTab.tsx`, `DownloadsTab.tsx`), filtro por uso, badges LOCAL/LAN/NUBE (`.lan`/`.cloud` nuevos en `models.css`, `.local` ya existía).
- **Panel de rendimiento v0.2**: `MetricsTicker` (`apps/desktop/src/main/services/metrics/`) corre solo con el panel abierto o actividad real en el `ModelGateway` (slot ocupado o cola no vacía) vía un watchdog liviano de 3 s que no spawnea nada; `SqlMetricsMinuteRepository` persiste `metrics_minute` (tabla ya migrada) con agregación por minuto y retención de 30 días. `Diagnostics` sumó `evaluateLowVram`/`evaluateQueueBacklog` (doc 14 §7 puntos 3 y 6); `MetricsSnapshotSchema` ahora incluye `diagnostics[]`. `PerfPanel` agregó gráficos SVG propios (`Sparkline.tsx`, sin librería) y una sección de Diagnósticos.
- **Ajustes**: toggle de mitigación de GPU (la lógica ya existía en `main/index.ts`, faltaba la UI; efecto en el próximo arranque) y `numCtx` por defecto por modelo (`models.numCtxDefaults`, alimenta el ajuste estimado de "Instalados"; **no** cambia todavía el `num_ctx` real de un run — eso es `agent`/`context`, zona de otro agente). Sección "Proveedores" con estado vacío para cuando se conecte `openai-compat`/`anthropic`.
- **Asistente de primer arranque** (`features/onboarding/`): máquina de estados pura (`onboardingLogic.ts`, 8 tests vitest cubriendo todas las ramas) + vista (`OnboardingWizard.tsx`). Detecta Ollama vía `provider:health`; si falta, ofrece "Modelos en mi PC" (confirmación explícita antes de `shell.openExternal` a `ollama.com/download`, con allowlist de host en el handler — nunca instala nada) o "Tengo una clave de API" (navega a Ajustes > Proveedores vía `stores/uiNavStore.ts`). Si Ollama responde, recomienda modelos reales vía `models:recommend`. Se muestra una sola vez (`settings.onboarding.completed`) y se reabre desde Ajustes. Probado contra Ollama real: recomendó `qwen2.5-coder:1.5b/3b` y `qwen3:4b` para programar en este equipo (ver `docs/capturas/smoke-onboarding-recommendations.png`).

**No abordado en esta pasada / limitaciones conocidas:**

1. ~~`downloads.status` no admite `insufficient_space`~~ — **columna resuelta** en la sesión de §9 (migración `0002_downloads_status_and_git_head`, `packages/runtime/src/persistence`): el `CHECK` ya acepta `insufficient_space`. `DownloadManager.pull()` (`packages/runtime/src/models`, fuera de la zona de §9) sigue sin escribir esa fila — falta conectar el lado de `models/` a la columna ya disponible.
2. El historial de "Descargas" vive en memoria del proceso (`DownloadManager.listAll()`); no sobrevive a un reinicio de la app. `SqlDownloadsRepository.listActiveOrRecent()` ya existe para leer el historial persistido, pero no está conectado a un canal IPC todavía.
3. `numCtx` por defecto por modelo es una preferencia de UI (Centro de modelos/Ajustes, `models.numCtxDefaults`) — sigue sin conectarse a esa preferencia puntual. La sesión de §9 agregó, del lado de `packages/runtime/src/agent`, la pieza que le faltaba a este mecanismo para poder existir (`DefaultNumCtxFor`/`contextPolicyForNumCtx` en `agent/defaults.ts`, más el `RunControllerDeps.numCtxForModel` que esta misma sesión ya traía) — conectar `models.numCtxDefaults` a cualquiera de los dos sigue pendiente de `createRuntime.ts` (doc 16 §4 punto 8, §9.5).
4. Limpieza de estilos inline: hecha en `features/models`, `features/perf`, `features/settings` y `features/onboarding` (archivos `.css` nuevos por feature). Quedan `style={{...}}` en `App.tsx`, `ErrorBoundary.tsx`, `features/chat`, `features/diff`, `features/files`, `features/tasks`, `features/terminal`, `layout/ChatCenter.tsx` y `layout/Sidebar.tsx` — no se tocaron por alcance/tiempo.
5. `electron-builder.yml` ganó un `extraResources` para `resources/model-catalog.json`, pero no se pudo probar contra un empaquetado real: `pnpm --filter @saurio/desktop run build:installer` ya estaba roto antes de esta sesión por un bug de rutas no relacionado (doc 16 §2/MANUAL.md §2, "Estado conocido de esta versión: este paso falla"). En dev (`pnpm dev`/smokes) el catálogo se resuelve y se lee bien (`services/resources.ts`, verificado con capturas reales).
6. No se corrió `pnpm test:eval` (`eval/harness.ts`) en esta sesión — es la zona del otro agente en paralelo (`eval/`) y ya estaba modificado en el working tree al empezar; no se quiso arriesgar un conflicto de merge en un archivo que no es mío.

---

## 9. Cierre de cabos sueltos en `packages/runtime/src/{persistence,tools,agent,context,checkpoint,permissions}` + `eval/` (sesión 2026-09-18, cierre de la noche)

Alcance: exactamente esos módulos y `eval/`; `apps/desktop`, `packages/shared` y la raíz quedaron para otros agentes en paralelo en esta misma sesión (cambios en `packages/shared/src/domain.ts` hechos de forma aditiva mínima, releyendo el archivo antes de cada edición, tal como pide el encargo). Siete cabos sueltos, todos con test nuevo:

### 9.1 Migración 2 (`downloads.status` + `checkpoints.git_head`)

`packages/runtime/src/persistence/migrations/0002_downloads_status_and_git_head.ts`: `downloads.status` admite `insufficient_space` (doc 13 §5 punto 1, doc 16 §8 punto 1) — reconstruye la tabla (SQLite no permite ensanchar un `CHECK` con `ALTER TABLE`; no hace falta el proceso completo de "12 pasos" porque ninguna otra tabla referencia `downloads`). `checkpoints.git_head` (doc 09 §2.2) vía `ADD COLUMN` simple, para §9.3. Probado en `migrations/index.test.ts`: aplica limpio en una base nueva (`user_version` llega a 2) y migra una base existente que solo tenía la migración 1 (fila de `downloads` sembrada antes de migrar sigue intacta, y el `CHECK` viejo se confirma que rechazaba `insufficient_space` antes de migrar).

### 9.2 `expected_pre_hash` sobrevive a un reinicio real (doc 10 §3/§5.2, doc 16 §4 ítem 16)

Antes, `edit_file`/`write_file`/`delete_file` (`tools/builtin/`) comparaban el hash actual del archivo contra `ReadTracker` (un `Map` en memoria del proceso), que un reinicio real borra igual que cualquier otro estado — la columna `tool_calls.expected_pre_hash` existía desde la migración 1 exactamente para este caso, pero nadie la escribía ni la leía.

- **Escritura**: `RunController.executeOneToolCall` (`agent/RunController.ts`) completa `record.expectedPreHash` al construir la fila "write-ahead" de `edit_file`/`write_file`/`delete_file`, usando el puerto opcional `LastReadHashes` (`agent/ports.ts`, nuevo — estructuralmente idéntico a `ReadTracker.lastHash`, para que quien arma `RunControllerDeps` pueda pasar la MISMA instancia que ya inyecta en `createBuiltinTools`). Como la proyección de `tool.registered` (`events/projections/toolCalls.ts`, fuera de esta zona) no escribe esa columna, se completa con un `ToolCallRepository.upsert()` puntual inmediatamente después — mismo patrón que `MessageRepository.markCompacted` para `compacted_by`, y sin repetir el bug de "upsert antes del evento" que ya documentaba este archivo (la fila ya existe para ese momento, así que `upsert()` cae en `ON CONFLICT DO UPDATE`, nunca en un `INSERT` nuevo).
- **Lectura**: `BuiltinToolsDeps.expectedPreHash` (`tools/builtin/deps.ts`, puerto opcional nuevo) + `resolveExpectedHash()` (`tools/builtin/conflictCheck.ts`, nuevo, usado por las tres tools) leen `tool_calls.expected_pre_hash` por `ctx.toolCallId` en vez de (solo) `ReadTracker`. Sin el puerto inyectado, el comportamiento es exactamente el previo (fallback a `readTracker.lastHash`) — no rompe ningún test ni wireo existente.
- `ToolCallRecord.expectedPreHash` (`packages/shared`, additive) + `ToolCallRepository.upsert/get/listByRun` (`persistence/repositories/toolCall.ts`) lo persisten/leen de verdad.
- `eval/harness.ts` cablea ambos lados con la misma instancia de `ReadTracker` y agrega el **paso `(o)`**: un run lee un archivo, queda pendiente de permiso antes de editarlo, se cierra la app (SQLite + `ReadTracker` de ese proceso desaparecen), un actor externo modifica el archivo, se reabre en OTRA instancia y se responde el permiso sin volver a leer — el conflicto se detecta contra `expected_pre_hash` persistido, no contra memoria. **Verificado contra Ollama real, 2/2 corridas.**

### 9.3 `PermissionRequest.noAllowOption/forceWarning` + `RevertPlan.uncoveredEffects/branchChanged/editedBy`

Campos additive nuevos en `packages/shared/src/domain.ts` (releído antes de cada edición, cambio mínimo autorizado por el encargo para el otro agente de esta sesión):

- `DefaultPermissionEngine` (`permissions/engine.ts`) produce `noAllowOption`/`forceWarning` reales para los dos invariantes de doc 06 §5 (comando crítico: ambos en `true`; `git_push`: solo `noAllowOption`) — antes se simulaban con `rememberOptions: []` y el prefijo `COMANDO CRÍTICO:` en `triggeredBy` (que se conservan, no rompen nada). Un `ask` "normal" (regla o default de categoría) no marca ninguno de los dos.
- `FsCheckpointService.planRevert` (`checkpoint/checkpoint-service.ts`) calcula de verdad los tres campos de doc 09 §5.3:
  - `uncoveredEffects`: tool calls `run_command` (`done`/`failed`) del/de los run(s) de la selección cuyo `finishedAt` cae en el rango — vía `CheckpointServiceDeps.toolCalls` (`ToolCallLookup`, opcional).
  - `branchChanged`: compara el `git_head` guardado en `begin()` (vía `GitHeadReader`, `checkpoint/git.ts` nuevo — dos lecturas de solo lectura, `git rev-parse HEAD`/`--abbrev-ref HEAD`, nunca lanza) contra el actual — vía `CheckpointServiceDeps.gitHead` (opcional).
  - `editedBy`: `CheckpointStoreRepository.findLatestFileMatch(relPath, postHash)` (SQLite + fake en memoria, nuevo) busca la fila `checkpoint_files` más reciente de CUALQUIER checkpoint con ese `post_hash` — si existe, el conflicto se atribuye a `{ runId, chatId, at }` en vez de asumir siempre "el usuario editó después".
  - Los tres son opcionales/con default `[]`: sin las deps nuevas, el comportamiento es el previo a esta tarea.
- `eval/harness.ts` cablea `createGitHeadReader()`/`repositories.toolCalls` en el `CheckpointService` del harness (el proyecto fixture no tiene `.git`, así que `branchChanged` nunca dispara ahí — se ejercita igual el camino "sin git", que es el caso normal de doc 09 §7.1).

### 9.4 Batching de `message.delta` (doc 16 §4 ítem 9)

`MessageDeltaBatcher` (`agent/deltaBatcher.ts`, nuevo) agrupa `message.delta` de `content`/`thinking` en ventanas de ~30 ms dentro de `RunController.streamChat`, con `flush()` explícito antes de cualquier evento terminal del turno (`message.done`, mensaje truncado, error) — mismo contenido, mismo orden relativo por `field`, menos filas en `run_events`. `RunControllerDeps.messageDeltaBatchMs` (opcional) para tests. Verificado con Ollama real: en generación real (no el gateway sincrónico de los tests unitarios) sigue emitiendo varios `message.delta` por mensaje largo — es esperable, cada ventana de 30 ms que transcurre durante la generación real dispara un flush — pero menos que uno por token.

### 9.5 Robustez con modelos chicos: pista tras el segundo error idéntico

`LoopDetector.recordToolResultError(toolName, errorText)`/`clearToolResultError(toolName)` (`agent/LoopDetector.ts`) cuentan rachas de "mismo texto de error, misma tool" (a propósito sin exigir args idénticos, a diferencia de `recordToolCall`). Desde la 2ª vez, `RunController.runHandler` le agrega al `ToolResult` una pista concreta ("cambiá algo concreto... antes de volver a intentarlo") además del error crudo, antes de que `recordToolCall`/`recordError` disparen el abort real del `LoopDetector`. Complementa (no reemplaza) el fix específico de `edit_file` ambiguo de la sesión anterior (§7.6): éste es genérico, para cualquier tool.

### 9.6 `numCtx` efectivo por modelo (doc 16 §8 punto 3; distinto del capado de §4 ítem 8/§7.5, que sigue igual)

`context/budgets.ts` (`computeBudget`) ya escalaba los bloques derivados (system/tools/memoria/margen) proporcionalmente a `numCtx` desde antes de esta sesión — lo que faltaba era un DEFAULT de `numCtx` que dependiera del modelo en vez del literal fijo `8192` (medido solo para `qwen3:8b`/`qwen2.5-coder:7b` en este equipo). `agent/defaults.ts` gana:
- `DefaultNumCtxFor` (tipo) + `contextPolicyForNumCtx(numCtx, base?)`: deriva una `ContextPolicy` completa escalando `reserveForResponse`/`repoMapTokens` (los dos campos que `computeBudget` deja fuera a propósito) contra el tier de referencia más cercano (8k/16k/32k, doc 07 §5).
- `createDefaultAgentConfig(workingDir, model, defaultNumCtxFor?)`: tercer parámetro opcional; sin él, comportamiento previo exacto (8192 fijo). El `numCtx` elegido queda en `AgentConfig.contextPolicy.numCtx`, que `RunController.buildEffectiveConfig` ya copiaba tal cual a `EffectiveConfig.numCtx` (y de ahí a `run.effective_config_json`) — "registro en effective_config" no necesitó ningún cambio en el loop de ejecución, solo en cómo se arma el default.
- Complementa, sin superponerse, a `RunControllerDeps.numCtxForModel` (ya existente, agregado en la pasada de integración de escritorio): ese es un override en vivo por run (pensado para `models.numCtxDefaults` de Settings, doc 16 §8 punto 3); `defaultNumCtxFor` es el default de SEED cuando se crea un `AgentConfig` nuevo. Ninguno de los dos está wireado en `createRuntime.ts` todavía (mismo patrón que `modelContextProbe`/`permissionMemory`/`readHashes`, ver §5).

### 9.7 Corridas del harness

`eval/harness.ts` extendido con el paso `(o)` (§9.2) sobre los 17 pasos existentes, total 18. **Dos corridas consecutivas contra Ollama real** (127.0.0.1:11434, Ollama 0.34.1, `qwen3:8b`/`qwen2.5-coder:7b` Q4_K_M):

- **Corrida 1: 17/18 OK** (≈286.6 s). Único fallo: `(i) TextToolProtocol con qwen2.5-coder:7b` — el modelo devolvió, en un mismo turno, tres bloques JSON fenced distintos narrados en prosa (`read_file` ya ejecutado en el turno anterior, luego `edit_file`, un `read_file` de verificación y un `finish`, los cuatro como texto). `scanToolCallBlocks` (doc 16 §7.3: "se busca el ÚLTIMO objeto JSON balanceado con un campo `name`") tomó el último bloque (`finish`) en vez de `edit_file`, así que el run terminó `completed` sin aplicar el cambio. **No es una regresión de esta sesión** (no se tocó `tools/protocols/scanToolCalls.ts`): es la misma clase de variabilidad de modelo que ya documentaba §6 de este archivo para `qwen3:8b` con `edit_file` ambiguo ("en la corrida siguiente... sí lo resolvió"), ahora observada con `qwen2.5-coder:7b` narrando un plan de varios pasos con más de un JSON por turno — un caso que el heurístico de "el último bloque" no cubre cuando hay más de dos JSON en el mismo texto. Se registra como hallazgo de robustez del `TextToolProtocol` con modelos chicos que narran, no como bug de esta tarea; queda para una sesión futura decidir si "el último bloque cuyo `name` es una tool permitida en este turno" sería más robusto que "el último bloque, punto".
- **Corrida 2: 18/18 OK** (≈290.8 s), incluido `(i)` con el mismo modelo y el mismo prompt.
- El paso `(o)` nuevo pasó en las dos corridas, con `expected_pre_hash` real persistido y releído entre instancias de runtime distintas.
- Hallazgo menor, no bloqueante: en las dos corridas, justo después de `(o)`, aparece un `unhandledRejection` (`"The database connection is not open"`, capturado por el handler de nivel superior del harness, no interrumpe nada) — un run en segundo plano de la instancia YA CERRADA de runtime5 sigue una continuación asíncrona que intenta leer `tool_calls` después de `runtime5.persistence.close()`. No afecta el resultado del paso (la aserción se hace sobre `runtime6`, la instancia reabierta) ni de los pasos siguientes; se documenta para no esconderlo, no se investigó más a fondo por alcance/tiempo.

### 9.8 Gates

`pnpm --filter @saurio/runtime run test`: **518 tests en verde + 2 skipped** (antes 472+2 skipped; ~46 tests nuevos entre los siete cabos). `pnpm --filter @saurio/repomap run test`: 12 en verde (sin cambios). `pnpm typecheck` (raíz, `tsc --build`) **verde** al cierre de la sesión: `@saurio/shared`, `@saurio/runtime`, `@saurio/repomap`, `apps/desktop`. A mitad de sesión se vio un error transitorio en `apps/desktop/src/renderer/src/stores/runStore.ts`/`runStore.test.ts` (`Property 'hydratePendingPermissions' is missing...`) — archivos que otro agente estaba modificando en paralelo en este mismo working tree compartido (confirmado por `git status`/`git diff` en su momento, cero superposición con los archivos de esta tarea); se resolvió solo cuando ese agente terminó su cambio, sin que esta tarea tocara nada de `apps/desktop`. `pnpm test` (raíz): **623 tests en verde + 2 skipped** (repomap 12, runtime 518+2 skipped, desktop 93).

---

## 10. Proveedores locales/API: almacén seguro, CRUD real, frontera local/nube (sesión 2026-09-18, `apps/desktop`/`packages/shared`)

Alcance del encargo: `apps/desktop/**` y `packages/shared/**` (puntos 1-6 de doc 18 §3, "qué necesita el host"). `packages/runtime/**` y los archivos de configuración de la raíz/empaquetado eran zona de otros agentes en paralelo en este mismo working tree — los pocos cambios hechos ahí son aditivos mínimos, documentados en el propio código y acá.

### 10.1 Almacén seguro de claves (punto 1)

`SecureKeyStore` (`apps/desktop/src/main/services/providers/SecureKeyStore.ts`): `safeStorage` de Electron (DPAPI en Windows), un único JSON en `userData` (`provider-keys.enc.json`, providerId -> ciphertext base64). `get()`/`last4()` nunca lanzan (una clave ilegible se trata como "sin clave"); `set()` lanza `SecureKeyStoreUnavailableError` si `safeStorage.isEncryptionAvailable()` es `false` — nunca cae a guardar en claro. Deliberadamente sin `import { safeStorage } from 'electron'` en el módulo (mismo criterio que `services/resources.ts`): recibe un `SafeStorageLike` inyectado, real desde `main/index.ts` (único lugar con Electron real). El renderer solo ve `hasApiKey`/`apiKeyLast4` (`ProviderConfig`, `packages/shared/src/domain.ts`) — la clave real nunca cruza IPC en sentido host->renderer. 6 tests unitarios con `safeStorage` mockeado.

### 10.2 Tabla de providers + IPC (punto 2 y 3)

`SqlProvidersRepository` (`apps/desktop/src/main/services/providers/SqlProvidersRepository.ts`): SQL directo sobre la tabla `providers` ya migrada (mismo patrón que `SqlDownloadsRepository`, sin tocar `packages/runtime/src/persistence`). `config_json` (columna libre) guarda `preset`/`label`/`headers` — el preset es solo informativo para la UI, el contrato real de inferencia sigue siendo `Provider.kind`. Canales `providers:list/add/update/remove/test` (`apps/desktop/src/main/ipc/providers.ts`): `add`/`update` guardan/reemplazan/borran la clave en `SecureKeyStore` ANTES de tocar la fila de `providers` (si `safeStorage` no está disponible, no se crea nada a medias); `test` hace `health()` + `listModels()` reales contra el provider ya guardado; `remove` bloquea borrar `ollama` (dos barreras: el handler y el repositorio). 6 tests con un `RuntimeHost` falso (mismo patrón que `registerHandler.test.ts`) + `SqlProvidersRepository.test.ts` contra SQLite real.

`createRuntime.ts` arma `OllamaProvider`/`OpenAICompatProvider`/`AnthropicProvider` reales a partir de lo persistido (`buildEnabledProviders`) y expone `refreshProviders()`/`listProviderConfigs()`/`testProvider()` en `GlobalRuntime`. `models:list` (`ModelManager`) y el chat (`ModelGatewayImpl`) ya aceptaban una lista de providers genérica desde antes de esta tarea — alcanzó con pasarles la lista real y agregarles dos métodos aditivos (`setProviders`, ver 10.6) para poder reconstruirla en caliente sin reiniciar la app.

### 10.3 UI: Ajustes > Proveedores + selector de modelo agrupado (punto 3)

`ProvidersSection.tsx` (reemplaza el estado vacío que dejó la sesión anterior): agregar/editar/probar/(des)habilitar/borrar, con `providersStore.ts` (zustand) como fuente. `ModelSelect.tsx` (nuevo, compartido entre `layout/Sidebar.tsx` y `features/chat/ChatHeader.tsx`): `<optgroup>` por proveedor + badge LOCAL/LAN/NUBE (`.saurio-badge.lan/.cloud`, movidas de `features/models/models.css` a `layout/theme.css` para que estén disponibles sin depender de que el Centro de modelos ya se haya montado).

**Bug real encontrado y arreglado durante la verificación visual** (`SAURIO_SMOKE_SHOT`, ver 10.8): `ProviderRow`/`ProvidersSection` usaban `useProvidersStore((s) => ({ ...varios campos }))` — un objeto literal nuevo en cada render nunca es `Object.is` igual al anterior bajo `useSyncExternalStore` (React 19), y dispara "Maximum update depth exceeded" (mismo bug ya documentado para arrays en `layout/ChatCenter.tsx`, ahora medido de nuevo con un objeto). Fix: un selector por campo, como en el resto del renderer.

### 10.4 Frontera local/nube (punto 4)

- **Confirmación explícita por proyecto**: `chat:create`/`chat:setModel` (`apps/desktop/src/main/ipc/chat.ts`, `enforceLocalityGate` compartida) lanzan `CloudConfirmationRequiredError` (mensaje con prefijo estable `CLOUD_CONFIRMATION_REQUIRED:<proveedor>`, porque `ipcMain.handle` no garantiza que propiedades custom de una subclase de `Error` sobrevivan la serialización) si el modelo es `locality: 'cloud'` y no hay consentimiento persistido (`settings`, scope `project`, key `providers.cloudConsent`). `chatStore.ts` (renderer) lo atrapa, muestra `window.confirm` con el texto exacto pedido por el encargo, y reintenta con `confirmed: true` si el usuario acepta — ese mismo llamado persiste el consentimiento.
- **"Solo local" real**: `models.localOnly` (ya existía como toggle sin efecto, doc 16 §7 pasada anterior) ahora lo lee `enforceLocalityGate` y bloquea cualquier modelo no local, incluso con consentimiento ya dado.
- **Nunca fallback automático**: ya lo garantizaba `ModelGateway.chat()` desde antes de esta tarea (doc 18 §5); no se tocó esa lógica.
- **`audit_log`**: `SqlAuditLogRepository` (`apps/desktop/src/main/services/audit/`) + `ModelGatewayHooks.onNonLocalCall` (cambio aditivo en `packages/runtime/src/gateway/ModelGateway.ts`, ver 10.6) — único punto por el que pasa TODA llamada no local, sin importar el caller (chat normal, compactación nivel 2, etc.), así que no hace falta instrumentar nada más. Verificado real contra OpenRouter (10.8).
- **Badge NUBE**: en la cabecera del chat (ya existía pero pintaba SIEMPRE la clase `local`, sin mirar la localidad real — bug corregido de paso) y junto a cada mensaje del agente (`MessageBubble.tsx`, prop `currentModelLocality`). Limitación documentada explícitamente en el código y en `docs/MANUAL.md` §9.3: el badge por mensaje refleja el modelo VIGENTE del chat, no el que generó ese mensaje puntual — `ChatMessage` no persiste esa asociación por mensaje (requeriría una columna nueva en `messages`, fuera de zona).
- **Tokens de entrada/salida + costo**: `ChatMessage.metrics` (additive, `packages/shared/src/domain.ts`) — el dato YA se persistía (`messages.response_metrics_json`, desde una sesión anterior) pero `MessageRepository`/`ChatMessage` no lo exponían; cambio aditivo de una línea en `packages/runtime/src/persistence/repositories/message.ts`. `MessageMetrics.tsx` (ya mostraba tokens/tok-s en vivo) gana una línea fija "costo: no disponible" — ningún Provider del MVP informa costo en moneda.

### 10.5 Wireo pendiente de doc 16 §5/§7.4/§7.5 (punto 5)

`createRuntime.ts` (`createProjectRuntime`) ahora cablea `permissionMemory`/`modelContextProbe`/`Compactor` real (mismo patrón que `eval/harness.ts` ya probaba, reproducido acá porque `eval/` no es un paquete del workspace) + un `numCtxForModel` nuevo que lee `models.numCtxDefaults` (Ajustes) en cada `prepareAndQueue` — ver 10.6, hook aditivo en `RunController`. `models:downloads` une `DownloadManager.listAll()` (en memoria) con `SqlDownloadsRepository.listActiveOrRecent()` (persistido, ya existía sin canal IPC) para que el historial sobreviva un reinicio. `permission:pending` (nuevo canal) + `RunController.pendingPermissionRequests()` (aditivo) + `runStore.hydratePendingPermissions()` rehidratan la tarjeta de permiso al abrir un proyecto, sin depender de que llegue un evento en vivo (que nunca llega solo tras un reinicio real, doc 10 §5.2).

### 10.6 Cambios aditivos mínimos en `packages/runtime` (fuera de zona, autorizados por el encargo, documentados en el propio código)

- `gateway/ModelGateway.ts`: `ModelGatewayImpl.setProviders()` (reemplaza la lista en caliente) + constructor con un tercer parámetro opcional `ModelGatewayHooks` (`onNonLocalCall`). Ambos opcionales, backward-compatible.
- `models/ModelManager.ts`: `ModelManager.setProviders()`, mismo criterio.
- `agent/RunController.ts`: `RunControllerDeps.numCtxForModel` (opcional, consultado en `prepareAndQueue` ANTES del capado de `capNumCtxAgainstModel` existente) + `RunController.pendingPermissionRequests()` (lectura pura, no muta ningún `LiveRun`, reusa `findPermissionRequest`/`buildFallbackPermissionRequest` ya privados).
- `persistence/repositories/message.ts`: `rowToMessage` ahora lee `response_metrics_json` (columna que ya existía y ya se escribía; solo faltaba leerla de vuelta).

Los cuatro archivos se re-leyeron inmediatamente antes de cada edición (mismo criterio que el otro agente usó para `packages/shared/src/domain.ts`, §9.3); ninguno tuvo conflicto de fusión porque los cambios de esta tarea y los de la sesión §9 (en paralelo) tocaron partes distintas de esos mismos archivos salvo `RunController.ts`, donde ambas tandas de cambios son aditivas y no se solapan en las mismas líneas.

### 10.7 `packages/shared` (mi zona)

`ProviderPresetSchema`/`ProviderConfigSchema`/`ProviderTestResultSchema`/`NonLocalCallAuditEntrySchema` (nuevos) + `ChatMessageSchema.metrics` (additive) + `ResponseMetricsSchema` reubicado antes de `ChatMessageSchema` (dependencia de tipos, mismo contenido) en `domain.ts`. Canales nuevos en `ipc.ts`: `providers:list/add/update/remove/test`, `permission:pending`; `chat:create`/`chat:setModel` ganan `confirmed?: boolean`. `settingsKeys.ts` (nuevo): `NUM_CTX_SETTINGS_KEY`/`CLOUD_CONSENT_SETTINGS_KEY`/`LOCAL_ONLY_SETTINGS_KEY` — antes vivían solo en un archivo del renderer (`features/models/numCtxDefaults.ts`, que ahora re-exporta desde acá) porque el proceso main también necesita leerlas y no debe importar del renderer.

### 10.8 Verificación real

- `pnpm typecheck`/`pnpm test`/`pnpm build` en verde al cierre (root, con el resto del working tree compartido también en verde en ese momento).
- **E2E real contra OpenRouter** (`apps/desktop/src/main/host/createRuntime.providers.e2e.test.ts`, se salta sin `OPENROUTER_API_KEY`): agregar proveedor + `SecureKeyStore.set` real + `refreshProviders()` + `testProvider()` (health+listModels reales) + `models:list` con `locality: 'cloud'` + chat corto con un modelo gratuito (`:free` si `listModels()` trae uno, si no `meta-llama/llama-3.1-8b-instruct`) a través del `ModelGateway` real + verifica `audit_log`. **Verde**, corrido de verdad en esta sesión (nunca se imprimió el valor de la clave).
- **Verificación visual real** (`SAURIO_SMOKE_SHOT`/`SAURIO_SMOKE_CLICK`, con `SAURIO_USER_DATA` aislado): encontró y permitió arreglar el bug de 10.3. `SAURIO_SMOKE_CLICK` gana `scroll=<selector>` (aditivo, `main/index.ts`) para llegar a una sección larga del panel sin depender de la altura de la ventana. Captura real: `docs/capturas/smoke-settings-providers.png` (Ajustes > Proveedores con Ollama sembrado y el formulario de alta abierto).
- No se armó una captura del badge NUBE en un chat real en vivo: requiere abrir un proyecto real + crear un chat + elegir un modelo NUBE de forma interactiva, fuera del alcance del arnés de clicks scripteados (`SAURIO_SMOKE_CLICK` no escribe texto en inputs). La lógica está cubierta por los tests unitarios de `runStore`/`ModelGateway` y por el E2E de OpenRouter (que sí confirma `locality: 'cloud'` de punta a punta).

### 10.9 Pendiente / limitaciones conocidas

- Badge NUBE por mensaje: no es históricamente exacto si un chat cambió de modelo local↔nube (10.4) — requeriría persistir `modelRef`/`locality` por mensaje, columna nueva en `messages`, fuera de zona.
- `chat:create`/`chat:setModel` con locality `'lan'`: quedan bloqueados por "Solo local" pero NO piden confirmación explícita (el encargo solo la pide para NUBE) — es intencional, no un olvido.
- No se agregó un canal IPC para listar `audit_log` desde la UI (el encargo pedía "registrar", no "mostrar"); `SqlAuditLogRepository.listNonLocalCalls()` existe y está probado, listo para un canal futuro si hace falta.
- `docs/capturas` no tiene una captura del selector de modelo agrupado por proveedor en un chat real (ver 10.8).

---

## 11. Cierre de los 9 cabos sueltos restantes + verificación real de empaquetado (sesión 2026-09-18, cierre)

Alcance: todo el repo (único agente activo en esta sesión). Nueve puntos puntuales que este mismo documento venía señalando como pendientes.

1. **Wireo de `readHashes`/`gitHead`/`toolCalls`/`defaultNumCtxFor` en `createRuntime.ts`** (doc 16 §5/§9.2/§9.3/§9.6): `createProjectRuntime` comparte el mismo `ReadTracker` como `RunControllerDeps.readHashes` y como `expectedPreHash` (releído desde `repositories.toolCalls`); `FsCheckpointService` recibe `gitHead: createGitHeadReader()` y `toolCalls: repositories.toolCalls`. `initGlobalRuntime` deriva el `ContextPolicy` de seed del agente builtin desde `models.numCtxDefaults` (`defaultNumCtxFor`) en vez del literal fijo 8192. Mismo patrón que `permissionMemory`/`modelContextProbe`/`Compactor`, que ya estaban cableados desde la sesión de Proveedores (§10.5).
2. **`DownloadManager` persiste `insufficient_space`** (doc 16 §8 punto 1): `pull()` ahora escribe una fila terminal `status: 'insufficient_space'` (visible de inmediato en `listAll()` y en el historial de `models:downloads`) antes de lanzar `InsufficientSpaceError`, en vez de rechazar sin dejar rastro. `DownloadsTab.tsx` la muestra con su propia etiqueta.
3. **`scanToolCallBlocks` elige el primer bloque narrado válido, no el último**: `ToolProtocol.parse()` ahora recibe las tools del turno (mismo `availableTools` que ya se le pasaba a `renderTools()`); el fallback de bloques JSON narrados (sin `<tool_call>`) prefiere el PRIMER bloque que corresponde a una tool EXISTENTE con argumentos válidos según su `argsSchema`, y si ninguno matchea esa pasada estricta, cae al criterio permisivo anterior (cualquier `name` string) pero también en orden primero-a-último. Cierra el hallazgo de robustez de §9.7 (`qwen2.5-coder:7b` narrando 4 bloques en un turno — `read_file`, `edit_file`, `read_file` de verificación, `finish` — donde quedarse con el último (`finish`) cerraba el run sin aplicar el cambio).
4. **`messages.model_ref_json` + visor de `audit_log`**: migración `0003_messages_model_ref` (`ADD COLUMN` simple) agrega la columna; `RunController` persiste el `ModelRef` que efectivamente generó cada mensaje (streaming y mensaje truncado); `MessageBubble` prefiere ese dato histórico sobre el modelo vigente del chat (cae a este último solo para mensajes de antes de la migración). Canal nuevo `providers:auditLog` expone `SqlAuditLogRepository.listNonLocalCalls()` (ya existía, sin canal — §10.9) y `ProvidersSection.tsx` agrega un visor de solo lectura.
5. **`packages/repomap/src/{loader,tags}.ts` ya no derivan la carpeta de grammars/queries de `import.meta.url`**: ganan `setGrammarsDir()`/`setQueriesDir()` (con el cálculo anterior como default, válido solo cuando el módulo corre como archivo fuente real — dev sin bundlear, vitest, `eval/harness.ts` vía `tsx`). `createRuntime.ts` los inyecta una sola vez al arrancar vía `configureRepoMapResources()` (packages/runtime/src/context) + `resolveRepoMapResourceDirs()` (`apps/desktop/src/main/services/resources.ts`), que resuelve `resourcesPath/{grammars,repomap-queries}` en empaquetado o `resources/grammars` + `packages/repomap/queries` en dev. Antes, la cuenta "tres niveles arriba de `import.meta.url`" solo funcionaba por coincidencia de profundidad con `out/main/` (documentado como hack en `electron-builder.yml`) y ni siquiera llegaba a copiar `queries/` al paquete — `hasTagSupport()` habría estado silenciosamente degradado a árbol plano en todo build empaquetado hasta ahora, sin que ningún test lo detectara (nada corre `hasTagSupport` contra una carpeta empaquetada real). `electron-builder.yml` simplificado: `grammars/` queda plano en `resources/grammars` (no `resources/resources/grammars`) y se agrega el `extraResources` de `queries/` (`repomap-queries/`). Además, los smokes (`SAURIO_SMOKE`/`SAURIO_SMOKE_UI`/`SAURIO_SMOKE_SHOT` relativo) escribían dentro de `app.getAppPath()/out`, de solo lectura una vez empaquetado (`app.asar`) — `smokeOutDir()` nuevo en `main/index.ts` resuelve `SAURIO_USER_DATA` si está seteada, si no `app.getPath('userData')` cuando `app.isPackaged`, si no `out/` (sin cambios en dev).
6. **`pnpm lint`**: los 12 errores (`prefer-const`, `no-useless-assignment`, `preserve-caught-error`, `no-unsafe-declaration-merging` en los dos `EventEmitter` tipados de `models/`) y los warnings reales (imports/variables sin uso, un `eslint-disable` fantasma en `ErrorBoundary.tsx` porque `no-console` no está activo en este proyecto, y estado muerto — `setError`/`setCurrentChat` nunca invocados — en `TerminalPanel.tsx`/`Sidebar.tsx`) quedaron todos corregidos sin cambiar comportamiento. `pnpm lint` en verde.
7. **Estilos inline a CSS con tokens**: **parcial, cortado por cambio de prioridad para priorizar la verificación de empaquetado (punto 9).** Convertidos: `App.tsx`, `ErrorBoundary.tsx` (`App.css`/`ErrorBoundary.css` nuevos), `features/chat/ChatPanel.tsx` (empty state), `features/diff/*` (`diff.css` nuevo: `DiffPanel`/`MergeViewHost`/`RevertDialog`), `layout/ChatCenter.tsx` y `layout/Sidebar.tsx` (clases nuevas en `theme.css`). **Queda pendiente para v0.2**: `features/files/{FilesPanel,FileViewer}.tsx` y `features/terminal/TerminalPanel.tsx` todavía tienen `style={{...}}` sin convertir (algunos son valores dinámicos por instancia — padding por profundidad de árbol, ancho de progreso — que quedarían inline de todas formas, mismo criterio ya documentado en `features/models/DownloadsTab.tsx`; el resto es directamente pendiente).
8. **`docs/MANUAL.md`**: la sección de empaquetado ya no dice "este paso falla" (era una descripción vieja de un bug ya corregido en una sesión anterior a esta nota, nunca actualizada); ahora documenta `SaurioLLM-build.cmd`, la variante `-- --dir` vs. el instalador NSIS completo, y remite a la verificación real del punto 9 de abajo (captura + IPC contra Ollama real).
9. **Verificación real del empaquetado**: `pnpm --filter @saurio/desktop run build:installer` corrió limpio (NSIS + `win-unpacked/`, ver detalle abajo). `apps\desktop\release\win-unpacked\SaurioLLM.exe` se lanzó directo desde una terminal bash con `SAURIO_USER_DATA=<carpeta temporal>` — sin necesitar `cmd /c start` ni PowerShell, `exit 0` limpio en cada corrida (el "exit 1 inmediato" que reportaba un agente anterior no se reprodujo en este entorno/sesión; `ELECTRON_RUN_AS_NODE` no estaba seteada). Dos corridas:
   - `SAURIO_SMOKE=1`: `app:ping`/`models:list` responden de verdad contra Ollama real (127.0.0.1:11434, modelos instalados en este equipo: `qwen2.5-coder:7b`, `qwen3:8b`, `gemma4:31b`, `gemma4:26b`), la app cierra sola.
   - `SAURIO_SMOKE_UI=1 SAURIO_SMOKE_SHOT=<png>` (sin `SAURIO_SMOKE`): `rootHtmlLength=7288` (> 0) y captura real guardada (`docs/capturas/smoke-packaged-build.png` — onboarding real detectando Ollama y recomendando modelos locales, UI completa, sin pantalla en blanco).
   - **Hallazgo, no arreglado (fuera del alcance de este punto)**: combinar las tres variables en la MISMA corrida (`SAURIO_SMOKE=1 SAURIO_SMOKE_UI=1 SAURIO_SMOKE_SHOT=<png>`, tal como pedía el encargo textualmente) tiene una condición de carrera real en `apps/desktop/src/main/index.ts`: `installSmokeRecorder` cierra la app 50 ms después de que responden `app:ping`/`models:list` (típicamente bien por debajo de 1 segundo contra Ollama local), mientras que `installUiSmokeCheck`/`installSmokeShot` esperan 1500 ms fijos desde `did-finish-load` antes de leer `rootHtmlLength`/capturar — la app se cierra antes de que esos dos lleguen a correr, y ni `smoke-ui.json` ni el PNG se generan (verificado: exit 0, sin crash, simplemente no le da tiempo). Workaround usado para este punto: correr `SAURIO_SMOKE=1` sola una vez (confirma IPC) y `SAURIO_SMOKE_UI`+`SAURIO_SMOKE_SHOT` sin `SAURIO_SMOKE` en otra corrida (confirma UI/captura) — cubre exactamente el objetivo pedido ("rootHtmlLength > 0 y captura PNG") sin depender de arreglar la carrera. Queda para una sesión futura decidir si vale la pena desacoplar el cierre de `installSmokeRecorder` de los otros dos instaladores de smoke.
   - Verificado en disco: `apps/desktop/release/win-unpacked/resources/grammars/*.wasm` y `resources/repomap-queries/*.scm` existen planos (confirma el punto 5 de arriba contra un empaquetado real, no solo contra el test unitario de `resolveRepoMapResourceDirs`).
   - `ContextResult::kFatalFailure: Failed to create shared context for virtualization` sigue apareciendo en stderr (mismo hallazgo ya documentado en §7/§8: la mitigación de GPU activa por defecto lo absorbe, no impide que la app arranque ni dibuje).
- `docs/capturas` no tiene una captura del selector de modelo agrupado por proveedor en un chat real (ver 10.8).

---

## 12. Centro de modelos: escala de seis niveles, HardwareProbe para iGPU/memoria unificada, usabilidad post-v0.1 (sesión 2026-09-18, cobertura máxima del catálogo)

Alcance del encargo: `packages/runtime/src/models/**`, `resources/model-catalog*.json`, `apps/desktop/src/main/ipc` (solo handlers de `models`), `apps/desktop/src/renderer/src/features/models/**`, cambios aditivos en `packages/shared/src/{ipc,domain}.ts`. Objetivo pedido: que el explorador cubra el máximo de modelos del mercado, los analice contra el hardware real y los clasifique en una escala de seis niveles. **Esta sesión no llegó a implementar la sincronización en vivo del catálogo completo de Ollama ni la búsqueda de Hugging Face** (ver "Pendiente" al final) — dos rondas de feedback real de usuario llegaron a mitad de tarea y se priorizaron sobre continuar el catálogo, siguiendo el mismo criterio que ya usa este documento ("se priorizaron los gaps... sobre features nuevas más grandes, para no dejar nada a medio hacer").

### 12.1 `TierClassifier` (escala de seis niveles)

`packages/runtime/src/models/TierClassifier.ts` (nuevo): `classifyModelTier()` — función pura que recibe `vramNeededBytes/vramAvailableBytes/weightsBytes/ramFreeBytes/freeDiskBytes` (ya medidos/estimados por `HardwareProbe`/`MemoryEstimator`) y devuelve `{ level: 1-6, label, color, explanation, quality }`. Los seis niveles y sus umbrales `[HIPÓTESIS A PROBAR: los cortes numéricos, no la lógica de separación]`:

1. Perfecto (verde) — entra en GPU con margen (`needed ≤ available × 0.85`, `0.70` en iGPU).
2. Muy bueno (teal) — entra justo (`needed ≤ available × 1.05`, `0.90` en iGPU).
3. Usable (amarillo) — los pesos entran en GPU, el KV cache/overhead se reparte con RAM sin excederse mucho (techo `1.3×`, `1.05×` en iGPU — ver hallazgo de visión abajo).
4. Al límite (naranja) — offload parcial significativo (≥30% de los pesos en GPU).
5. Solo CPU / muy lento (rojo) — entra en RAM pero casi sin ayuda de GPU.
6. No recomendado instalar (gris) — no entra ni con toda la RAM, o no hay espacio en disco.

Un resultado `tested` (Banco de pruebas/`model_compat` real para este `hardware_fingerprint`) fuerza el nivel y sube `quality` a `'measured'`, igual que ya hacía `RecommendationEngine` con el badge "probado". `tierForCatalogWeights()` arma el input para un modelo **no instalado** (catálogo/Explorar) con el mismo proxy 15%/512 MiB que ya usaba `RecommendationEngine.estimatedTotalBytes` (duplicado a propósito para no crear una dependencia cruzada entre los dos módulos). 32 tests nuevos (`TierClassifier.test.ts`), incluidos los tres escenarios que pedía el encargo (8 GB de VRAM, 24 GB, solo CPU) más el perfil real de iGPU (ver 12.2).

### 12.2 `HardwareProbe`: iGPU/memoria unificada (Intel/AMD/Apple sin `nvidia-smi`)

Hardware real relevado en un segundo equipo del feedback (Intel Core Ultra 9 288V, 32 GB RAM unificada, iGPU Intel Arc 140V por Vulkan — sin `nvidia-smi`, la app quedaba ciega de VRAM):

- **`parseOllamaInferenceComputeLog()`** (nuevo): parsea la línea `msg="inference compute"` que el propio `ollama serve` loguea por dispositivo (`[VERIFICADO EN DOC OFICIAL: discover/types.go, LogDetails(), repo ollama/ollama]`, formato `slog` con `total`/`available` en `HumanBytes2` — `"18.0 GiB"`/`"17.2 GiB"`, exactamente los valores reales reportados). `HardwareProbe.sample()` la usa como segunda fuente (`measured`) cuando no hay `nvidia-smi`, antes del registro de Windows — inyectada vía el puerto opcional `OllamaInferenceComputeSource` (todavía sin cablear en `apps/desktop`: el encargo dice que el otro agente va a exponer el log real desde `OllamaProcessManager`/`server.log`; hasta que eso pase, `sample()` sigue el camino previo sin romper nada).
- **Fallback de memoria unificada** (nuevo, `assumeUnifiedMemoryFallback`, **apagado por defecto**): sin ninguna fuente real, asume ~55% de la RAM total como techo de VRAM utilizable (`[HIPÓTESIS A PROBAR]`, calibrado contra el ~56% real medido en el equipo #2). Deliberadamente opt-in y restringido a win32/darwin: sin ninguna señal, `gpu: undefined` sigue siendo más honesto que inventar una GPU en una máquina que a lo mejor no tiene ninguna (evita la regresión que hubiera roto el test "sin GPU detectable en plataforma no-Windows: gpu queda undefined").
- `HardwareProfile.gpu` gana `vendor: 'intel'` y `integrated?: boolean` (additive, `packages/runtime/src/models/types.ts` — no es `packages/shared`, sin restricción de aditividad pero se mantuvo igual).

### 12.3 `MemoryEstimator`: proyector de visión no contado + margen mayor en iGPU

Hallazgo real del mismo equipo: `gemma4:26b` (Q4, 15.77 GiB de pesos + ~1.1 GiB de proyector de visión) NO entró en ~17.2 GiB disponibles de la iGPU, pese a que la suma de bytes sugería que sí — el scheduler de Ollama no reserva memoria de trabajo extra para el encoder de visión al decidir el offload. `MemoryEstimator.fits()` gana `VISION_OVERHEAD_BYTES` (1.25 GiB extra cuando `description.capabilities.vision`) e `INTEGRATED_GPU_SAFETY_MARGIN_RATIO` (10% del total en vez de 512 MiB fijos cuando `hardware.gpu?.integrated`) — ambos `[HIPÓTESIS A PROBAR]`, con test de regresión que reproduce el caso real (18.0 GiB total / 17.2 GiB disponible → no `fits_gpu`).

### 12.4 Usabilidad del Centro de modelos (feedback real de un usuario que instaló la v0.1)

Feedback textual: *"no entiendo cómo instalar, seleccionar y saber si tengo modelos"*. Resuelto en `features/models/{ModelsPanel,ExploreTab}.tsx`:

- **Instalados**: badge "en uso en este chat" (compara contra `chats.modelRef` del chat abierto) + botón "Usar en este chat" (`chatStore.setChatModel`); si no hay chat abierto, texto explícito ("Abrí o creá un chat para poder usarlo") en vez de un botón deshabilitado sin explicación. Estado vacío con guía de 2 pasos. Banner "Ollama no está corriendo" con botón "Iniciar Ollama" (canal `ollama:ensureRunning`, agregado en paralelo por otro agente en esta misma sesión — `main/ipc/ollama.ts`/`OllamaProcessManager`; `invoke` envuelto en `try/catch` con instrucción manual de fallback si el canal fallara). La lista de modelos ya no se muestra vacía cuando Ollama está caído: el banner reemplaza al estado vacío.
- **Explorar**: leyenda fija de los seis niveles en español simple (sin "VRAM"/"fitClass"), badge de nivel + explicación de una línea por modelo (`models:catalog` ahora calcula `tier` con `tierForCatalogWeights` muestreando `HardwareProbe` real en cada request), espacio libre en disco visible junto al filtro, botón "Usar este modelo" tanto recién descargado como sobre lo ya instalado.
- `CatalogItemSchema.tier: ModelTierSchema.optional()` (additive, `packages/shared/src/domain.ts`).

**Verificado con capturas reales** (Ollama corriendo, 4 modelos reales instalados: `qwen2.5-coder:7b`, `qwen3:8b`, `gemma4:31b`, `gemma4:26b`) — `docs/capturas/smoke-explorar-tiers-ollama-on.png` y `smoke-instalados-usar-en-chat.png` (no versionadas, `.gitignore: smoke-*.png`, igual que el resto de las capturas de smoke de este documento). **No se verificó visualmente el caso "Ollama apagado"**: hacerlo hubiera requerido detener el proceso real de Ollama de esta máquina (compartido con otro agente activo en la misma sesión) o tocar `createRuntime.ts`/`OllamaProvider` para inyectar una URL falsa (fuera de zona) — la rama de código se revisó manualmente y reutiliza exactamente el mismo `anyProviderDown`/`ollama:ensureRunning` que `StatusBar.tsx` ya ejercita en producción, pero queda como `[HIPÓTESIS A PROBAR]` sin captura propia hasta una sesión con un entorno de Ollama desechable.

### 12.5 Gates

`pnpm typecheck` (raíz) verde. `pnpm --filter @saurio/runtime run test`: 550 tests en verde + 2 skipped (antes 518+2; +32 de `TierClassifier`/`HardwareProbe`/`MemoryEstimator`). `pnpm --filter @saurio/desktop run test`: 132 en verde (incluye tests de otros agentes activos en paralelo en esta sesión). `pnpm exec eslint` sobre los archivos de esta zona: limpio.

### 12.6 Pendiente (alcance original del encargo, no completado esta sesión)

El encargo pedía "cobertura máxima del catálogo" — biblioteca completa de Ollama sincronizada en vivo (scraper tolerante de `ollama.com/library` + `/tags`, caché con TTL, botón "Actualizar catálogo", snapshot generado por `scripts/build-model-catalog.mjs` y commiteado), búsqueda de Hugging Face GGUF (`hf.co/<usuario>/<repo>:<quant>`, formato verificado vigente contra `huggingface.co/docs/hub/en/ollama`), "descargar por nombre" libre, ficha con selector de `num_ctx` (4k/8k/16k/32k), y una UI de Explorar con filtros por fuente/tamaño/nivel y paginado o virtualización para cientos de modelos. **Nada de esto se implementó todavía** — se investigaron y verificaron en vivo las fuentes (`ollama.com/library` devuelve ~240 familias reales, formato de manifest confirmado con capa `application/vnd.ollama.image.projector`, API de HF probada con resultados reales, fixtures reales guardados en `packages/runtime/src/models/fixtures/`) pero se priorizó, en el tiempo disponible de esta sesión, cerrar primero la escala de seis niveles (imprescindible para clasificar cualquier catálogo futuro) y la usabilidad básica reportada por un usuario real. Queda para la próxima sesión de esta zona.

---

## 13. Centro de modelos: cobertura máxima del catálogo, cierre (sesión 2026-09-18, noche)

Alcance del encargo: `packages/runtime/src/models/**`, `resources/model-catalog*.json`,
`scripts/build-model-catalog.mjs`, `apps/desktop/src/main/ipc/models.ts`,
`apps/desktop/src/renderer/src/features/models/**`, cambios aditivos en `packages/shared/src/{ipc,domain}.ts`.
Cierra exactamente el pendiente de §12.6.

### 13.1 Parser tolerante + snapshot commiteado (puntos 1/2 del encargo)

`packages/runtime/src/models/ollamaLibraryParser.ts` (nuevo): regex tolerante sobre el HTML público de
`ollama.com/library` (listado de familias) y `ollama.com/library/<familia>` (variantes con
tamaño/contexto real) — sin librería de DOM nueva (ADR-2). Verificado contra los fixtures reales Y
contra el sitio en vivo, donde encontró y toleró DOS cambios reales de layout que el fixture guardado
(de una sesión anterior) no tenía: el breakpoint de Tailwind del bloque de fila pasó de `md:hidden` a
`sm:hidden`, y el separador visual pasó de "•" (bullet) a "·" (middle dot). Un tercer hallazgo, más
serio: el bloque de la ÚLTIMA variante de una página se extendía sin límite hasta un widget "subí una
imagen" del chat de la propia ficha, y el detector de visión (`/Image/i`) lo matcheaba — `llama3.1:405b`
y `deepseek-r1:671b` (sin visión real) salían marcados `vision: true`. Dos relecturas en vivo de la
MISMA URL devolvieron HTML de longitud distinta entre sí, así que un techo de caracteres fijo no
alcanzaba siempre; el fix real corta en el marcador `id="readme"` (la sección de variantes siempre
termina justo antes, confirmado en 4 relecturas en vivo consecutivas), con un techo de caracteres como
red de seguridad secundaria. 14 tests (incluidos los dos hallazgos de tolerancia como regresión).

`scripts/build-model-catalog.mjs` (+ `.impl.ts`, nuevo): recorre la biblioteca completa con el MISMO
parser (bootstrap fino con `tsx/esm/api` para poder importar el `.ts` de runtime desde un script `.mjs`
de la raíz) y escribe `resources/model-catalog.snapshot.json`. Corrido de verdad esta sesión: **240
familias, 858 variantes, 0 errores de red**, commiteado. `ollamaLibrarySnapshot.ts` (nuevo) define el
esquema zod del snapshot y `mergeSnapshotWithCuratedCatalog()`, que lo fusiona por `name:tag` con el
catálogo curado existente (`resources/model-catalog.json`, sigue siendo la capa de "uso sugerido/notas"
verificada a mano — gana sobre el snapshot en `notes`/`quantization`/`suggestedUse`; el snapshot gana en
tamaño/contexto por ser más fresco). 8 tests.

### 13.2 `OllamaLibraryClient` + `HuggingFaceClient` (puntos 2/3 del encargo)

`OllamaLibraryClient` (nuevo): mismo parser, `getCatalog({ forceRefresh })` con caché inyectable (TTL
24 h — `DEFAULT_LIBRARY_CACHE_TTL_MS`), cae a la caché vencida sin red y al snapshot empaquetado sin
ninguna caché todavía; `resolveExactSize()` para tamaño exacto por tag vía `RegistryClient` (perezoso,
al abrir la ficha — la suma de capas ya incluye la capa `projector`/mmproj de los modelos de visión sin
lógica especial). `FileLibraryCache` (`apps/desktop/src/main/services/models/LibraryCache.ts`, nuevo):
implementación real sobre un JSON en `userData`, nunca lanza con datos corruptos. 11 + 4 tests.

`HuggingFaceClient` (nuevo): `searchModels()` (`huggingface.co/api/models?search=...&filter=gguf`),
`listGgufFiles()` (`?blobs=true`, tamaño real confirmado en vivo esta sesión) con cuantización parseada
del nombre de archivo, `buildOllamaRef()` (`hf.co/<usuario>/<repo>:<quant>`, formato vigente verificado
contra la doc oficial de HF para Ollama). 8 tests contra los fixtures reales ya investigados.

### 13.3 Descarga fuera del registry de Ollama (puntos 3/4 del encargo)

`DownloadManager.pullKnownSize()` (nuevo, aditivo — `pull()` no cambió): para referencias `hf.co/...`
que no tienen manifest Docker v2 que diffear contra `blobs/`, verifica espacio contra el tamaño total
YA CONOCIDO (por `HuggingFaceClient`/`resolveByName`) en vez de restar capas presentes — más
conservador que de más, nunca de menos — y reutiliza el mismo `runPull`/progreso/persistencia que
`pull()` vía un `beginJob()` privado factoreado de ambos métodos. 4 tests.

### 13.4 IPC + wireo (`apps/desktop`)

Canales nuevos (aditivos, `packages/shared/src/ipc.ts`): `models:libraryCatalog` (biblioteca completa
fusionada + estado/nivel, con `forceRefresh` para "Actualizar catálogo"), `models:hfSearch`,
`models:hfFiles`, `models:resolveByName` ("descargar por nombre": valida contra el registry de Ollama
o `hf.co/...`, nunca bloquea el botón "Descargar" si no se pudo confirmar el espacio en disco),
`models:pullExternal` (delega en `pullKnownSize`), `models:tierForSize` (recalcula nivel para un
tamaño ya conocido con el `numCtx` elegido, sin volver a pedir el catálogo completo — usado por el
selector 4k/8k/16k/32k de la ficha). `TierClassifier.tierForCatalogWeights()` ganó un `numCtx` opcional
(default 8192, mismo resultado que antes sin él — verificado con test dedicado): escala linealmente el
proxy de KV cache existente, documentado como `[HIPÓTESIS A PROBAR]` igual que el proxy original.

`createRuntime.ts`/`RuntimeHost.ts` (compartidos, cambio aditivo mínimo documentado en el propio
código, mismo criterio que sesiones anteriores para wireo cruzado de zona): construyen
`OllamaLibraryClient` con `FileLibraryCache` real + fallback al snapshot empaquetado, y
`HuggingFaceClient`. `electron-builder.yml` ganó una entrada `extraResources` para el snapshot (mismo
patrón que `model-catalog.json`), sin la cual no llegaría al build empaquetado.

25 tests nuevos en `apps/desktop` (11 en `ipc/models.test.ts`, mismo patrón de `RuntimeHost` falso que
`providers.test.ts`, más 4 de `FileLibraryCache` y 10 de `models:tierForSize`/handlers restantes).

### 13.5 UI de Explorar (punto 5 del encargo)

`exploreLogic.ts` (nuevo, puro, 20 tests): búsqueda de texto, filtros por uso/nivel/tamaño, tres modos
de orden (`recommended` = nivel ascendente + tamaño ascendente, `name`, `size`), paginado (30 por
página — alcanza para las ~850 variantes sin agregar una librería de virtualización nueva, ADR-2) y
agrupado por familia para la ficha lateral.

`ExploreTab.tsx` (reescrito): fuente de datos pasa de `models:catalog` (16 curados) a
`models:libraryCatalog` (biblioteca completa fusionada), con nota de dónde salió el catálogo mostrado
(sincronizado ahora / en caché / snapshot empaquetado) y botón "Actualizar catálogo"; ficha lateral con
las variantes de una familia + selector de contexto 4k/8k/16k/32k que recalcula el nivel en vivo
(`models:tierForSize`); pestaña separada "Hugging Face" (búsqueda -> archivos .gguf por cuantización
-> descarga); "Descargar por nombre" libre siempre visible arriba (valida con `models:resolveByName`
antes de mostrar el botón "Descargar"). Sin estilos inline nuevos (`models.css`, tokens existentes).

### 13.6 Verificación real

`pnpm typecheck`/`pnpm test`/`pnpm lint`/`pnpm build` en verde al cierre (raíz, con el resto del
working tree compartido con otros agentes activos en esta misma sesión también en verde en ese
momento). `pnpm --filter @saurio/runtime run test`: 650 + 2 skipped (antes 550+2). `pnpm --filter
@saurio/desktop run test`: 177 (antes 132). Snapshot generado de verdad con `pnpm build:model-catalog`
contra `ollama.com` en vivo (240 familias, 858 variantes, 0 errores). Descarga real por nombre de
`all-minilm` (46 MB, progreso real medido hasta ~67 MB/s en esta máquina) y borrado, confirmados contra
`/api/tags` real antes y después — mismo camino que ejercitaría `models:resolveByName` +
`models:pull` + `models:delete` desde la UI.

### 13.7 Pendiente / limitaciones conocidas

1. **Capturas de la UI nueva**: no se tomó una captura de Explorar v2 (biblioteca completa, ficha
   lateral, pestaña Hugging Face) — el smoke visual (`SAURIO_SMOKE_SHOT`) requiere una corrida
   dedicada de la app empaquetada/dev que no se hizo esta sesión por tiempo; la UI se verificó por
   tipos + tests + lectura manual del JSX, no visualmente.
2. **Descarga real de un archivo de Hugging Face** (`hf.co/...` vía `pullKnownSize`): no se verificó
   una descarga real de varios GB de un repo de HF en esta sesión (sí se verificó `searchModels`/
   `listGgufFiles` contra la API real de HF durante el desarrollo, y `pullKnownSize` tiene 4 tests
   unitarios con fakes) — el encargo pedía verificar específicamente `all-minilm` (Ollama), que sí se
   hizo de punta a punta.
3. **`tierForCatalogWeights` con `numCtx`** sigue siendo un proxy (15% de los pesos escalado
   linealmente con el contexto elegido) — no hay `model_info` real para un modelo no instalado, mismo
   límite que ya tenía el proxy original antes de este cambio, ahora declarado explícitamente
   `[HIPÓTESIS A PROBAR]` en el comentario del código.
4. **Paginado, no virtualización**: se eligió paginado de 30 por página en vez de virtualización de
   scroll (ambas opciones las permitía el encargo) — más simple de implementar y testear correctamente
   sin agregar una dependencia nueva; suficiente para las ~850 variantes actuales.
5. La UI de Hugging Face no tiene filtro por nivel/tamaño (el catálogo de Ollama sí) — los resultados
   de búsqueda de HF no siempre traen tamaño sin pedir cada repo individualmente (`?blobs=true` es por
   repo, no hay un batch), así que filtrar por tamaño ahí requeriría N llamadas extra por búsqueda; se
   dejó fuera de esta sesión por alcance.

## 14. Doc 19 — E2a "Mis agentes" y E3a "Delegación desde el chat" (sesión 2026-09-18)

Zona de esta pasada: `packages/runtime/src/{persistence,agent,tools/builtin/delegate*}`,
`packages/shared/**` (aditivo), `apps/desktop/src/main/ipc/agents.ts` + wiring mínimo en
`host/{RuntimeHost,createRuntime}.ts`, `apps/desktop/src/renderer/src/features/agents/**` (nueva) +
stores nuevos, e integración mínima releída antes de cada edit en `RightPanel.tsx`/`ChatHeader.tsx`/
`ChatCenter.tsx`/`AppLayout.tsx`/`ChatMessageList.tsx`/`project.ts`. **E3b (equipos) y E4a
(automatización/proactividad) no se tocaron** — quedan tal como los deja doc 19 §3/§4, sin empezar.

### 14.1 E2a "Mis agentes" — cerrado

- Migración `0004_agent_profiles.ts`: `agents` suma `owner_kind`/`avatar_emoji`/`avatar_color`/
  `description`/`model_mode`/`created_at`/`archived_at` (aditivo, sin CHECK — se valida en zod);
  `agent_memories` nueva, con procedencia (`source_kind`/`confidence`) e índice por
  `(agent_id, project_id)`.
- `AgentRepository` (packages/runtime/src/persistence/repositories/agent.ts) suma
  `getProfile/listProfiles/createProfile/updateProfile/archive/duplicate` sin tocar `rowToConfig`/
  `save` (el agente builtin sigue exactamente igual). `listProfiles` sin filtro devuelve solo
  `owner_kind: 'personal'`, nunca `'worker'`/`'coordinator'`.
- `AgentMemoryRepository` nuevo: `list()` es el único punto que aplica el filtro de privacidad de T09
  (`project_id = ? OR project_id IS NULL`).
- `agent/defaults.ts` suma `createPersonalAgentDefaults` (excluye `delegate` de las tools heredadas
  por defecto); `agent/modelPolicy.ts` (`resolveModelRef`, heurística mínima fixed/auto,
  `[HIPÓTESIS A PROBAR]`) y `agent/personalProject.ts` (proyecto sintético, doc 19 §0) son puertos
  nuevos — `modelPolicy.ts` **no está conectado a `RunController`** todavía (queda como función pura
  testeada, sin wiring de `resolveModelRef` en el loop real — ver pendientes abajo).
- `apps/desktop/src/main/ipc/agents.ts` expone los 7 canales de doc 19 §1.4. `createRuntime.ts` llama
  `ensurePersonalProject()` en el boot; `project:list` excluye el proyecto personal del selector.
- Renderer: `stores/agentsStore.ts`, `features/agents/{AgentsPanel,AgentEditorModal,toolCatalog}.tsx`,
  pestaña "Agentes" nueva en `RightPanel.tsx`. `ChatHeader.tsx`/`ChatCenter.tsx` muestran nombre+avatar
  del agente cuando `chat.agentId` no es el builtin.
- Tests: `agent.test.ts` (T03 + CRUD), `agentMemory.test.ts` (T09), `modelPolicy.test.ts`,
  `personalProject.test.ts`.

### 14.2 E3a "Delegación desde el chat" — cerrado

- Migración `0005_delegation.ts`: `runs.delegation_depth` (default 0) + `chats.origin_run_id`
  (aditivos). `tool_calls.category`/`runs.parent_run_id` ya admitían esto desde la migración 0001
  (placeholders sin productor, doc 17) — no se tocaron.
- `packages/shared`: `DelegationRequestSchema`/`DelegationResultSchema` (domain.ts),
  `PermissionCategory` suma `'delegate'`, `RunEventSchema` suma `'run.delegated'` (con `childChatId`
  agregado — campo aditivo no listado literal en doc 19 §2.3, necesario para que la UI resuelva "ver
  conversación completa" sin escanear el stream del hijo).
- `tools/builtin/delegate.ts`: `ToolDefinition` registrada siempre, nunca en
  `DEFAULT_ALLOWED_TOOLS` — su `handler` genérico lanza si se ejecuta (la orquestación real vive en
  `RunController.runDelegateTool`, interceptada en `runHandler` antes del despacho genérico, mismo
  patrón que `finish`).
- `RunController.runDelegateTool`: valida el pedido, aplica profundidad máxima 1 y máximo 3
  delegaciones por run, resuelve destino (agente existente verificado contra el resolver real, o un
  worker efímero vía el puerto opcional `agentProfiles`), crea chat/run hijo (`this.start()` deriva
  `delegation_depth` solo a partir de `chats.origin_run_id`), espera a que el hijo termine (polling
  sobre `this.live`, con cancelación si se agota `budget.timeoutMs`) y traduce el `finish(summary)`
  del hijo a `DelegationResultSchema` (degrada a texto envuelto si no valida). `gateway.chat()` usa
  `priority: 'subagent'` para cualquier run con `delegationDepth > 0`.
- `permissions/engine.ts`: `defaultForCategory`/`CATEGORY_PRIORITY` suman el caso `'delegate'` (ask
  por defecto) — fix mecánico exigido por la nueva categoría del enum compartido, sin tocar ninguna
  decisión existente de las demás categorías.
- Renderer: `runStore.ts` suma `childRunsByParent`/`childChatIdByRun` desde `run.delegated`;
  `features/chat/DelegationCard.tsx` reemplaza a `ToolCallCard` para tool calls `delegate` en
  `ChatMessageList.tsx`.
- Tests: 6 casos nuevos en `RunController.test.ts` (delegación feliz de punta a punta con verificación
  de `parent_run_id`/`delegation_depth`/`origin_run_id`, worker efímero, sin `agentProfiles`
  inyectado, profundidad máxima, límite de 3 por run, `targetAgentId` inexistente) + `delegate.test.ts`
  + actualización de `tools/builtin/index.test.ts` (11 tools).

### 14.3 Pendiente / limitaciones conocidas de esta pasada

1. **`modelPolicy.resolveModelRef` no está conectado a `RunController.start()`**: la función existe,
   está probada, pero el loop real sigue resolviendo el modelo del run exactamente como antes
   (`chat.modelRef ?? resolvedAgent.model`) — un agente con `model_mode: 'auto'` hoy se comporta igual
   que uno `'fixed'` en la app real. Conectar esto de punta a punta (pasar `deps.resolveModelRef` +
   wirearlo en `createRuntime.ts` con `modelManager.listLoaded()`/`fits()`) queda pendiente; se cortó
   acá para priorizar el resto de E2a/E3a dentro del tiempo de la sesión.
2. **Verificación contra Ollama real: hecha, con un hallazgo real en el camino.** `eval/harness.ts`
   suma los pasos (p) "chat directo con un agente personal" (T04) y (q) "delegación a un worker
   temporal" (T06/T07), corridos de punta a punta contra qwen3:8b real (127.0.0.1:11434). Primera
   corrida: (q) dio `timeout` porque `delegate` es `category: 'delegate'` -> default `'ask'`
   (permissions/engine.ts) y el paso no contestaba ese permiso — no era un bug del runtime, sino que
   al paso de harness le faltaba el mismo `waitForRunState('awaiting_permission')` +
   `answerPermission('allow_once')` que ya usan (g.1)-(g.4). Con el fix: **20/20 pasos OK (278.7s)**,
   corrido dos veces de punta a punta. Evidencia real de (q): el worker se creó con
   `owner_kind='worker'`, el run/chat hijo con `parent_run_id`/`delegation_depth=1`/`origin_run_id`
   correctos, y el `DelegationResultSchema` volvió al padre (`{"status":"completed","summary":"Lista
   de 3 ideas de nombres para una mascota.","artifacts":[...],"nextAction":"..."}`, generado por
   qwen3:8b real, no inventado). Verificación visual adicional (`SAURIO_SMOKE_SHOT`, `SAURIO_USER_DATA`
   aislado, sin Ollama de por medio): la pestaña "Agentes" y el modal "Nuevo agente" se dibujan
   completos contra la app real (capturas no versionadas, revisadas en la sesión).
3. **DelegationCard correlaciona por orden, no por `toolCallId`**: `run.delegated` no lleva
   `toolCallId` (doc 19 §2.3 literal); un run con más de una delegación en el mismo turno o turnos
   distintos se correlaciona con su `childChatId` por orden de aparición entre las tool calls
   `delegate` y los eventos `run.delegated` del mismo run — funciona para el caso común (una
   delegación por run) pero es una aproximación documentada, no una garantía por id exacto.
4. **`budget.maxIterations` de `DelegationRequestSchema` no se aplica**: solo `budget.timeoutMs` se
   usa (cancela el hijo si se agota); `maxIterations` queda sin efecto — el hijo usa el
   `maxIterations` de su propio `AgentConfig`, sin ajustarlo según el pedido del padre.
5. **Sidebar.tsx no tiene la sección "Mis agentes" que pide doc 19 §1.6** — la vitrina completa vive
   en la pestaña "Agentes" del panel derecho (que sí permite "click para chatear"); no se agregó una
   segunda entrada duplicada en la barra lateral para no tocar ese archivo más de lo necesario
   mientras otro agente lo edita activamente en esta misma sesión (layout/Sidebar.tsx).
6. **T10 sin test automático dedicado** ("`Scheduler.status()` nunca reporta más de 1 slot ocupado
   durante una delegación"): necesita un test de integración contra el `Scheduler`/`ModelGateway`
   reales (no el gateway fake de `RunController.test.ts`) — no se agregó esta sesión.

---

## 15. Carga de modelo (oom_load), ModelSelect con estados explícitos, pantalla de inicio, OllamaProcessManager con logs (sesión 2026-09-18, en paralelo con §13/§14)

Alcance del encargo: bloqueos reportados por un usuario real que instaló la v0.1 en una notebook
Intel Core Ultra 9 288V / iGPU Arc 140V (Vulkan, sin `nvidia-smi`) con solo `gemma4:26b/31b`
instalados y reportó "bloqueos". Zona: `apps/desktop/src/main/**` (salvo `services/updater` e
`ipc/models.ts`), `apps/desktop/src/renderer/src/{layout,features/chat,stores}`, el único archivo
`features/models/ModelSelect.tsx`, `packages/runtime/src/{gateway,agent}` (cambios aditivos
mínimos). `packages/runtime/src/models/**`/`features/models/**` (catálogo), `services/updater` y
`main/ipc/agents.ts`/`packages/runtime/src/{persistence,agent/profiles}` eran zona de otros dos
agentes activos en paralelo en este mismo working tree (§13 y §14 de este documento, escritos
durante esta misma sesión) — cada archivo compartido se releyó del disco inmediatamente antes de
editarlo, como pide el encargo; en al menos dos ocasiones un edit ya aplicado apareció revertido en
una relectura posterior (probablemente una operación de git de otro proceso sobre el mismo working
tree) y tuvo que rehacerse — de ahí que esta pasada haya commiteado en unidades más chicas de lo
habitual, una por archivo/grupo tocado, para minimizar la ventana de pérdida.

### 15.1 `oom_load`: detección ampliada + reintento automático con menos capas en GPU

- **`classifyErrorMessage`/`classifyHttpError`** (`packages/runtime/src/gateway/providers/ollama/errors.ts`)
  ampliados con los textos reales de oom en Vulkan/iGPU que el `classifyErrorMessage` anterior (solo
  CUDA: `"out of memory"` con espacios, `"cudamalloc failed"`) no reconocía: `"out-of-memory"`
  (guionado), `"failed to allocate"`, `"model is too large"`, `"ErrorOutOfDeviceMemory"` (enum de
  Vulkan). Fixture real probado (`errors.test.ts`): `"llama-server reported out-of-memory during
  startup: GGML_ASSERT(buffer) failed alloc_tensor_range: failed to allocate Vulkan0 buffer of size
  1072462848"`.
- **`ChatRequest.options.numGpu`** (aditivo, `gateway/types.ts`) mapeado a `num_gpu` en
  `OllamaProvider`/`OllamaChatOptionsSchema` — `undefined` deja el default de Ollama, comportamiento
  previo intacto.
- **`RunController.handleOomLoad`** (`packages/runtime/src/agent/RunController.ts`): en vez de fallar
  directo ante `oom_load`, reintenta con ~75% y ~50% de `block_count` (real, vía el puerto opcional
  nuevo `ModelLayerCountProbe` — `agent/ports.ts`, el host lo implementa envolviendo
  `ModelManager.describeModel` en `createRuntime.ts`, mismo criterio que `ModelContextProbe`) y por
  último `numGpu: 0` (CPU pura); sin el puerto (o si nunca devuelve un valor), un único intento
  directo a `numGpu: 0` — nunca inventa un porcentaje de capas sin saber cuántas hay. Cada paso se
  registra como `Adjustment`/evento `run.adjustment` (visible en `runStore.adjustmentsByRun`) y queda
  en `LiveRun.numGpuOverride`, válido solo para ESE run — "reversible" en el sentido del encargo: un
  run/chat nuevo vuelve a `numGpu` automático. 5 tests nuevos en `RunController.test.ts` (escalera
  completa 75/50/0 con `block_count` conocido, fallback a CPU sin el puerto, agotamiento de la
  escalera, persistencia del ajuste entre turnos del mismo run, "reversible" entre runs).
- **`OomLoadCard`** (`features/chat/OomLoadCard.tsx`, nuevo): cuando un run termina `failed` con
  `oom_load` (la escalera automática ya se agotó), muestra el mensaje real del error y dos acciones —
  "Elegir otro modelo" (`useUiNavStore.requestTab('Modelos')`) y "Reintentar con menos capas en GPU"
  (`run:continue`, que vuelve a correr la misma escalera desde el principio: útil si mientras tanto
  se liberó memoria). Inyectable en modo demo (`demoState.ts`, `?demoState={"oomError":true}`) —
  capturada en `docs/capturas/06-oom-load.png` con el texto real del fixture.
- **"Cargando modelo… mm:ss" + Cancelar** (`ModelLoadingBanner.tsx`, nuevo): `RunState` no distingue
  "cargando" de "generando" (ambos son `'generating'`, doc 05) — se infiere: activo pero sin ningún
  `message.delta` todavía (`runStore.streaming` sin entradas de ese `runId`) durante más de unos
  segundos. `runStore` gana `runStartedAt` (ts del primer `run.state` de cada run) para el
  cronómetro.
- **Pendiente, documentado explícitamente y fuera de zona**: registrar el fallo de carga en
  `model_load_samples`/tabla de compatibilidad ("probado: no entra en este equipo", como pedía el
  encargo) requeriría tocar `packages/runtime/src/models/ModelManager.ts` (`ModelLoadSample` exige
  campos de una carga EXITOSA — `size`/`sizeVram`/`loadMs` reales — no hay forma honesta de rellenarlos
  para un intento fallido sin inventar datos) — zona de la sesión de catálogo (§13), activa en
  paralelo en este mismo working tree. Se deja como puerto futuro análogo a `ModelLayerCountProbe`.

### 15.2 `ModelSelect`: estados explícitos + mejor modelo por defecto

- **`ModelSelect.tsx`** (único archivo tocado en `features/models/`, según el encargo) gana
  `engineState?: 'ready' | 'starting' | 'down'`: `'starting'` → "Iniciando motor local…"; `'down'` →
  "Ollama no está corriendo" + botón "Iniciar" (`ollama:ensureRunning`); sin modelos instalados (y sin
  esos dos estados) → "No hay modelos instalados" + botón "Abrir Modelos". Opt-in: sin `engineState`,
  comportamiento exactamente igual al de antes de esta tarea.
- **`ollamaHealthStore.ts`** (nuevo, `stores/`): un único poll de `provider:health` (8 s) compartido
  entre `Sidebar.tsx` y `ChatHeader.tsx` — antes cada uno hubiera necesitado el suyo (`StatusBar.tsx`
  sigue con su propio poll local, no se tocó para no arriesgar una regresión fuera de esta tarea
  puntual; duplicación menor conocida).
  Auto-refresco cuando el provider vuelve: ya lo daba `modelsStore.subscribe()` (`models:changed`) para
  la lista de instalados; se agregó lo mismo para `models:catalog` en `Sidebar.tsx` (se re-pide cuando
  `ollamaHealthStore.ok` cambia, porque el catálogo depende de poder muestrear hardware real).
- **`defaultModel.ts`** (`pickDefaultModelRef`): orden real ahora — último modelo usado en ESTE
  proyecto y que siga instalado (`pickLastUsedModelRef`, sale de `chatStore` sin canal/columna nueva:
  el chat con `modelRef` más reciente por `updatedAt`) → mejor clasificado por la escala de seis
  niveles para este hardware (`pickBestInstalledModelRef`, cruza `models:catalog` — API PÚBLICA del
  Centro de modelos, sin importar internals de `packages/runtime/src/models/**`/`features/models/**`
  — contra los modelos instalados) → primer instalado (comportamiento previo, sigue siendo el
  fallback final).
- **Nunca enviar a un modelo no instalado**: `ChatPanel.handleSend` valida que `chat.modelRef` (si es
  `locality: 'local'`) siga en `modelsStore.installed` ANTES de `run:start`; si no, banner de error
  accionable en vez de dejar que el run falle varios segundos después contra el provider.

### 15.3 Pantalla de inicio sin chat abierto

`HomeScreen.tsx` (nuevo, `layout/`) reemplaza los dos estados vacíos que había por separado ("Abrí
una carpeta" sin proyecto, en `ChatCenter.tsx`; "Elegí un chat" con proyecto pero sin chat, en
`ChatPanel.tsx`) por uno solo: estado del motor local (`ollamaHealthStore`) y de los modelos
instalados, tres acciones grandes (Abrir/cambiar carpeta, Elegir o instalar un modelo, Nuevo chat) y
un enlace a "Configurar proveedores" (`Ajustes`). `ChatCenter` pasó de recibir `projectId: string |
null` a `project`/`onProjectChange`/`onSelectChat` (igual que ya recibía `Sidebar.tsx`) para poder
disparar esas acciones sin duplicar estado. La barra lateral suma dos accesos directos fijos
("Modelos"/"Ajustes", `useUiNavStore.requestTab`) al pie, pedidos explícitamente por el encargo.
Capturada con Ollama simulado apagado en `docs/capturas/07-motor-apagado.png`.

### 15.4 `OllamaProcessManager`: logs, `stop()`, `inference compute`

- **Captura de stdout/stderr**: con `logsDir` (`hostAdapter.paths.logsDir`), el `ollama serve` que
  ESTA clase arranca escribe en `userData/logs/ollama-serve.log` (append) en vez de `stdio: 'ignore'`.
- **`stop()`**: detiene SOLO el proceso que la clase arrancó (nunca una instancia ajena — antes el
  criterio de "no matar nada" era "no guardar ningún PID"; ahora se guarda el PID únicamente cuando
  es el propio, y se mata explícitamente en `app.on('before-quit', ...)`).
- **`readInferenceComputeLine()`**: expone la línea real `msg="inference compute"` que `ollama serve`
  loguea por dispositivo — primero del log propio, si no en modo attach lee en SOLO LECTURA
  `%LOCALAPPDATA%\Ollama\server.log`. Cablea el puerto `OllamaInferenceComputeSource` que
  `HardwareProbe` ya soportaba desde §12.2 pero que la app real nunca terminó de pasarle
  (`createGlobalRuntime` gana `deps.inferenceComputeSource` opcional).
- **`SAURIO_OLLAMA_URL`** (nueva variable, solo para pruebas): `createRuntime.ts` la usa como
  `OLLAMA_BASE_URL` si está seteada — apunta toda la app (gateway, `ModelManager`, `provider:health`)
  a un puerto vacío para simular "Ollama apagado" de verdad sin tocar una instancia real. Con esta
  variable seteada, el arranque automático de `ollama:ensureRunning` se salta a propósito (si no,
  vería el puerto falso caído e intentaría arrancar un `ollama serve` REAL, exactamente lo que la
  variable existe para evitar). 12 tests nuevos en `ollama-process/index.test.ts` (captura de logs,
  `stop()` con y sin proceso propio, lectura del log propio y del modo attach, `undefined` sin
  ninguna fuente).

### 15.5 Verificación real

`pnpm typecheck`/`pnpm test`/`pnpm lint`/`pnpm build` en verde al cierre (raíz, con el resto del
working tree compartido —  §13/§14 de otras dos sesiones en paralelo — también en verde en ese
momento): typecheck sin errores, **840 tests en verde + 2 skipped** (repomap 13, runtime 650+2
skipped, desktop 177 — más que el conteo de sesiones anteriores por el trabajo en paralelo de §13/§14
además de esta tarea), lint limpio, build genera `out/main`/`out/preload`/`out/renderer`.

- **`SAURIO_SMOKE=1` con Ollama real encendido** (`SAURIO_USER_DATA=<temp>`): `app:ping`/`models:list`
  responden contra Ollama 0.34.1 real (`127.0.0.1:11434`), 4 modelos reales (`qwen2.5-coder:7b`,
  `qwen3:8b`, `gemma4:31b`, `gemma4:26b`), `ollama:ensureRunning` automático detecta que ya estaba
  corriendo (`{ running: true, startedByApp: false }`), la app cierra sola.
- **`SAURIO_OLLAMA_URL=http://127.0.0.1:11999` con `SAURIO_SMOKE_UI`/`SAURIO_SMOKE_SHOT`** (sin
  `SAURIO_SMOKE`, `SAURIO_USER_DATA=<temp>` distinto): la app arranca contra el puerto vacío,
  `models:list`/`models:catalog`/`provider:health` fallan con `connection_refused` de forma prolija
  (sin crashear el proceso), `rootHtmlLength=10567` (> 0) y captura real
  (`docs/capturas/07-motor-apagado.png`) mostrando la pantalla de inicio en rojo + el asistente de
  primer arranque detectando lo mismo + la barra de estado con "Iniciar Ollama". No se mató ni se
  arrancó ningún proceso `ollama serve` real durante esta prueba (el arranque automático se saltó a
  propósito, ver §15.4).
- **Modo demo con `oomError:true`** (`SAURIO_SMOKE_UI`/`SAURIO_SMOKE_SHOT`/`SAURIO_SMOKE_STATE`):
  `docs/capturas/06-oom-load.png`, `OomLoadCard` con el mensaje real del fixture y las dos acciones.
- **No verificado con capturas** (fuera de alcance del tiempo disponible en esta sesión, documentado
  como límite conocido): el estado `engineState: 'starting'` de `ModelSelect` (ventana muy corta,
  típicamente <15s) y el banner "Cargando modelo… mm:ss" con un modelo grande cargando de verdad
  (`ModelLoadingBanner`) — ambos se verificaron por lectura de código + los gates automatizados, no
  con una captura de pantalla propia.

### 15.6 Pendiente / limitaciones conocidas

1. `oom_load` fallido no queda registrado en `model_load_samples`/tabla de compatibilidad — ver
   §15.1, requiere un cambio en `packages/runtime/src/models/**` (zona de otra sesión).
2. El botón "Reintentar con menos capas en GPU" de `OomLoadCard` no fuerza `numGpu: 0` directo — hace
   `run:continue`, que vuelve a correr la escalera automática completa desde `'auto'`. Es la opción
   más honesta dado que la memoria real pudo haber cambiado, pero significa que, si el motivo del oom
   no cambió, el segundo intento tarda lo mismo en volver a fallar (tres reintentos con backoff antes
   de la tarjeta) en vez de ir directo a CPU.
3. `ModelSelect`'s `engineState: 'down'` solo se calcula cuando `installedModels.length === 0` — si
   Ollama está caído pero hay modelos de otro proveedor (LAN/nube) configurados, el selector muestra
   esos con normalidad en vez de señalar que Ollama puntualmente no responde (comportamiento
   considerado correcto: el usuario igual puede elegir un modelo que sí funciona).
4. `StatusBar.tsx` sigue con su propio poll de `provider:health` en vez de usar `ollamaHealthStore`
   (duplicación menor, ver §15.2) — no se tocó para no arriesgar una regresión fuera de esta tarea.
5. `docs/capturas` no tiene una captura de `engineState: 'starting'` ni del banner de carga con un
   modelo real cargando (ver §15.5).

## 16. Bugs reales reportados tras instalar v0.2.0 en una notebook Windows 11 sin NVIDIA (sesión 2026-09-18)

Alcance del encargo: un usuario real instaló la v0.2.0 (Intel Core Ultra 9 288V, iGPU Arc 140V,
Ollama instalado) y reportó cinco problemas. Zona: `apps/desktop/src/main/**`,
`packages/runtime/src/{models,telemetry,gateway}`,
`apps/desktop/src/renderer/src/features/models/**` y stores de modelos — con la excepción explícita
del punto 2 del encargo ("auditá TODOS los child_process... git status; ripgrep; run_command"), que
pidió tocar también `packages/runtime/src/{checkpoint,tools}` y `packages/repomap/src/files.ts`
(fuera de la zona nombrada arriba, pero nombrados literalmente en ese punto). No se tocó
`apps/desktop/src/renderer/src/{layout,App.tsx,theme.css}` (otro agente reorganizando el layout en
paralelo en este mismo working tree).

### 16.1 Causas

1. **Crash al cerrar** (diálogo nativo "A JavaScript error occurred in the main process"): `main/
   index.ts` registraba varios `app.on('before-quit', ...)` sueltos en el orden en que cada pieza se
   construía durante el arranque, no en el orden en que había que apagarlas. `host.dispose()` (cierra
   `saurio.db`) se registraba ANTES que `metricsTicker.dispose()` (que vuelca el minuto de métricas
   en curso a esa misma base) — Electron invoca los listeners de un evento en el orden en que se
   registraron, así que para cuando `metricsTicker.dispose()` corría, la base ya estaba cerrada y
   `SqlMetricsMinuteRepository.flush()` (dentro de `BetterSqlite3Driver.prepare()`) reventaba con
   `TypeError: The database connection is not open` sin capturar. Además, ese diálogo nativo lo
   muestra un listener de `uncaughtException` que Electron registra por su cuenta al arrancar — nunca
   se había reemplazado por uno propio.
2. **Ventanas de consola parpadeando al iniciar**: tres `child_process` reales sin `windowsHide: true`
   — `SystemSampler.sampleNvidiaSmi` (usaba `util.promisify(execFile)` invocado sin tercer argumento
   de opciones, por lo que `windowsHide` nunca se aplicaba; corre cada 2s con el panel de rendimiento
   abierto), `terminal/index.ts::commandExists` (`where`, en cada `terminal:create`) y
   `run_command.ts::commandExists`/`killTree` (`where`/`taskkill`) y `repomap/files.ts::runRgFiles`
   (`rg --files`, en cada apertura/reindexado de proyecto). Además, sin caché, `HardwareProbe.sample()`
   y `SystemSampler.sample()` reintentaban `nvidia-smi` (y, en Windows sin él, PowerShell dos veces
   más: registro + WMI) en CADA llamada — varias por minuto con el panel de rendimiento abierto, o una
   por cada apertura de la pestaña Explorar (`models:catalog`/`libraryCatalog`/`resolveByName`/
   `tierForSize`/`recommend`, que llaman `hardwareProbe.sample()` cada vez) — sabiendo de antemano que
   iban a fallar en un equipo sin NVIDIA.
3. **Modelo descargado que no aparece**: `ModelManager.listInstalled()` cachea la lista de modelos
   instalados por provider (`installedCache`); nada invalidaba esa caché ni emitía el evento
   `models:changed` (ya definido en el contrato IPC y ya escuchado por `modelsStore` del renderer, sin
   que nada en `main` lo emitiera nunca) cuando una descarga terminaba. La UI se quedaba con la lista
   vieja hasta reiniciar la app.
4. **Modelos con "X" / sin poder descargar en Explorar**: `mergeSnapshotWithCuratedCatalog` descartaba
   en silencio (`continue`) toda variante sin `sizeBytes` confirmado — dos casos reales confirmados
   contra `ollama.com/library` en vivo: (a) variantes de NUBE (`gpt-oss:20b-cloud`,
   `gpt-oss:120b-cloud`, etc. — 25 variantes reales en el snapshot de esta sesión), que ollama.com
   nunca les publica un tamaño de descarga porque corren en sus servidores, no en la PC del usuario;
   (b) variantes LOCALES cuyo tamaño falló al parsear el HTML. Las dos desaparecían del catálogo sin
   ninguna explicación en vez de mostrarse con contexto.
5. **Updater**: auditado, ya cumplía lo pedido antes de esta tarea (no verificado hasta ahora con una
   corrida real) — `shouldStartAutoUpdater`/`startAutoUpdater` no bloquean el arranque (fire-and-forget,
   se llama al final de `app.whenReady().then(...)`, después de crear la ventana), y `fileLogger`
   escribe en `userData/logs/updater.log`.

### 16.2 Hecho

1. **Apagado único, ordenado e idempotente** (`apps/desktop/src/main/host/shutdown.ts`,
   `createShutdown()`): para tickers/pollers (`metricsTicker.dispose()`, que incluye el flush del
   minuto en curso) → limpieza sin dependencia de la base (terminales, watchers de archivos, batcher
   de eventos, desuscripción de descargas) → cierra persistencia (`host.dispose()`, ahora idempotente
   con un flag `disposed`) → detiene el Ollama propio. Un único `app.on('before-quit', createShutdown(...))`
   al final de `main/index.ts`, reemplazando los `app.on('before-quit', ...)` sueltos. Guarda adicional
   en `SqlMetricsMinuteRepository.flush()`/`pruneOlderThan30Days()`: si el driver ya está cerrado
   (`TypeError: The database connection is not open`, mensaje verbatim de better-sqlite3), se
   descarta con un `console.warn` en vez de propagar la excepción. Manejador global de
   `uncaughtException` (`process.removeAllListeners('uncaughtException')` + uno propio): durante el
   apagado (`isQuitting`) nunca muestra el diálogo nativo; fuera del apagado muestra un
   `dialog.showErrorBox` propio en vez de depender del listener interno de Electron.
2. **Auditoría de `child_process` completa** (main + runtime + repomap): wrapper único por paquete
   (`spawnHidden`/`execFileHidden`/`execFileSyncHidden` — `apps/desktop/src/main/services/process/
   spawnHidden.ts`, `packages/runtime/src/util/spawnHidden.ts`, `packages/repomap/src/spawnHidden.ts`;
   duplicados a propósito, no hay una dependencia común entre los tres paquetes que no sea
   `@saurio/shared`, que es pura por diseño y no debía ganar código Node). Corregidos:
   `SystemSampler.sampleNvidiaSmi` (ahora `execFileHidden`), `terminal/index.ts::commandExists` y
   `run_command.ts::commandExists`/`killTree` (ahora `execFileSyncHidden`), `repomap/
   files.ts::runRgFiles` (ahora `spawnHidden`). Los call-sites que ya pasaban `windowsHide: true`
   (`checkpoint/git.ts`, `models/CommandRunner.ts`, `tools/builtin/search_code.ts`,
   `services/ollama-process/index.ts`) se dejaron como estaban. Test de grep sobre el código fuente en
   los tres paquetes (`childProcessWindowsHide.test.ts`): falla si algún archivo importa
   `spawn/exec/execFile/execSync/spawnSync/execFileSync` directo de `node:child_process` sin mencionar
   `windowsHide` en ese archivo. Caché de detección de hardware: `HardwareProbe.sample()` cachea el
   resultado del sondeo de GPU (nvidia-smi → log de inference compute de Ollama → registro/WMI →
   memoria unificada) una única vez por instancia, con `refreshGpu()` como refresco manual;
   `SystemSampler` agrega la misma bandera (`gpuProbeAttempted`) con `refreshGpuAvailability()`. El
   `MetricsTicker` ya solo muestreaba con el panel abierto o actividad real del gateway (doc 14 §6/§8,
   no era parte de este bug).
3. **`models:changed` real**: `main/index.ts` ahora invalida la caché de `ModelManager`
   (`listInstalled(true)`) y emite `models:changed` con la lista fresca al terminar una descarga
   (`onDone` de `host.onDownloadEvent`), ANTES de reenviar `download:done` al renderer. `modelsStore`
   ya escuchaba ese evento (sidebar, cabecera del chat vía `ChatCenter`/`ChatPanel`, pantalla de
   inicio vía `HomeScreen`, `RightPanel`, `StatusBar` — todos leen `useModelsStore`) — con la emisión
   real, se actualizan solos sin reiniciar. La pestaña "Instalados" (`ModelsPanel.tsx`) mantiene
   estado local propio (no usa el store) — se le agregó su propio listener de `models:changed` para
   refrescarse igual. "Usar este modelo" ya existía en Explorar tras una descarga (`ExploreTab.tsx`,
   botón condicionado a `status !== 'not_installed'`); no hacía falta agregarlo.
4. **Modelos de NUBE y variantes sin tamaño resuelto**: `ModelCatalogEntry` gana dos campos
   opcionales (`cloud`, `sizeUnresolved` — `packages/shared/src/domain.ts` y `packages/runtime/src/
   models/types.ts`). `mergeSnapshotWithCuratedCatalog` (`ollamaLibrarySnapshot.ts`) ya no descarta
   variantes sin tamaño: detecta NUBE por el tag (`isCloudTag`: literalmente `"cloud"` o terminado en
   `"-cloud"` — señal estable por-variante, confirmada en vivo contra `ollama.com/library/gpt-oss`) y
   las marca `cloud: true`; las que no son cloud pero igual no tienen tamaño quedan `sizeUnresolved:
   true`. `ipc/models.ts::buildCatalogItem` no calcula nivel de la escala para ninguna de las dos (el
   `sizeBytes: 0` de placeholder daría un "Perfecto" engañoso). En el renderer (`ExploreTab.tsx`,
   `exploreLogic.ts`): filtro `showCloud` (`false` por defecto — las variantes NUBE quedan ocultas
   hasta que el usuario las pide con el checkbox "Mostrar modelos en la nube"), insignia NUBE (badge
   `.saurio-badge.cloud`, ya existente en `layout/theme.css` para providers cloud) con texto explícito
   ("se ejecuta en los servidores de Ollama, no en tu PC") y sin botón "Descargar"; la ficha lateral
   (`VariantSidePanel`) resuelve `sizeUnresolved` contra el registry de Ollama al seleccionarse
   (`models:resolveByName`, ya existente) y queda descargable con el tamaño real. Nunca aparece un
   ícono sin explicación.

### 16.3 Verificación real

- `pnpm typecheck`: verde.
- `pnpm test`: **861 tests en verde + 2 skipped** (repomap 14, runtime 655+2 skipped, desktop 192 —
  incluye los tests nuevos de esta tarea: `shutdown.test.ts`, `SqlMetricsMinuteRepository.test.ts`,
  `childProcessWindowsHide.test.ts` ×3, casos nuevos en `HardwareProbe.test.ts`/`system-sampler/
  index.test.ts`/`ollamaLibrarySnapshot.test.ts`/`exploreLogic.test.ts`, y el e2e real de abajo).
- `pnpm lint`: verde.
- `pnpm build`: verde (`out/main`, `out/preload`, `out/renderer`).
- `pnpm --filter @saurio/desktop run build:installer`: verde, genera `release/win-unpacked/
  SaurioLLM.exe` y `release/SaurioLLM-Setup-0.2.0.exe` (firmados con `signtool.exe`, sin certificado
  real — mismo comportamiento ya documentado en `docs/INSTALAR.md`).
- **Smoke del exe empaquetado** (`SAURIO_USER_DATA=<temp>`, `SAURIO_SMOKE=1`): `ExitCode=0`, sin
  diálogo nativo, sin procesos `SaurioLLM.exe` remanentes tras el cierre — reproduce el escenario
  exacto del bug 1 (cierre limpio de la app empaquetada, no solo en `pnpm dev`).
- **Smoke del exe empaquetado con `SAURIO_NO_UPDATE` sin setear** (para verificar el punto 5): el
  updater arranca, loguea `arrancando (isPackaged=true, devFeedUrl=(ninguno))` en
  `<userData>/logs/updater.log`, y la app sigue cerrando limpio (`ExitCode=0`) — no bloquea el
  arranque ni el cierre.
- **Smoke del exe empaquetado con `SAURIO_SMOKE_UI=1`**: `rootHtmlLength=8589` (> 0) — la UI (con los
  cambios de Explorar/Instalados de este punto) sigue renderizando.
- **Descarga real contra Ollama 0.34.1 en `127.0.0.1:11434`** (punto 3, verificado de verdad, no
  simulado): test de integración nuevo `apps/desktop/src/main/host/
  createRuntime.modelsChanged.e2e.test.ts` — descarga `all-minilm:latest` real, confirma que
  `listInstalled(false)` (caché vieja, sin invalidar) sigue sin mostrarlo tras el `done` (reproduce el
  bug), y que `listInstalled(true)` (lo que `broadcastModelsChanged` llama ahora) sí lo muestra sin
  reiniciar nada, y borra el modelo al final (la máquina queda como estaba: `qwen2.5-coder:7b`,
  `qwen3:8b`, `gemma4:31b`, `gemma4:26b`, verificado con `GET /api/tags` después de la corrida).

### 16.4 Pendiente / limitaciones conocidas

1. El scraper de `ollama.com/library` sigue sin manejar el caso de una variante NUBE cuyo tag no siga
   el patrón `"cloud"`/`"*-cloud"` (no se encontró ningún caso así en el snapshot real de 858
   variantes de esta sesión, pero el sitio podría cambiar el formato).
2. La caché de GPU de `HardwareProbe`/`SystemSampler` es indefinida dentro del proceso (hasta
   `refreshGpu()`/`refreshGpuAvailability()`, que ningún canal IPC llama todavía) — no hay un botón
   "Actualizar hardware" en la UI; conectar/desconectar una GPU externa en caliente no se refleja
   hasta reiniciar la app. Fuera de alcance de esta tarea (no reportado por el usuario).
3. No se verificó con capturas de pantalla el checkbox "Mostrar modelos en la nube" ni la insignia
   NUBE (verificado por lectura de código + tests unitarios/build/typecheck, no con una captura
   propia — mismo límite que ya declara §15.5 para otros elementos de UI).
4. `electron-updater` puede spawnear procesos propios (p. ej. `7za.exe` al aplicar un update
   diferencial) — son internos de esa dependencia de terceros, fuera del código fuente auditado en el
   punto 2 del encargo.

### 16.5 Adenda (agregado del director): Explorar mostraba "Página 1 de 1 (0 modelos)" durante la carga

Sobre `docs/capturas/smoke-models-explore.png` (tomada por el agente de layout contra Ollama real, en
esta misma sesión, con el checkbox "Mostrar modelos en la nube" del punto 4 de arriba ya en pantalla —
confirma que la captura es posterior a esos cambios): la pestaña Explorar > "Biblioteca de Ollama"
mostraba "Página 1 de 1 (0 modelos)" sin ningún error visible.

**Investigación** (script puntual contra `createGlobalRuntime`, no commiteado, y el test nuevo de
abajo):
- La resolución de recursos NO estaba rota: con `appPath`/`resourcesPath` de dev (`apps/desktop`,
  `resourcesPath: undefined`) y con los reales del empaquetado (`release/win-unpacked/resources`),
  `readResourceFile('model-catalog.snapshot.json', ...)` encuentra el archivo real y
  `loadOllamaLibrarySnapshot` lo parsea sin error en los dos casos (`familyCount: 240`,
  `variantCount: 858`, snapshot regenerado hoy).
- Con `fetch('https://ollama.com/...')` forzado a fallar (simula "sin red"), `OllamaLibraryClient.
  getCatalog()` cae al snapshot empaquetado real y devuelve `source: 'bundled'` con las 858 variantes
  — el fallback funciona de punta a punta, no solo en el test unitario aislado de
  `OllamaLibraryClient.test.ts` (que ya lo cubría con un snapshot fake en memoria).
- **Causa real**: contra Ollama/red real (sin caché en `userData` todavía — primera vez que se abre
  la app), `getCatalog()` sincroniza en vivo las ~240 familias de `ollama.com/library`
  (concurrencia 6) — **medido en esta sesión: ~13 segundos** (`elapsedMs: 12988` para
  `variantCount: 858`, `source: 'network'`). `ExploreTab.tsx` disparaba ese pedido al montar y, MIENTRAS
  seguía en curso (`loading: true`), la condición que decidía entre "lista" y "estado vacío" no
  distinguía "todavía cargando" de "0 resultados genuinos" — mostraba la MISMA paginación
  "Página 1 de 1 (0 modelos)" en los dos casos. El smoke de captura de pantalla
  (`SAURIO_SMOKE_SHOT`/`SAURIO_SMOKE_CLICK`) espera un margen fijo de ~1.5-2s, muy por debajo de los
  ~13s reales — de ahí la captura con 0 modelos sin que hubiera ningún error ni el catálogo
  empaquetado estuviera roto.

**Arreglado** (`ExploreTab.tsx`): mientras `loading && items.length === 0`, se muestra un estado
"Cargando catálogo…" explícito ("Puede tardar la primera vez... si tarda demasiado o falla, cae al
catálogo incluido con la app") en vez de la paginación vacía; el banner de error suma un botón
"Reintentar" (llama a `refresh(false)` de nuevo).

**Verificación real** (packaged, `SAURIO_USER_DATA` limpio, red y Ollama reales, sin
`SAURIO_NO_UPDATE` afectando esto):
- Captura a ~2.4s de abrir Explorar (antes del fix hubiera mostrado "0 modelos"; con el fix muestra
  "Cargando catálogo…" con la explicación): ver evidencia de esta sesión (script de captura, no
  incluida como archivo commiteado — `docs/capturas/` es zona del agente de layout).
- Captura a ~14s (clicks repetidos para dar tiempo): la sincronización real seguía en curso (>13s
  medidos más arriba con margen); seguía mostrando "Cargando catálogo…" correctamente, nunca "0
  modelos" de forma ambigua.
- `apps/desktop/src/main/host/createRuntime.libraryCatalog.test.ts` (nuevo): con `userData` vacío y
  `fetch` hacia `ollama.com` forzado a fallar, verifica que `getCatalog()` cae al snapshot empaquetado
  real (no un fake) con `variantCount > 500`, contra las dos combinaciones reales de
  `appPath`/`resourcesPath` (dev y el `release/win-unpacked/resources` de un build empaquetado si
  existe en el checkout).

**Conteo real de modelos listados** (evidencia pedida): dev, contra red real, `source: 'network'`,
**858 variantes** en **240 familias**, ~13s. Empaquetado, con red simulada caída, `source: 'bundled'`,
**858 variantes** (mismo snapshot, `release/win-unpacked/resources/model-catalog.snapshot.json`).
