# SaurioLLM: arquitectura recomendada

**Fecha:** 2026-09-18 · **Estado:** propuesta cerrada, previa a cualquier scaffolding.

---

## 1. Etiquetas epistémicas y alcance del relevamiento

- `[COMPROBADO EN EQUIPO]`: medido o leído directamente en la máquina del usuario durante el relevamiento del 2026-09-18.
- `[VERIFICADO EN DOC OFICIAL]`: confirmado en documentación o código fuente oficial, con fuente citada en el documento correspondiente.
- `[DECISIÓN DE DISEÑO]`: elección nuestra, argumentada.
- `[HIPÓTESIS A PROBAR]`: estimación, proyección o dato de fuente secundaria. Incluye **toda** cifra de VRAM, tokens/s, calidad de tool calling y compatibilidad. Cada una indica cómo se va a medir.

**El relevamiento fue de solo lectura.** No se instaló ni se desinstaló nada, no se creó ningún archivo en `N:/SaurioLLM` y no se tocó la configuración de Ollama. En el momento del relevamiento **el servidor de Ollama no estaba corriendo** y ningún modelo estaba cargado en GPU: por lo tanto **ninguna cifra de rendimiento, de VRAM por modelo o de tokens/s de este paquete es una medición** — todas son `[HIPÓTESIS A PROBAR]`. Sí hay modelos instalados: `gemma4:26b` y `gemma4:31b` en `N:\OllamaModels` `[COMPROBADO EN EQUIPO]` (esto corrige cualquier mención previa a "sin modelos descargados"), pero no se los ejecutó en esta sesión. El único registro de ejecución real disponible es el `server-1.log` del 2026-09-17, donde `gemma4:31b` con contexto 262144 falló con `cudaMalloc failed: out of memory` `[COMPROBADO EN EQUIPO]`: es evidencia de un fallo, no una medición de rendimiento.

## 2. Arquitectura elegida

Aplicación de escritorio Electron 44 + React 19 + TypeScript, monorepo pnpm, SQLite local `[DECISIÓN DE DISEÑO]`.

- El centro es **`@saurio/runtime`**: un paquete **Node puro**, sin Electron ni React, que corre en el proceso `main`. Se prueba con vitest sin levantar Electron y puede mudarse a otro host más adelante.
- Capas con contratos estrictos: **UI → AgentRuntime → ModelGateway → Providers**, y **AgentRuntime → ToolSystem**. Ninguna capa importa la de arriba; `providers/` solo se importa desde `gateway/`.
- La **UI (renderer)** está sandboxeada: no ejecuta nada, renderiza proyecciones de eventos y pide acciones por IPC tipado con zod, validando `senderFrame`.
- El **ModelGateway** es la única puerta de inferencia. Ollama es el primer provider (`fetch` + NDJSON propio sobre `/api/chat` nativo, nunca `/v1`); LM Studio y APIs OpenAI-compatible entran después sin tocar el runtime.
- El **ToolSystem** tiene un registro único donde builtin, MCP (v0.3) y `delegate` (v0.4) conviven detrás de la misma `ToolDefinition`.
- El trabajo CPU-intensivo (tree-sitter, PageRank del repo map) vive en un **`utilityProcess`** aparte para no bloquear la UI.
- **Persistencia:** `run_events` append-only es la fuente de verdad; `messages`, `tool_calls`, `runs.state`, `tasks` y `checkpoints` son proyecciones escritas en la misma transacción. Reiniciar = leer el último evento.
- **Concurrencia, separada en dos conceptos** (condición 2): la **organización lógica** (N proyectos, chats, agentes y runs simultáneos, cada uno con su estado y su `AbortController`) es siempre posible e ilimitada; la **capacidad física** son los **slots de inferencia**, configurables por provider (`auto` = 1 en esta PC). Con 1 slot los runs se serializan y se ve "en cola (posición 2)"; con N corren en paralelo. Entre 1 y N slots **no cambian** ni la máquina de estados, ni los eventos, ni el modelo de datos, ni los permisos, ni la UI.

