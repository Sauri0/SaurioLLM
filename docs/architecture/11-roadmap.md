# Roadmap: MVP → versión avanzada

Propósito: definir alcance, componentes, criterios de "listo", hipótesis a probar, riesgos y orden de construcción de cada etapa de SaurioLLM, desde el hito 1 hasta la versión con multi-agente.

Leyenda: `[COMPROBADO EN EQUIPO]` `[VERIFICADO EN DOC OFICIAL]` `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]`

---

## 0. Cómo leer este roadmap

Cuatro etapas: **Etapa 0 (smoke tests)** → **MVP (hito 1)** → **v0.2** → **v0.3** → **v0.4 (avanzada)**. No hay plazos en días: el orden es de dependencia técnica y de "qué necesito para poder probar con un modelo real lo antes posible", no de calendario. Cada etapa lista alcance, componentes (nomenclatura de la columna vertebral, en adelante "CV"), criterios de "listo" verificables, hipótesis a probar (con su etiqueta epistémica), riesgos con plan B, y dependencias con la etapa anterior. La sección 16 de la CV (tabla única de alcance) es la fuente de verdad ante cualquier contradicción; este documento la reorganiza en el tiempo pero no la reemplaza.

Corrección aplicada de forma consistente (condición 13a): el registro de tools builtin tiene **10** entradas (`list_files`, `search_code`, `read_file`, `read_output`, `edit_file`, `write_file`, `delete_file`, `run_command`, `task_update`, `finish`), no 8. En modo `plan` el modelo ve 6 de ellas (todas menos `edit_file`, `write_file`, `delete_file`, `run_command`); en modo `agent` ve las permitidas al agente (las 10 por defecto). La guía "6-8 tools" se aplica a agentes personalizados, no como límite duro del sistema.

Dato que deja de ser hipótesis (condición 12, resuelve la pregunta abierta 6 de la CV §20): cuando la app de bandeja de Ollama corre, escucha en `0.0.0.0:11434` y aplica `OLLAMA_CONTEXT_LENGTH=262144` salvo que el request mande `options.num_ctx` `[COMPROBADO EN EQUIPO: server.log 2026-09-18 02:03]`. El intento de cargar `gemma4:31b` con contexto 262144 falló por `cudaMalloc failed: out of memory` tras reservar los compute buffers, con `POST /api/chat` devolviendo HTTP 500 a los 74 s `[COMPROBADO EN EQUIPO: server-1.log 2026-09-17]`. Este roadmap usa ese caso como evidencia real del riesgo "modelo no entra / OOM en carga" (§12 de la CV) y como razón concreta por la que SaurioLLM manda `options.num_ctx` explícito desde el primer turno del MVP, nunca confiando en el default del servidor.

---

## Etapa 0 — Smoke tests de riesgo (previa al scaffolding)

No es una etapa de producto: es la verificación de las cuatro apuestas técnicas de mayor incertidumbre antes de escribir una sola línea de `@saurio/runtime`. Corresponde a la pregunta abierta 3 de la CV §20 y al cierre de la CV ("el siguiente paso, tras la aprobación del usuario... son los smoke tests de riesgo en carpeta temporal"). Se ejecuta en una carpeta temporal fuera de `N:/SaurioLLM`, con instalación de dependencias solo ahí.

**Alcance.** Cuatro pruebas aisladas, cada una un proyecto Node mínimo desechable:

1. `better-sqlite3 13.0.3` y `node-pty 1.1.0` cargan y ejecutan una operación básica en un proceso `main` de Electron 44.4.2 (con y sin `electron-builder install-app-deps`).
2. Una grammar de `tree-sitter-cli >= 0.26` compilada a `.wasm` a mano carga correctamente con `web-tree-sitter 0.27.0` y ejecuta una query `*-tags.scm` sobre un archivo `.ts` real (sin depender de `tree-sitter-wasms 0.1.13`).
3. `AbortController.abort()` sobre un `fetch` sostenido a `POST /api/chat` (`stream: true`) contra Ollama 0.34.1 corta el stream limpiamente del lado del cliente y no deja el proceso `ollama serve` con la generación colgada.
4. Dos requests sucesivos al mismo modelo cargado con distinto `options.num_ctx` — medir si el segundo recarga el runner (tiempo y log) o reutiliza el ya cargado.

**Componentes que se construyen.** Ninguno de producto; solo scripts de prueba descartables.

**Criterio de "listo".** Un resultado sí/no y, si es no, un plan B concreto, para cada una de las cuatro pruebas, documentado antes de tocar `N:/SaurioLLM`.

**Hipótesis a probar (todas `[HIPÓTESIS A PROBAR]`, con su medición):**
- Nativos cargan en Electron 44 sin rebuild manual — se mide con el resultado de la prueba 1 (falla dura si el `require` truena en el proceso empaquetado, no solo en Node puro).
- Incompatibilidad `web-tree-sitter 0.27` / `tree-sitter-wasms 0.1.13` (fuente secundaria) — se mide con la prueba 2; si la grammar propia carga bien, el riesgo queda descartado sin depender del paquete de terceros.
- `abort()` corta el stream sin dejar el servidor colgado en 0.34.1 — se mide con la prueba 3 comparando el log de Ollama antes/después del abort.
- Cambiar `num_ctx` recarga el runner — se mide con la prueba 4 comparando `load_duration` del segundo request contra el primero.