## 3. Decisiones principales

| Decisión | Elección | Motivo |
|---|---|---|
| Shell y lenguaje | Electron 44 + electron-vite + React 19 + TS, monorepo pnpm | Decisión previa del usuario; no requiere Rust (no instalado `[COMPROBADO EN EQUIPO]`) |
| Dónde corre el runtime | Paquete Node puro en el proceso `main` | Un solo salto IPC para el streaming; testeable sin Electron |
| Cliente de Ollama | `fetch` + NDJSON + schemas zod propios | El cliente npm no tipa campos que necesitamos y su `abort()` corta todos los streams `[VERIFICADO EN DOC OFICIAL]` |
| Persistencia | SQLite (better-sqlite3 + drizzle), log de eventos + proyecciones | Recuperación trivial, auditoría completa, FTS5 para buscar el historial |
| Formato de edición | `edit_file(old_string, new_string)` + `write_file`, matching en cascada | Dos strings JSON no tienen sintaxis que un modelo chico pueda romper |
| Protocolo de tools | Nativo + fallback de texto (Hermes `<tool_call>`) detrás de una interfaz | Muchos modelos locales no declaran `tools` `[VERIFICADO EN DOC OFICIAL]` |
| Contexto | Repo map tree-sitter + PageRank, presupuestos explícitos, prefijo estable, compactación en 3 niveles | Nunca se manda el repo completo y se conserva el cache de prompt |
| Checkpoints | Snapshot content-addressed por archivo tocado, revert selectivo por hash | Cumple la protección sin tocar jamás el `.git` del usuario |
| Fallos | Write-ahead: toda tool call se escribe `pending` **antes** de ejecutarse | Al reiniciar nunca se re-ejecuta sola una acción peligrosa |
| Scheduler | Dentro del Gateway; el slot dura **una generación** | Esperar permiso o ejecutar una tool no ocupa capacidad de inferencia |
| Ajustes automáticos | Ninguno salvo capear `num_ctx` al máximo del modelo, registrado y visible | Sin datos medidos no hay evidencia para ajustar nada solo |
| Nube | `locality` explícita por modelo y por run; jamás fallback local → nube | Local por defecto, frontera visible y auditada |

## 4. Riesgos principales

| Riesgo | Impacto | Mitigación | Etiqueta |
|---|---|---|---|
| Tool calling errático en modelos de 7-8B | El agente no completa tareas; el hito 1 no valida | Dos transportes, validación zod, re-prompt con el error (máx. 2), rescate con `format`, loop detector, ≤ 8 tools por agente, harness `eval/` desde el MVP | `[HIPÓTESIS A PROBAR]` |
| Los modelos instalados no entran en 8 GiB de VRAM | Sin modelo utilizable para el hito 1 | El MVP exige un modelo con `tools` que cargue 100 % en GPU (`size_vram == size` en `/api/ps`); `gemma4:26b`/`31b` pasan a ser casos del banco de pruebas | `[HIPÓTESIS A PROBAR]`; el OOM del 17/09 es `[COMPROBADO EN EQUIPO]` |
| Contexto por defecto 256K y escucha en `0.0.0.0` en la app de bandeja | OOM al cargar y servidor expuesto en la red local | SaurioLLM manda **siempre** `options.num_ctx` explícito y verifica `context_length` en `/api/ps`; el Centro de modelos y los diagnósticos **avisan** sin tocar la configuración ajena | `[COMPROBADO EN EQUIPO]` (lectura de `server.log` y `db.sqlite`) |
| Módulos nativos (better-sqlite3 13, node-pty 1.1) en Electron 44 | La app no arranca | `electron-builder install-app-deps`, driver SQLite encapsulado con fallback, terminal opcional; **smoke test previo al scaffolding** | `[HIPÓTESIS A PROBAR]` |
| `web-tree-sitter 0.27` vs grammars de terceros | Sin repo map | Grammars compiladas por nosotros; degradación a árbol plano de archivos; indexer aislado en `utilityProcess` | `[HIPÓTESIS A PROBAR, fuente secundaria]` |
| Efectos de `run_command` no reversibles | El usuario cree que el revert deshace todo | Texto literal en la tarjeta de checkpoint y en el diálogo de revert con lo que **no** cubre (`npm install`, migraciones, `git push`, borrados fuera del workspace) | `[DECISIÓN DE DISEÑO]` |
| Sobre-ingeniería para un desarrollador solo | El MVP no llega | Principio "cada abstracción paga en el hito 1"; tabla única de alcance como árbitro | `[DECISIÓN DE DISEÑO]` |

## 5. Primer hito (MVP)

**Alcance.** Un agente, un slot, **10 tools builtin** (`list_files`, `search_code`, `read_file`, `read_output`, `edit_file`, `write_file`, `delete_file`, `run_command`, `task_update`, `finish`; en modo plan el modelo ve 6), modos **Plan** y **Agent**, permisos completos con protected y critical paths, checkpoints + diff + revert selectivo, terminal integrada, SQLite con log de eventos y `recover()`, repo map de ts/tsx/js/python, compactación niveles 0 y 2.

**Criterio de aceptación: el recorrido de validación #1 completo** — abrir carpeta → elegir modelo local → explorar el proyecto → proponer un cambio → autorizarlo → aplicarlo → revisar el diff → deshacerlo → reiniciar la app y conservar el historial. Cada paso está trazado con componente, evento, tabla persistida y qué ve el usuario en el documento 05. Debe pasar **3 veces seguidas**. Se suman dos criterios de robustez: cerrar la app a la fuerza en medio de un `run_command` deja la tool en `orphaned` visible y **nada se re-ejecuta**; y `saurio db rebuild` reproduce las proyecciones idénticas desde el log.

**Prerrequisito.** Tener instalado un modelo con capability `tools` que entre 100 % en GPU (por ejemplo `qwen3:8b` o `qwen2.5-coder:7b`), descargado manualmente con `ollama pull` (ver pregunta 1).

**Mínimos de las funcionalidades adicionales dentro del MVP:**

- **Centro de modelos (11.A):** listado de instalados, cargado/no cargado, capabilities, tamaño, `fits` **estimado y etiquetado como tal**, carpeta de modelos detectada en modo attach, badge de localidad LOCAL, aviso si Ollama no corre y advertencias de exposición en red y de contexto por defecto. Descargas, catálogo curado y recomendaciones quedan para v0.2/v0.3.
- **Panel de rendimiento (11.B):** métricas por respuesta bajo cada mensaje (tokens de entrada/salida, cacheados, tok/s, tiempo de carga, TTFT), métricas por run, `/api/ps` en el selector, CPU/RAM, `nvidia-smi` bajo demanda y el diagnóstico de offload. Cada número lleva `measured | estimated | unavailable`.
- **Banco de pruebas y perfiles (11.C):** nada del banco entra al MVP; los perfiles son presets estáticos con id estable guardado en la configuración efectiva del run. El único ajuste automático es capear `num_ctx`, registrado y visible.

## 6. Qué queda para después

- **v0.2:** modos Ask/Edit; descargas con progreso y cancelación; `OpenAICompatProvider` (LM Studio); panel de rendimiento con muestreo continuo e historial; perfiles activos; `remember`; 10 lenguajes más en el repo map.
- **v0.3:** Banco de pruebas y "compatibilidad probada"; motor de recomendaciones; modo *managed* de Ollama en puerto propio; cliente MCP; shadow repo como detector de cambios hechos por comandos.
- **v0.4:** multi-agente real (Lead/Coder/Reviewer con `delegate`), N slots, providers cloud con frontera explícita, memoria persistente, hooks, embeddings opcionales.

## 7. Preguntas abiertas (solo las que cambian el diseño)