**Riesgos y plan B.**
| Riesgo | Plan B |
|---|---|
| better-sqlite3/node-pty no cargan empaquetados | Fallback documentado en CV: `persistence/driver.ts` prueba `node:sqlite` (RC en Node 24); terminal se declara opcional en el MVP si `node-pty` falla, sin bloquear el resto |
| Grammar propia no compila o no matchea las queries de Aider | Repo map degrada a árbol plano de archivos (ya previsto en `ProjectIndexer`); el MVP puede salir sin repo map real, solo con `list_files`/`search_code` |
| `abort()` no corta el stream en el servidor | `AbortSignal.timeout` por request como red de contención; se documenta como limitación conocida y se prioriza cierre del proceso hijo cuando aplica (no afecta `run_command`, que ya tiene su propio timeout) |
| Cambiar `num_ctx` recarga el runner | Se fija `num_ctx` por modelo dentro de la sesión (ya es la decisión de diseño de la CV §9); esto deja de ser hipótesis y pasa a ser regla dura si el resultado es positivo |

**Dependencias.** Ninguna hacia atrás. Bloquea el inicio del scaffolding del MVP: si la prueba 1 falla sin plan B viable, cambia la elección de shell de escritorio (fuera de alcance de este documento, ver CV §1.2).

---

## Etapa 1 — MVP (hito 1)

### Alcance exacto

Un proyecto, un chat, un agente con modelo Ollama fijo (attach a `127.0.0.1:11434`), modos `plan` y `agent`, las 10 tools builtin, los dos transportes de protocolo de tools (nativo y texto Hermes), permisos completos (categorías, `CommandParser` PowerShell + bash, reglas, protected/critical/bloqueados), checkpoints con diff y revert selectivo, terminal integrada (xterm + node-pty), historial persistente en SQLite con log de eventos y `recover()`, métricas por respuesta y por run, repo map para TypeScript/TSX/JS/Python, compactación de contexto en niveles 0 y 2, lectura de `SAURIO.md`, y un Centro de modelos mínimo (instalados, cargado/no cargado, capabilities, `fits` estimado, badge de localidad).

**Prerrequisito explícito (pregunta abierta 1 de la CV):** un modelo con `capabilities.tools` que entre 100 % en la GPU de 8 GB, descargado manualmente con `ollama pull` (candidatos: `qwen3:8b`, `qwen2.5-coder:7b`). `gemma4:26b` y `gemma4:31b`, los dos modelos hoy instalados `[COMPROBADO EN EQUIPO]`, no son requisito del hito 1: `gemma4:31b` ya mostró OOM al cargar con contexto por defecto `[COMPROBADO EN EQUIPO: server-1.log]`, y ambos quedan como primeras entradas del banco de compatibilidad (etapa v0.3), no como bloqueo del MVP.

### Componentes que se construyen

`AgentRuntime` (`RunController`, `RunStateMachine`, `EventStore`, `LoopDetector`, `recover()`), `ContextManager` (`ContextBuilder`, `TokenEstimator` con calibración `token_calibration`, `Compactor` niveles 0+2, `RepoMapClient`), `ToolSystem` (`ToolRegistry` con los 10 builtins, `NativeToolProtocol`, `TextToolProtocol`, `WorkspaceFs`), `PermissionEngine` (`CommandParser` pwsh/bash, `rules`, `protected.ts`), `CheckpointService` (`BlobStore`, `RevertPlanner`, `diff.ts`), `TaskManager`, `ModelGateway` con `InferenceScheduler` a 1 slot, `OllamaProvider`, `ModelManager` (catálogo, `MemoryEstimator`, `HardwareProbe` bajo demanda), `TerminalService`, `Persistence` (schema completo de la migración 1, WAL, FTS5, `saurio db rebuild`), `ProjectIndexer` (utilityProcess, ts/tsx/js/py), y el shell de Electron completo (`apps/desktop`, IPC tipado, renderer con los paneles de chat, diff, árbol de archivos, terminal, tasks, Centro de modelos mínimo y Settings básico).

### Orden de construcción sugerido dentro del MVP

El criterio es poder correr un turno real contra un modelo cargado lo antes posible, y recién después construir las capas que dependen de tener ese turno funcionando.