1. **Modelo de trabajo del MVP.** ¿Autorizás descargar manualmente `qwen3:8b` (~5,2 GB) y/o `qwen2.5-coder:7b` (~4,7 GB)? Sin un modelo con `tools` que entre 100 % en GPU, el hito 1 no se puede validar.
2. **Default de `write`.** ¿Las ediciones piden permiso siempre al principio (preset `balanced`, lo propuesto) o se permiten automáticamente dentro del workspace desde el día 1?
3. **Smoke tests previos.** ¿Aprobás que el paso siguiente sea una carpeta temporal **fuera** de `N:/SaurioLLM` con cuatro pruebas de riesgo (nativos en Electron 44, grammar propia en web-tree-sitter 0.27, abort de stream y cambio de `num_ctx` en Ollama 0.34.1)? Implica instalar dependencias ahí, nunca en el proyecto.
4. **Terminal por defecto.** ¿`pwsh` 7 para la terminal del usuario y para `run_command`, con Git Bash como opción? Define qué `CommandParser` se prioriza.
5. **Servidor de Ollama.** ¿Confirmás modo *attach* a la app de bandeja y que SaurioLLM no debe tocar su configuración, ni siquiera el contexto de 256K (solo avisar)? Si querés *managed* antes de v0.3, cambia el orden del roadmap.
6. **Procesos huérfanos.** Si tras cierres forzados quedan procesos de `run_command` vivos, ¿querés que en v0.2 se guarde una lista best-effort de pids para intentar un cierre dirigido al reiniciar? Hoy se decidió **no** hacerlo por el riesgo de matar un pid reasignado; cambiarlo agrega una tabla al modelo de datos.

## 8. Índice de documentos

| # | Documento | Qué contiene |
|---|---|---|
| 01 | `01-arquitectura.md` | Capas, componentes, procesos de Electron, seguridad, contrato IPC y concurrencia. |
| 02 | `02-estructura-de-carpetas.md` | Árbol del monorepo, convenciones de nombres e imports, y carpeta de datos en runtime. |
| 03 | `03-modelo-de-datos.md` | DDL completo de SQLite, índices, PRAGMAs, qué se escribe en cada transición, migraciones y retención. |
| 04 | `04-interfaces-typescript.md` | Contratos de tipos de `@saurio/runtime` y `packages/shared`, incluido el mapa IPC tipado. |
| 05 | `05-flujo-de-ejecucion.md` | Ciclo de vida de un run paso a paso, máquina de estados y el recorrido de validación #1 trazado. |
| 06 | `06-permisos-y-modos.md` | Modos, categorías, reglas, algoritmo de decisión, invariantes no configurables y UI del permiso. |
| 07 | `07-context-manager.md` | Repo map, exploración progresiva, presupuestos por `numCtx`, prefijo estable y compactación. |
| 08 | `08-model-manager-y-scheduler.md` | Descubrimiento de modelos, medición vs estimación de memoria y slots de inferencia. |
| 09 | `09-proteccion-del-proyecto.md` | Checkpoints, diff, revert selectivo con conflictos, aislamiento del `.git` y límites explícitos. |
| 10 | `10-fallos-y-recuperacion.md` | Write-ahead de tool calls, recuperación al iniciar y tabla de casos de fallo con su salida. |
| 11 | `11-roadmap.md` | Etapa 0 (smoke tests), MVP, v0.2, v0.3 y v0.4 con criterios de "listo" y orden de construcción. |
| 12 | `12-decisiones.md` | ADR-001 a ADR-019: contexto, decisión, alternativas descartadas y consecuencias. |
| 13 | `13-centro-de-modelos.md` | Catálogo, descargas, carpeta de modelos attach/managed, Hardware Profiler y recomendaciones. |
| 14 | `14-panel-de-rendimiento.md` | Fuente de cada métrica, calidad del dato, agregación, vista en vivo y diagnósticos. |
| 15 | `15-banco-de-pruebas-y-perfiles.md` | Metodología de comparación reproducible, compatibilidad probada y perfiles rápido/equilibrado/calidad. |

---

**La arquitectura termina acá; el scaffolding no se hace hasta que el usuario la apruebe.**