1. **`packages/shared`** (enums, `domain.ts`, `events.ts`, `ipc.ts`) y **`Persistence`** (schema de la migración 1 completo aunque la mayoría de las tablas queden vacías, `driver.ts`, migraciones embebidas). No depende de ningún modelo; es la base de todo lo demás y del propio `recover()`.
2. **`OllamaProvider` + `ModelManager` mínimo** (`/api/version`, `/api/tags`, `/api/show`, `/api/ps`, `/api/chat` vía `fetch` + NDJSON + zod, sin passthrough del cliente `ollama` npm) y **`ModelGateway`** con `InferenceScheduler` a 1 slot. Objetivo explícito: poder mandar un `ChatRequest` con `options.num_ctx` explícito a un modelo real y recibir `ChatChunk`s, fuera de cualquier UI, antes de construir el resto del runtime.
3. **`AgentRuntime` esqueleto**: `RunController` + `RunStateMachine` con un set de tools reducido a `finish` solamente, escribiendo `runs`, `run_events` y `messages` en transacción. Objetivo: validar el ciclo completo `run:start → generating → completed` persistido, sin tools todavía.
4. **Tools de solo lectura** (`list_files`, `search_code`, `read_file`, `read_output`) + **`ContextManager` básico** (system prompt inmutable + historial, sin repo map todavía) + **`ToolProtocol`** (nativo primero, texto después) + **`PermissionEngine`** en su rama trivial (`read` siempre `allow`). Objetivo: correr el modo `plan` completo explorando un proyecto real.
5. **`ProjectIndexer` + repo map** (tree-sitter, tags, PageRank, `RepoMapClient`) integrado a `ContextBuilder`. Requiere que la prueba 2 de la Etapa 0 haya dado un resultado (grammar propia u árbol plano como fallback).
6. **Tools mutantes** (`edit_file`, `write_file`, `delete_file`) + **`PermissionEngine`** completo (categorías `write`/`delete`, reglas, protected paths) + **`CheckpointService`** (`begin`/`commit`, `BlobStore`). Objetivo: correr el paso "proponer cambio → autorizar → aplicar" del recorrido de validación #1.
7. **UI de diff** (CodeMirror merge sobre `checkpoint:diff`) y **revert** (`planRevert`/`revert` con conflicto a tres vías).
8. **`Compactor` niveles 0+1+2** (esquema `CompactionSummary`, resumen estructurado vía LLM, ver 07-context-manager.md §7.3), integrado a `ContextBuilder` con `compactAtRatio`/`compactEveryTurns` configurables. Es "Imprescindible para el MVP" (CV §16) pero el recorrido de validación #1 no lo ejercita por ser una conversación corta que no cruza esos umbrales; se construye igual en este punto, antes de sumar la terminal, para no dejarlo relegado a un scaffolding posterior sin paso que lo pida.
9. **`run_command` + `TerminalService`** (node-pty, xterm, `CommandParser` para clasificación). Se deja para después de los pasos 1-8 porque depende de la prueba 1 de la Etapa 0 (riesgo de nativos) y no bloquea validar el resto del loop.
10. **`recover()`** y las transiciones `interrupted`/`orphaned`/`abandoned`. Se implementa una vez que la máquina de estados y el log de eventos ya están ejercitados por los pasos anteriores, porque su prueba de aceptación es justamente interrumpir un run a mitad de una tool ya funcional.
11. **`TaskManager`**, badges del Centro de modelos, métricas por respuesta bajo cada mensaje, y pulido de Settings básico.
12. **Recorrido de validación #1 completo**, corrido tres veces seguidas, como aceptación final del hito.

Esta secuencia prioriza tener un modelo real respondiendo desde el paso 2, y deja los componentes de mayor riesgo de plataforma (terminal, `recover()`) después de que el resto del sistema ya es observable.

### Criterios de "listo" verificables

El criterio central es el **recorrido de validación #1** (CV §15) tomado como prueba de aceptación, con estos pasos concretos y su verificación:

| Paso | Acción | Verificación de "listo" |
|---|---|---|
| 1 | Abrir carpeta de un proyecto real (no vacío) | `projects` tiene la fila con `path` correcto; la UI muestra el árbol de archivos y, si hay cambios sin commitear, el aviso no bloqueante de `git status --porcelain` |
| 2 | Elegir el modelo local (`qwen3:8b` o equivalente) | El selector muestra badge LOCAL, capabilities con `tools: true`, y `fits` estimado; `models` y `providers` tienen filas consistentes con `/api/tags` |
| 3 | Explorar el proyecto en modo `plan` | El run llega a `completed` con un `Plan` estructurado; `tool_calls` de `list_files`/`search_code`/`read_file` están en `done`; ninguna tool mutante fue ofrecida al modelo (el prompt en modo plan no las incluye) |
| 4 | Proponer un cambio en modo `agent` | El modelo emite `edit_file`; la tarjeta de permiso aparece con diff en seco y el motivo ("write → ask, preset balanced"); el run queda en `awaiting_permission` sin ocupar el slot de inferencia |
| 5 | Autorizar | `permission_decisions` registra la decisión; `tool_calls.status` pasa a `approved` |
| 6 | Aplicar | `checkpoints`/`checkpoint_files`/`blobs` tienen las pre/post imágenes; el archivo en disco cambió con el contenido esperado; `runs.metrics_json` quedó poblado |
| 7 | Revisar el diff | La UI de diff muestra antes/después reconstruido desde los blobs, no desde la respuesta del modelo |
| 8 | Deshacer | `checkpoint:revert` restaura el archivo; se crea un checkpoint `kind: 'revert'`; `checkpoints.status = 'reverted'` en el original |
| 9 | Reiniciar la app | `recover()` no encuentra runs activos (`run.recovered` vacío); `chat:history` devuelve el chat completo con mensajes, tarjetas y el checkpoint revertido, sin pérdida de nada escrito antes del cierre |

Criterios adicionales, todos verificables sin ambigüedad:

- **(a)** El recorrido completo pasa **tres veces seguidas** sin intervención manual sobre la base de datos, con `qwen3:8b` u otro modelo que muestre `size_vram == size` en `/api/ps` (100 % en GPU).
- **(b)** Un cierre forzado de la app (`taskkill` del proceso Electron) a mitad de un `run_command` en ejecución deja, al reabrir, esa tool en `orphaned` visible en la UI con diagnóstico, y **nada se re-ejecuta automáticamente**.
- **(c)** El harness `eval/` con 5 tareas fijas corre contra el modelo elegido y la tarea 1 (la más simple: una edición de una línea con `edit_file`) tiene un umbral de acierto ≥ 60 % `[HIPÓTESIS A PROBAR: el umbral es una convención inicial, se ajusta con los primeros resultados reales]`.
- **(d)** `saurio db rebuild` reproyecta `messages` y `tool_calls` de forma idéntica a como estaban antes de borrarlas, a partir solo de `run_events`.
- **(e)** El `Compactor` (niveles 0+1+2, paso 8) se valida con un test unitario/integración dedicado que fuerza `compactAtRatio`/`compactEveryTurns` con una conversación sintética larga, **no** con el recorrido de validación #1, que por ser corto no cruza esos umbrales y no lo ejercita.

### Hipótesis a probar en esta etapa

Tomadas de las etiquetas `[HIPÓTESIS A PROBAR]` de la CV y de los documentos de detalle, con cómo se miden:

| Hipótesis | Cómo se mide en el MVP |
|---|---|
| Calidad de tool calling de modelos 7-8B es suficiente para un loop de agente | Harness `eval/`, tarea 1 como umbral mínimo (criterio c); tasa de re-prompts por error de formato por turno, registrada en telemetría |
| `qwen3:8b`/`qwen2.5-coder:7b` entran 100 % en 8 GiB de VRAM a 16k de contexto | `/api/ps` tras la carga: `size_vram == size`; si no, `model_load_samples` registra el resultado real, no estimado |
| VRAM real de `gemma4:26b`/`31b` con `num_ctx` razonable | No se mide en el MVP (requiere Benchmark, etapa v0.3); el MVP solo registra el fallo de carga ya observado `[COMPROBADO EN EQUIPO]` como antecedente, sin repetir el intento con contexto completo |
| `token_calibration` converge (error ≤ ±5 % tras 3-5 turnos) | Comparación de `TokenEstimator.estimate` contra `prompt_eval_count` real, acumulada en la tabla del mismo nombre |
| `cacheHitRatio` se mantiene alto (objetivo ≥ 85 %) con prefijo estable | Cálculo por turno desde `prompt_eval_cached_count / prompt_eval_count`; visible bajo cada mensaje |
| Cambiar `num_ctx` recarga el runner | Ya cubierta por la Etapa 0; si el MVP observa lo contrario en la práctica, se documenta como corrección |
| `AbortController.abort()` corta el stream sin dejar el servidor colgado | Ejercido en el criterio (b) y en la cancelación manual de un run (`run:cancel`) |
| Tiempo de cold load / cambio de modelo (3-10 s) no rompe la experiencia de un slot | Medido con `load_ms` en `model_load_samples`; el único modelo cargado en el MVP hace que esta hipótesis casi no aplique, pero queda instrumentada para v0.2+ |

### Riesgos y plan B

| Riesgo | Plan B |
|---|---|
| Tool calling errático en 7-8B hace inviable el loop agent | `TextToolProtocol` como alternativa si el nativo falla sistemáticamente; reducir el set de tools del agente por defecto (no el registro) por debajo de 10 para ese modelo específico; el harness `eval/` decide antes de invertir más tiempo en UI |
| Ningún modelo instalado hoy entra 100 % en 8 GiB con `tools` | Descarga manual de `qwen3:8b`/`qwen2.5-coder:7b` (pregunta abierta 1, ya resuelta como prerrequisito); si tampoco entran, bajar a `qwen3:4b` como piso |
| Repo map no arranca (grammars) | Ya cubierto en Etapa 0; fallback a árbol plano no bloquea el resto del MVP, solo empeora la exploración |
| `node-pty`/terminal falla en Electron 44 empaquetado | Terminal se declara opcional para el hito 1 (no está en el camino del recorrido de validación #1, que no usa `run_command` como paso obligatorio salvo en el flujo `agent` completo); `run_command` sigue funcionando vía `child_process.spawn` sin pty aunque la terminal interactiva del usuario no |
| Servidor Ollama de bandeja con contexto 256K y expuesto en red `[COMPROBADO EN EQUIPO]` | `options.num_ctx` explícito en cada request (ya es regla, no ajuste); verificación de `context_length` en `/api/ps` tras cada carga; aviso en el Centro de modelos, sin tocar la configuración de Ollama |
| OOM en carga con contexto grande (ya observado con `gemma4:31b`) | El MVP nunca hereda el contexto por defecto del servidor: `options.num_ctx` viaja explícito y se capea únicamente a `contextMax` del modelo (ADR-7). El valor inicial de `num_ctx` (16k) es el default del perfil/`ContextPolicy` elegido por el usuario, no un ajuste automático `[DECISIÓN DE DISEÑO]` |

### Dependencias

Depende de la Etapa 0 (los cuatro resultados condicionan si hay terminal, si hay repo map real, y si `num_ctx` es realmente fijo por sesión). No depende de ninguna etapa posterior. Deja lista, sin implementarla, la costura para: `source.kind = 'mcp' | 'delegate'` en `ToolDefinition` (tipo existe, sin uso), `runs.parent_run_id` (columna existe, siempre `NULL`), `ToolCallStatus = 'awaiting_input'` (enum existe, sin uso), `Provider.pull`/`Provider.delete` (métodos opcionales sin implementación), y las tablas `downloads`, `model_compat`, `benchmark_runs`, `profiles` (creadas en la migración 1, vacías).

---

## Etapa 2 — v0.2

### Alcance exacto

Modos `ask` y `edit` (filtros triviales sobre el set de tools ya construido). Descarga y eliminación de modelos con progreso, cancelación y verificación de espacio (`DownloadManager`). `OpenAICompatProvider` para LM Studio / llama-server. Panel de rendimiento con muestreo continuo (`SystemSampler` de larga vida) y `metrics_minute`. Perfiles activos (`profiles`, built-in `rapido`/`equilibrado`/`calidad`). `run_adjustments` con evidencia (`evidence_compat_id`, aunque todavía sin `Benchmark` que la produzca de forma sistemática — se llena de forma manual/parcial). Tool `remember` para memoria de proyecto. Chequeo sintáctico post-edición. Repo map extendido a 10 lenguajes más (go, rust, java, c, cpp, c_sharp, css, html, bash, yaml). Detección de hardware ampliada (registro de Windows para VRAM de cualquier vendor, contadores `GPU Engine` para GPUs no NVIDIA).

### Componentes que se construyen

`DownloadManager` (nuevo, dentro de `runtime/models`), `OpenAICompatProvider` (`runtime/gateway/providers/openai-compat`), `SystemSampler` como proceso de larga vida, `profiles` como tabla activa con lectura real desde `AgentConfig.profileId`, extensión de `PermissionEngine` para los modos `ask`/`edit` (ya son solo filtros de tools, no lógica nueva), extensión de `ProjectIndexer` con más grammars, tool `remember` (categoría `write`) y `.saurio/rules/*.md`.

### Criterios de "listo" verificables

- Una descarga de modelo se puede cancelar a mitad de camino y el espacio parcial se libera o queda claramente marcado; si el usuario reintenta, no vuelve a descargar las capas ya completas (salvo que el servidor de Ollama haya reiniciado, caso documentado como no garantizado).
- El panel de rendimiento muestra, para cada métrica, una de `measured`/`estimated`/`unavailable`, nunca un número sin calificar.
- Cambiar de perfil en un chat cambia `num_ctx`/`think`/`temperature` de forma visible en la tarjeta "Config efectiva" del chat, con un botón "usar lo pedido" que crea un run con el valor original si el usuario lo pide.
- `OpenAICompatProvider` completa el mismo recorrido de validación #1 contra un servidor LM Studio local, con métricas marcadas `estimated` donde el formato `/v1` no da duraciones.

### Hipótesis a probar en esta etapa

- Reanudación de descargas tras cancelación funciona; tras reinicio del servidor Ollama, no está garantizada `[VERIFICADO EN DOC OFICIAL: api.md + server/images.go]` — se mide intentando ambos escenarios y documentando cuál ocurre en la práctica.
- El acumulado de deltas de tool calls por `index` en `OpenAICompatProvider` reconstruye correctamente llamadas fragmentadas — se mide comparando contra el mismo prompt en `OllamaProvider` nativo.
- Los perfiles built-in (`rapido`=`qwen3:4b`, `equilibrado`=`qwen3:8b`/`qwen2.5-coder:7b`, `calidad`=`gemma4:26b`) son razonables en tok/s y calidad percibida — es una hipótesis fuerte hasta que exista Benchmark (v0.3); en v0.2 se documenta como sugerencia, no como medición.

### Riesgos y plan B

| Riesgo | Plan B |
|---|---|
| Reanudación de pulls no sobrevive reinicio del servidor | Se comunica como limitación conocida en la UI de descargas, sin prometer resiliencia que Ollama no da |
| `OpenAICompatProvider` no expone duraciones reales | Todas sus métricas quedan `estimated`; no se bloquea el uso, solo se etiqueta correctamente (principio 6 de la CV) |
| Perfiles mal calibrados generan expectativas equivocadas de velocidad | Ningún número de tok/s se muestra como medido hasta que exista una fila en `model_compat` (eso llega recién en v0.3); hasta entonces el perfil "calidad" muestra advertencia explícita |

### Dependencias

Requiere el MVP completo y estable (en particular `ModelGateway`/`Provider` como interfaz, para que `OpenAICompatProvider` se sume sin tocar el runtime; y `AgentConfig.profileId`, que ya existe como columna desde la migración 1). No depende de v0.3.

---

## Etapa 3 — v0.3

### Alcance exacto

Banco de pruebas (`Benchmark`) con `model_compat` y `benchmark_runs` como único escritor. `RecommendationEngine` sobre el catálogo curado y `model_compat`. Modo managed de Ollama (`OllamaProcessManager`) como alternativa opcional al modo attach, sin tocar nunca la instancia de bandeja. `McpClient` con el SDK 1.30 como cliente MCP, tools registradas como `mcp__<server>__<tool>` en el `ToolRegistry` ya existente, sin cambios en el runtime. Shadow repo (`GIT_DIR` externo) como detector — no reversor — de cambios hechos por comandos dentro del workspace.

### Componentes que se construyen

`Benchmark` (`protocol.ts`, `suites/`) usando `ModelGateway.chat` con `priority: 'benchmark'` y `ModelManager` para `load`/`unload`; `RecommendationEngine` (función pura, sin estado propio, sobre `models` × `resources/model-catalog.json` × `model_compat`); `OllamaProcessManager` (`services/ollama-process`); `McpClient` (`runtime/mcp/McpConnection`).

### Criterios de "listo" verificables

- Correr la suite de velocidad del Banco de pruebas contra `qwen3:8b` y `gemma4:26b` produce una fila en `model_compat` para cada uno, con `hardware_fingerprint` calculado, y el Centro de modelos muestra "Probado el DD/MM: X tok/s" **solo** para esas combinaciones exactas de modelo/`num_ctx`/`kv_cache_type`/hardware.
- `RecommendationEngine` da una respuesta distinta antes y después de que exista `model_compat` para un modelo (antes: estimado y etiquetado como tal; después: "probado").
- Un servidor MCP stdio de prueba (por ejemplo un servidor de archivos de referencia) expone sus tools en el chat con la categoría de permiso `mcp`, sin que el `AgentRuntime` haya necesitado cambios de código para reconocerlas — solo el registro dinámico vía `ToolRegistry.onChanged`.
- El modo managed levanta `ollama serve` en `127.0.0.1:11435` con un `OLLAMA_MODELS` elegido por el usuario, y la instancia de bandeja en `11434` sigue intacta y no se reconfigura ni se detiene.
- El shadow repo detecta un archivo modificado por un `npm install` o similar corrido desde `run_command`, lo señala en la UI como "cambiado por un comando, no por el agente", y **no** ofrece revertirlo como si fuera un checkpoint de archivo (evita prometer una reversión que el diseño no garantiza, CV §13).

### Hipótesis a probar en esta etapa

Estas son las hipótesis que el MVP y v0.2 dejaron abiertas por falta de instrumento de medición:

- **tok/s real** de `qwen3:8b`/`qwen2.5-coder:7b` a 16k y de `gemma4:26b`/`31b` con `num_ctx` razonable (no 256K) — se mide con la suite de velocidad del Banco de pruebas, mediana + IQR sobre 5 corridas con warm-up descartado.
- **Si `gemma4:26b` (MoE) es usable con offload de experts a RAM** — se mide con la misma suite, comparando `offload_ratio` y `gen_tps` contra el caso 100 % GPU; el antecedente de OOM de `gemma4:31b` con contexto completo `[COMPROBADO EN EQUIPO]` es la razón por la que esta prueba se corre siempre con `num_ctx` acotado (por ejemplo 8k), nunca con el default de 256K.
- **Compatibilidad de tool calling por modelo** vía la suite de calidad opcional (8-10 tareas deterministas, incluida una `edit_file` con diff esperado).
- **Estabilidad del `hardware_fingerprint`** entre corridas (mismo resultado si no cambió digest/driver/Ollama/VRAM total).

### Riesgos y plan B

| Riesgo | Plan B |
|---|---|
| El Banco de pruebas da resultados muy variables (térmica, procesos ajenos en GPU) | Se reportan mediana + IQR, nunca un único número; limitaciones declaradas en la UI (ya previsto en CV §19) |
| Drift de la especificación MCP entre 1.30 y versiones más nuevas | `McpConnection` propia y aislada detrás de `ToolDefinition`; degradar a "servidor no compatible" sin afectar tools builtin |
| Modo managed compite por VRAM con la instancia de bandeja si ambas cargan modelos a la vez | El modo managed se ofrece solo como alternativa explícita, nunca simultánea por defecto; se advierte en la UI si ambas instancias están activas |
| `gemma4:26b`/`31b` resultan no usables ni con offload | Se documenta como resultado válido del Banco de pruebas (no todo modelo instalado tiene que servir); `RecommendationEngine` los desrecomienda con motivo explícito |

### Dependencias

Requiere `ModelGateway`/`ModelManager` del MVP y el modo attach como base de comparación. `OllamaProcessManager` es independiente de `Benchmark` y `McpClient` (se puede construir en paralelo). `RecommendationEngine` depende de que `Benchmark` ya produzca `model_compat`, aunque puede dar recomendaciones basadas solo en estimación antes de eso (ya lo hace desde el MVP, sin el badge "probado").

---

## Etapa 4 — v0.4 (avanzada)

### Alcance exacto

Multi-agente secuencial con tool `delegate` y `runs.parent_run_id` (la columna ya existe desde la migración 1). N slots de inferencia configurables. Providers cloud con frontera explícita (`Locality = 'cloud'`, autorización por proyecto, nunca fallback automático local→nube). Memoria persistente más rica sobre `project_memory`. `fileScope` en `AgentConfig` (ya existe el campo). Hooks estilo `PreToolUse`. Embeddings opcionales como complemento del repo map. Auto-update firmado de la aplicación.

### Componentes que se construyen

Extensión de `AgentRuntime` para que el `run.state → completed` de un subrun se traduzca en el `ToolResult` de la tool `delegate` del run padre (mecanismo ya descripto en CV §2.1, sin construir hasta acá). Extensión de `InferenceScheduler` a N slots con la misma interfaz (`acquire`/`release`) que ya usa el MVP con 1 slot. `CloudProvider` (nuevo, implementa `Provider`). Sistema de hooks sobre los puntos de extensión ya definidos por los eventos (`RunEvent`).

### Criterios de "listo" verificables

- Una tarea delegada a 3 subagentes con 1 slot configurado se serializa correctamente (misma UI, misma máquina de estados, sin cambios visibles salvo el tiempo en cola) — verifica que la separación entre organización lógica y slots físicos (CV §14) sea real y no solo declarada.
- La misma tarea con 4 slots hacia un provider cloud corre en paralelo, medible por los timestamps de `run_events` de cada subrun.
- Un run con `authorizedLocality = ['local']` rechaza explícitamente cualquier intento de resolver un `ModelRef` con `locality: 'cloud'`, sin fallback silencioso.

### Hipótesis a probar en esta etapa

- Calidad de la delegación (Lead → Coder/Reviewer) con modelos locales chicos, dado que en el MVP y v0.2/v0.3 todos los roles comparten el mismo modelo con distinto system prompt — se mide con el mismo harness `eval/`, extendido a tareas que requieren coordinación entre roles.
- Si conviene un segundo modelo distinto para el Reviewer (batch, al final) en vez de reusar el mismo modelo — se mide comparando `quality_score` de tareas revisadas por el mismo modelo contra un modelo más grande en modo batch.

### Riesgos y plan B

| Riesgo | Plan B |
|---|---|
| Delegación entre agentes locales chicos da resultados pobres | Empezar con delegación de tareas mecánicas (por ejemplo, ejecutar y resumir tests) antes que de diseño; permitir desactivar la delegación y volver a un solo agente sin perder el resto de la app |
| N slots satura una GPU de gama media si el usuario los sube sin criterio | El valor por defecto sigue siendo 1 para providers locales con VRAM < 24 GB (regla ya fijada en el MVP); subir a N es una acción explícita del usuario, nunca automática |

### Dependencias

Requiere el MVP completo (la columna `parent_run_id`, el campo `fileScope`, y el tipo `source.kind = 'delegate'` ya existen desde la migración 1 sin usarse — ver "costura lista" abajo). Se beneficia de que v0.3 ya haya dado datos de `model_compat` para elegir qué modelo usa cada rol.

---

## Qué queda explícitamente fuera del MVP y qué costura queda lista

| Fuera del MVP | Etapa que lo agrega | Costura ya lista en el MVP |
|---|---|---|
| MCP como cliente de tools | v0.3 (`McpClient`) | `ToolDefinition.source: { kind: 'mcp'; serverId: string }` existe en el tipo desde el día 1; `ToolRegistry` ya es el registro único donde builtin, MCP y `delegate` conviven; `PermissionCategory.mcp` existe en el enum |
| Multi-agente / subagentes | v0.4 (`delegate`, N slots) | `runs.parent_run_id` es columna desde la migración 1; `ToolDefinition.source: { kind: 'delegate' }` existe en el tipo; `InferenceScheduler.acquire/release` ya es la única forma de tomar un slot, lista para más de uno |
| Embeddings / vector store | v0.4 (opcional, complemento del repo map) | Ninguna: la decisión de diseño es no depender de un segundo modelo en GPU; si se agrega, entra como una fuente más de `ContextBuilder`, no como reemplazo del repo map basado en tree-sitter + PageRank |
| Otros providers (LM Studio, llama.cpp / OpenAI-compatible) | v0.2 (`OpenAICompatProvider`) | La interfaz `Provider` (CV §5) es el único contrato que `ModelGateway` conoce; `providers/*` solo se importa desde `gateway/` (regla de imports, CV §2) |
| Cloud | v0.4 (`CloudProvider`, N slots) | `Locality` incluye `'cloud'` desde el enum inicial; `ChatContext.authorizedLocality` y el chequeo de rechazo en `ModelGateway` ya existen aunque en el MVP la única localidad autorizada sea `'local'`; `settings.localOnly` ya está previsto como interruptor duro |
| Banco de pruebas / calidad medida por modelo | v0.3 (`Benchmark`) | Las tablas `model_compat` y `benchmark_runs` existen desde la migración 1, vacías; `ModelManager` ya lee (nunca escribe) `model_compat`, de modo que activar `Benchmark` no cambia ninguna lectura existente |
| Descarga y eliminación de modelos | v0.2 (`DownloadManager`) | Tabla `downloads` existe desde la migración 1; `Provider.pull`/`Provider.delete` son métodos opcionales ya declarados en la interfaz |
| Perfiles activos y ajustes con evidencia | v0.2 / v0.3 | Tabla `profiles` existe desde la migración 1; `AgentConfig.profileId` y `EffectiveConfig.profileId` ya están en las interfaces; `run_adjustments.evidence_compat_id` ya es una columna nullable |
| Modo managed de Ollama | v0.3 (`OllamaProcessManager`) | `providers.mode` (`attach`/`managed`) es columna desde la migración 1; el modo attach del MVP ya trata la ruta de `OLLAMA_MODELS` como detectada, no como propia, lo que evita reescribir esa lógica al agregar managed |

---

## Imprescindible para el MVP

Repetido aquí en forma de checklist de cierre de etapa, sin contradecir la tabla de la CV §16, que sigue siendo la fuente de verdad ante cualquier ambigüedad:

- Las 10 tools builtin, dos transportes, `WorkspaceFs`, truncado nivel 0, `tool-outputs/`.
- `RunController`, `RunStateMachine`, `LoopDetector`, `EventStore`, `recover()`, cancelación, `run:continue`.
- Presupuestos de contexto a 16k, `TokenEstimator` calibrado, compactación 0+2, `SAURIO.md` de lectura.
- Repo map ts/tsx/js/python con fallback a árbol plano.
- `ModelGateway` con camino único, 1 slot, `OllamaProvider` completo (`/api/version, tags, show, ps, chat`).
- `ModelManager` con catálogo, capabilities, poller de `/api/ps`, `MemoryEstimator` etiquetado, `HardwareProbe` bajo demanda.
- `PermissionEngine` con modos `plan`/`agent`, categorías completas, `CommandParser` pwsh+bash, protected/critical/bloqueados.
- `CheckpointService` completo con revert reversible.
- `TerminalService` (con el riesgo de nativos ya cubierto en la Etapa 0).
- Persistence con el schema completo de la migración 1 y `saurio db rebuild`.
- El recorrido de validación #1 pasando tres veces seguidas.

## Previsto para más adelante

Ver la tabla de "qué queda fuera del MVP" arriba, que ya lista etapa destino y costura lista para cada punto; no se repite acá para no duplicar información que puede desincronizarse.

---

## Nomenclatura agregada

Ninguna. Este documento reutiliza únicamente componentes, tablas, columnas, interfaces, tipos, eventos y canales IPC ya nombrados en la columna vertebral (secciones 2 a 9 y 15 a 20). La única adición es organizativa, no de código: "Etapa 0" como nombre de la fase de smoke tests que la CV menciona en su cierre y en la pregunta abierta 3, pero no nombra como etapa formal del roadmap de la sección 10.

## Desvíos respecto de la columna vertebral

1. **Qué:** la CV §10 presenta el roadmap como una tabla de cuatro filas (MVP, v0.2, v0.3, v0.4) sin una etapa previa explícita para los smoke tests, aunque el cierre del documento y la pregunta abierta 3 sí los mencionan como paso obligatorio antes del scaffolding. **Por qué:** este documento los nombra "Etapa 0" para poder darles alcance, criterio de "listo" y plan B con el mismo formato que el resto de las etapas, en vez de dejarlos como una mención suelta; no cambia ninguna decisión de la CV, solo la hace verificable en el mismo formato que pide el brief de este documento.
2. **Qué:** se reordena la construcción interna del MVP (sección "Orden de construcción sugerido") en 11 pasos, mientras que la CV §16 presenta el alcance del MVP como una tabla de componentes sin orden temporal. **Por qué:** el brief de este documento pide explícitamente "orden de construcción sugerido dentro del MVP (qué se hace primero para poder probar temprano con un modelo real)"; la CV no lo especifica, así que se dedujo del propio flujo de dependencias descripto en sus secciones 2, 6 y 9 (por ejemplo, `ModelGateway`/`OllamaProvider` no dependen de `AgentRuntime`, así que pueden probarse antes; `recover()` solo es verificable una vez que hay tool calls reales corriendo).
3. **Qué:** se citan como `[COMPROBADO EN EQUIPO]` los datos del relevamiento del 18/09 (contexto 256K por defecto en modo attach, exposición en `0.0.0.0`, OOM de `gemma4:31b`) que en partes de la CV (por ejemplo el resumen ejecutivo y el riesgo correspondiente en §11) todavía aparecen etiquetados como `[HIPÓTESIS A PROBAR, relevamiento pendiente de confirmar]`. **Por qué:** la condición 12 del encargo resuelve explícitamente la pregunta abierta 6 de la CV §20 de forma afirmativa y pide reemplazar esa etiqueta por `[COMPROBADO EN EQUIPO]` donde corresponda; este documento aplica esa corrección de forma consistente.
4. **Qué:** se usa "10 tools builtin" en todo el documento en vez de "ocho tools builtin". **Por qué:** corrección conocida de la condición 13(a); la propia tabla de la CV §10 y la carpeta `src/tools/builtin/` de la CV §3 ya listan 10, así que el desvío es solo respecto del resumen ejecutivo de la CV, no de su fuente de verdad estructural.

## Preguntas abiertas

Ninguna pregunta nueva que cambie el diseño. Las preguntas 1, 3 y 5 de la CV §20 condicionan directamente el arranque de la Etapa 0 y del orden de construcción del MVP descripto acá (qué modelo descargar, si se aprueban los smoke tests con instalación de dependencias en carpeta temporal, y si el modo attach de Ollama es definitivo para el MVP); no se duplican acá para no crear una segunda fuente de verdad sobre preguntas ya formuladas por la columna vertebral.
