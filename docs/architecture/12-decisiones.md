# Documento 12: Decisiones de arquitectura (ADR) — SaurioLLM

Un ADR por cada decisión relevante de la columna vertebral: contexto, decisión, alternativas descartadas, consecuencias y etiqueta epistémica de las premisas.

Leyenda: `[COMPROBADO EN EQUIPO]` `[VERIFICADO EN DOC OFICIAL]` `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]`

**Nota de numeración.** Este documento numera los ADR de forma correlativa (ADR-001 a ADR-019) para poder desglosar en decisiones separadas varias cosas que la columna vertebral §1 agrupa bajo un mismo ADR corto (por ejemplo, "shell de escritorio" y "dónde corre el runtime" son dos ADR acá pero una sola entrada, ADR-1, en la columna vertebral). La numeración de la columna vertebral (CV ADR-1 a CV ADR-7) es la que usan los documentos 01, 05, 07, 08, 09, 13 y 15 al citar un ADR por número corto; la tabla siguiente traduce entre ambas para evitar que "ADR-5" o "ADR-7" se lean como decisiones distintas según el documento.

| Este documento | Columna vertebral §1 | Tema |
|---|---|---|
| ADR-001 | CV ADR-1 | Electron como shell (parte "con qué se construye") |
| ADR-002 | CV ADR-1 | Runtime en `main` (parte "dónde corre") |
| ADR-005 | CV ADR-3 | Persistencia: log de eventos híbrido |
| ADR-007 | CV ADR-4 | Checkpoints por archivo |
| ADR-011 | CV ADR-6 | Dos transportes de tools (nativo + texto) |
| ADR-015 | CV ADR-5 | Scheduler dentro del Gateway, slot por turno |
| ADR-019 | CV ADR-7 | Ningún ajuste automático salvo capear `num_ctx` |

Los ADR-003, 004, 006, 008, 009, 010, 012, 013, 014, 016, 017 y 018 detallan decisiones que la columna vertebral menciona dentro de otras secciones (§2 a §9) sin asignarles un número de ADR corto propio; no tienen fila en la tabla porque no hay un "CV ADR-N" con el que puedan confundirse.

---

## ADR-001: Electron + electron-vite y layout de procesos

**Estado:** aceptada.

**Contexto.** SaurioLLM es una app de escritorio pura para un desarrollador solo, en Windows 11 con Node 24.14, pnpm 10.33, sin Rust instalado `[COMPROBADO EN EQUIPO]`. Se necesita un shell que dé ventana nativa, acceso a filesystem/procesos y un empaquetado confiable de dependencias nativas (better-sqlite3, node-pty).

**Decisión.** Electron 44.4.2 + electron-vite 5.0.0, monorepo pnpm con `packages/shared`, `packages/runtime`, `packages/repomap` y `apps/desktop`. Layout de procesos: `apps/desktop/src/{main,preload,renderer}`. `main` hospeda `@saurio/runtime` vía `host/RuntimeHost.ts`; `preload` expone un `contextBridge` mínimo (`invoke`, `onEvent`, `terminalPort`); `renderer` es React 19 puro, sandboxeado, sin acceso a Node. Trabajo pesado de CPU (tree-sitter, PageRank) se aísla en un `utilityProcess` separado (`ProjectIndexer`).

**Alternativas consideradas.**
- *Tauri*: descartada porque requiere toolchain Rust y el usuario no lo tiene instalado `[COMPROBADO EN EQUIPO]`; reintroducirlo implicaría instalar y validar un compilador nuevo antes de poder validar nada del producto.
- *Web + desktop simultáneo*: descartada por decisión previa del usuario (condición: "App de escritorio pura primero").
- *Electron sin electron-vite (webpack/electron-forge manual)*: descartada porque electron-vite ya resuelve el bundleo del preload sandboxeado y la externalización de dependencias nativas del main sin configuración adicional `[VERIFICADO EN DOC OFICIAL: electron-vite.org/guide]`.

**Consecuencias.** El empaquetado usa `asar: true` con `asarUnpack` para `*.node`, `@vscode/ripgrep*` y `*.wasm`, y `electron-builder install-app-deps` en postinstall para los módulos nativos `[VERIFICADO EN DOC OFICIAL: electron.build/docs]`. La seguridad del renderer (contextIsolation, sandbox, CSP `script-src 'self'`, validación de `senderFrame`) es una obligación de diseño, no opcional, porque el renderer no tiene otra defensa. El riesgo abierto es que better-sqlite3 13 y node-pty 1.1 requieran rebuild contra Electron 44 sin que esto esté verificado todavía `[HIPÓTESIS A PROBAR]`; por eso el roadmap exige un smoke test antes del scaffolding (pregunta abierta 3 de la columna vertebral).

**Qué haría revisar esto.** Que el smoke test de dependencias nativas falle de forma irrecuperable en Electron 44 (por ejemplo, ausencia de binarios prebuilt para esa versión de ABI), lo que forzaría bajar de versión de Electron o buscar reemplazos.

---

## ADR-002: Dónde corre el runtime

**Estado:** aceptada.

**Contexto.** El corazón de SaurioLLM es el runtime de agentes (`RunController`, `ContextManager`, `ToolSystem`, `ModelGateway`). Hay que decidir en qué proceso vive, considerando latencia del streaming de tokens y la necesidad de spawnear procesos (terminal, `run_command`) y acceder al filesystem sin restricciones de sandbox.

**Decisión.** `@saurio/runtime` es un paquete Node puro, sin dependencia de Electron ni React, que corre en el proceso `main`. Se le inyecta un `HostAdapter` para efectos específicos de Electron (diálogos nativos, notificaciones, rutas de `appData`). El indexado de código (tree-sitter, PageRank), que es CPU-intensivo, se delega a un `utilityProcess` separado para no bloquear el loop de eventos de `main`.

**Alternativas consideradas.**
- *Runtime en un `utilityProcess` dedicado*: se descartó porque cada token del streaming pasaría por dos saltos de IPC (utilityProcess → main → renderer) en vez de uno, agregando latencia perceptible en la UI sin necesidad, ya que el runtime no es lo que bloquea a `main` (el indexer sí).
- *Runtime en el renderer*: inviable porque el renderer sandboxeado no puede spawnear procesos ni acceder al filesystem sin mediación de IPC, y correr ahí violaría el modelo de seguridad de Electron.

**Consecuencias.** Un solo salto de IPC para el streaming de tokens (`main → renderer` por `webContents.send('runtime:event', batch)`, batching de 30 ms). El paquete `@saurio/runtime` se puede testear con vitest sin levantar Electron, y en teoría se podría mover a otro host (por ejemplo, un servidor local) en una etapa futura sin reescribirlo, porque no importa nada de Electron directamente. El costo es que si `main` se bloquea por algún motivo ajeno al runtime, toda la UI se congela; de ahí que cualquier trabajo pesado nuevo deba evaluarse para el `utilityProcess`, no para `main`.

**Qué haría revisar esto.** Evidencia medida de que el batching de 30 ms genera lag perceptible en streams largos, o que el runtime necesite escalar a múltiples proyectos abiertos simultáneamente con más carga de CPU de la que `main` puede sostener.

---

## ADR-003: Driver SQLite

**Estado:** aceptada.

**Contexto.** Se necesita persistencia local confiable con soporte de transacciones, WAL y búsqueda full-text (FTS5) para el historial de mensajes, corriendo dentro de un binario de Electron empaquetado.

**Decisión.** `better-sqlite3` 13.0.3, encapsulado detrás de `persistence/driver.ts` para poder sustituirlo sin tocar el resto del código.

**Alternativas consideradas.**
- *`node:sqlite` (nativo de Node)*: descartado para el MVP porque su soporte de FTS5 y su comportamiento dentro de Electron 44 no están verificados todavía `[HIPÓTESIS A PROBAR]`; queda como candidato de migración futura precisamente porque el driver está encapsulado.
- *libsql*: descartado por ser una dependencia adicional sin necesidad clara sobre SQLite estándar para un caso 100% local.
- *sql.js (SQLite compilado a WASM)*: descartado porque no persiste directamente a un archivo del sistema operativo sin capas adicionales, y aquí no hay restricción de sandbox de navegador que lo justifique.

**Consecuencias.** WAL activado desde la migración 1, `better-sqlite3` es síncrono (simplifica el código de transacciones del `EventStore`, que necesita escribir evento + proyección en una sola transacción atómica). El encapsulamiento en `driver.ts` es la salida de escape documentada si `node:sqlite` madura o si aparece un problema de compatibilidad de ABI con Electron 44 `[VERIFICADO EN DOC OFICIAL: investigación 2 §C.1]`.

**Qué haría revisar esto.** Que el smoke test de nativos (ADR-001) muestre que better-sqlite3 13 no tiene binarios prebuilt para la versión de ABI de Electron 44 y que compilarlo localmente sea inviable sin toolchain C++ instalado.

---

## ADR-004: ORM / capa SQL

**Estado:** aceptada.

**Contexto.** El schema de datos (§4 de la columna vertebral) tiene ~25 tablas con relaciones, y se necesita tipado compartido entre el schema y el código TypeScript del runtime, sin renunciar a SQL crudo para las vistas de agregación con JSON1.

**Decisión.** `drizzle-orm` 0.45.2 + `drizzle-kit` para migraciones embebidas en la app; SQL crudo permitido explícitamente para las vistas de agregación (`v_model_stats`, `v_chat_stats`) que usan funciones JSON1 sobre columnas `*_json`.

**Alternativas consideradas.**
- *Solo SQL crudo sin ORM*: descartado porque perdería el tipado compartido entre schema y dominio (`z.infer` desde los enums de `packages/shared`), aumentando el riesgo de desalineación entre columnas y tipos TS a medida que crece el schema.
- *Prisma*: descartado por traer un motor de query propio (más pesado para una app de escritorio empaquetada) y menor control fino sobre SQL crudo para JSON1, que acá se usa activamente.

**Consecuencias.** Las migraciones viajan embebidas en el binario y se aplican en el bootstrap de `main` antes de `recover()`. El acoplamiento entre `drizzle` y el schema real se mitiga porque las columnas `_json` se validan con zod al leer, no se confía en el tipado de drizzle para su contenido interno.

**Qué haría revisar esto.** Necesidad real de queries dinámicas complejas que drizzle no exprese bien, o un cambio de motor de persistencia (por ejemplo, a un backend remoto) que haga innecesario un ORM embebido.

---

## ADR-005: Persistencia — log de eventos vs relacional vs híbrido

**Estado:** aceptada.

**Contexto.** El requisito de recuperación sin pérdida de trabajo (condición 4) exige que cualquier transición de estado de un run sea reconstruible tras un cierre inesperado, y que la UI pueda consultar eficientemente listas de mensajes, tool calls y checkpoints sin recorrer un log completo cada vez.

**Decisión.** Modelo híbrido: `run_events` (tabla append-only) es la fuente de verdad de cada run; `messages`, `tool_calls`, `runs.state`, `tasks` y `checkpoints` son **proyecciones** escritas en la **misma transacción** que el evento correspondiente. Existe un comando de mantenimiento, `saurio db rebuild [--run <id>]`, que borra las proyecciones y las reconstruye leyendo `run_events` desde cero.

**Alternativas consideradas.**
- *Solo tablas mutables (sin log)*: descartada porque tras un cierre inesperado a mitad de una transición no hay forma de distinguir "se aplicó pero no se notificó" de "no se aplicó", lo que viola la condición 4 directamente.
- *Solo log en archivos JSON, sin tablas SQL*: descartada porque impediría consultas SQL indexadas (por ejemplo, `runs_active`) y búsqueda full-text (FTS5) sin reconstruir todo en memoria en cada arranque, inviable para historiales largos.

**Consecuencias.** Cada escritura relevante cuesta dos inserciones/actualizaciones en vez de una (evento + proyección), pero ambas ocurren atómicamente, así que jamás quedan desincronizadas si la transacción se completa. `saurio db rebuild` sirve como red de seguridad de integridad y como herramienta de depuración; no toca `checkpoints`, `blobs`, `permission_*`, `models` ni `settings`, que no son proyecciones del log de un run sino datos de otro dominio.

**Qué haría revisar esto.** Que el volumen de eventos por run crezca lo suficiente como para que `saurio db rebuild` tarde de forma inaceptable en runs largos, forzando snapshots periódicos del estado en vez de replay completo.

---

## ADR-006: Formato de edición de archivos para modelos chicos

**Estado:** aceptada.

**Contexto.** El principio 1 de la columna vertebral fija el diseño alrededor de modelos 7-8B. La literatura de terceros sobre edición de código con LLMs compara formatos de diff distintos y su tasa de éxito varía fuertemente según el tamaño del modelo `[HIPÓTESIS A PROBAR, fuente secundaria]`.

**Decisión.** Dos tools: `edit_file(path, old_string, new_string, replace_all?)` con matching en cascada (`exact → eol → indent → whitespace → fuzzy`), y `write_file(path, content)` para archivo completo. `delete_file(path)` es explícita y separada.

**Alternativas consideradas.**
- *Unified diff*: descartado porque benchmarks de terceros (aider) muestran peor tasa de éxito en modelos chicos frente al formato "whole file" o de reemplazo de strings `[HIPÓTESIS A PROBAR, fuente secundaria: aider.chat/2025/05/08/qwen3]`.
- *Formato V4A (estilo Codex)*: descartado porque requiere que el modelo esté específicamente entrenado en ese formato; los modelos locales candidatos (Qwen3, Qwen2.5-Coder) no tienen esa garantía.
- *SEARCH/REPLACE en fences de markdown (estilo Cline)*: descartado porque introduce una sintaxis propia que el modelo puede romper si el código a editar contiene el propio marcador de fence.

**Consecuencias.** `old_string`/`new_string` viajan como dos strings JSON sin sintaxis propia que romper. El matching en cascada absorbe diferencias menores (fin de línea CRLF/LF, indentación, espacios) sin fallar de entrada, y registra en `tool_calls.match_level` qué nivel se usó, para que la UI pueda marcar ediciones "fuzzy" con más atención. Si `old_string` no matchea, el error devuelto al modelo incluye las líneas más parecidas numeradas, para facilitar el reintento sin gastar otra ronda de lectura completa del archivo.

**Qué haría revisar esto.** Evidencia del harness `eval/` propio (no de terceros) de que un formato distinto rinde mejor específicamente con Qwen3-8B/Qwen2.5-Coder-7B sobre el corpus de tareas de SaurioLLM.

---

## ADR-007: Mecanismo de checkpoint

**Estado:** aceptada.

**Contexto.** La condición 5 exige poder revisar y revertir selectivamente lo que el agente modifica, sin tocar `.git` del usuario ni pisar ediciones humanas posteriores.

**Decisión.** Snapshots content-addressed por archivo tocado: antes de que una tool mutante escriba, `CheckpointService.begin` guarda la pre-imagen exacta (bytes, EOL, BOM, modo) en `appData/blobs/<hash>`; al terminar, `commit` guarda la post-imagen. El revert compara `hash(archivo actual)` contra `post_hash`: si coincide, restaura sin fricción; si no, es un conflicto que se resuelve a tres vías (pre / post del agente / actual) por archivo. El propio revert genera un nuevo checkpoint (`kind: 'revert'`), por lo que también es reversible.

**Alternativas consideradas.**
- *Shadow git estilo Cline (`GIT_DIR` alternativo)*: descartada como mecanismo principal por el riesgo conocido de manipular referencias de `.git` (aunque sea uno "sombra") y porque un revert de árbol completo puede pisar trabajo del usuario que no pasó por el agente. Queda relegada a v0.3 únicamente como **detector** read-only de cambios producidos por comandos (`run_command`), nunca como mecanismo de revert.
- *Commits reales en el repo del usuario*: descartada por decisión explícita previa del usuario.
- *Snapshots por turno completo (estilo algunos asistentes de código)*: descartados porque no capturan bien operaciones como `rm` fuera del propio editor de archivos, y granulan peor que "por archivo tocado por una tool call".

**Consecuencias.** El checkpoint **no cubre** efectos de `run_command` (instalaciones, migraciones, borrados fuera del workspace, `git push`); esto se declara explícitamente en la tarjeta de checkpoint y en el diálogo de revert, cumpliendo la condición 5 en su parte negativa. Archivos mayores a 20 MB se marcan `blob_missing = 1` (se guarda el hash pero no el contenido) y el revert avisa que no puede restaurarlos.

**Qué haría revisar esto.** Que el volumen de blobs crezca de forma insostenible en proyectos con archivos grandes editados con frecuencia, forzando una política de retención o compresión de blobs antes de lo previsto en el roadmap.

---

## ADR-008: Repo map

**Estado:** aceptada.

**Contexto.** La condición de no mandar el repo completo al modelo exige un mecanismo de orientación de bajo costo en tokens sobre la estructura del proyecto, viable con un modelo chico y sin depender de un segundo modelo de embeddings en una GPU de 8 GB.

**Decisión.** Patrón Aider: `web-tree-sitter` 0.27 con grammars compiladas propias + queries `*-tags.scm` (derivadas de Aider, licencia Apache-2.0 con atribución) para extraer definiciones/referencias, grafo archivo→archivo ponderado, PageRank personalizado, y selección de contenido por presupuesto de tokens (`repoMapTokens`) vía búsqueda binaria. Cache en `repo_map_cache` por mtime; reindexado incremental con `fs.watch` y debounce. Lenguajes del MVP: TypeScript, TSX, JavaScript, Python; el resto se muestra como árbol plano de archivos.

**Alternativas consideradas.**
- *Embeddings + vector store* (patrón usado por Continue/Roo): descartado porque exige correr un segundo modelo (de embeddings) además del modelo de chat, compitiendo por la misma GPU de 8 GB, y agrega una dependencia de infraestructura (vector store) sin necesidad clara para el tamaño de proyecto objetivo.
- *`tree-sitter-wasms` 0.1.13 (paquete de grammars precompiladas de terceros)*: descartado como fuente de las grammars porque hay reportes de incompatibilidad con `web-tree-sitter` 0.27 `[HIPÓTESIS A PROBAR, fuente secundaria]`; se opta por compilar las grammars propias con `tree-sitter-cli` ≥ 0.26.

**Consecuencias.** El repo map depende de que la compilación propia de grammars funcione en el equipo del usuario; si falla, la mitigación diseñada es degradar a árbol plano de archivos en vez de bloquear la apertura del proyecto. El indexado corre aislado en el `utilityProcess` para no competir con el runtime por CPU del proceso `main`.

**Qué haría revisar esto.** Que el smoke test de `web-tree-sitter` 0.27 confirme la incompatibilidad reportada de forma que compilar grammars propias no la resuelva; en ese caso habría que fijar una versión distinta de `web-tree-sitter` o evaluar un extractor de tags más simple basado en regex por lenguaje como red de contención.

---

## ADR-009: Búsqueda de código

**Estado:** aceptada.

**Contexto.** La tool `search_code` necesita ser rápida, respetar `.gitignore` y no reinventar un motor de búsqueda en Node.

**Decisión.** `@vscode/ripgrep` 1.18, invocado con `rg --json` para `search_code` y `rg --files` para el listado de archivos del `ProjectIndexer`.

**Alternativas consideradas.**
- *`fast-glob` + regex manual en Node*: descartado por ser sensiblemente más lento en proyectos medianos/grandes y por tener que reimplementar a mano el respeto de `.gitignore` anidado, que ripgrep ya resuelve nativamente.

**Consecuencias.** `search_code(query, glob?, max_results ≤ 50)` agrupa resultados por archivo con una línea de contexto, dentro del presupuesto de tokens de exploración progresiva (§8 de la columna vertebral). Se hereda la madurez y velocidad de ripgrep, incluida búsqueda multilínea `[VERIFICADO EN DOC OFICIAL: investigación 2 §C.5]`, a cambio de una dependencia binaria empaquetada (`asarUnpack`).

**Qué haría revisar esto.** Necesidad futura de búsqueda semántica (no solo textual) que ripgrep no puede resolver; eso es un problema distinto (embeddings) explícitamente diferido, no un reemplazo de ripgrep para búsqueda literal/regex.

---

## ADR-010: Terminal

**Estado:** aceptada.

**Contexto.** Hay dos necesidades de ejecución de comandos con requisitos opuestos: una terminal interactiva para el usuario (necesita secuencias de control ANSI/VT) y comandos ejecutados por el agente (necesitan salida limpia y parseable para el modelo).

**Decisión.** Dos caminos distintos: `node-pty` 1.1.0 + `@xterm/xterm` 6 para la `TerminalService` del usuario; `child_process.spawn` (sin pty) para `run_command` del agente, invocando `pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <cmd>` con fallback a `powershell.exe`, y bash en POSIX.

**Alternativas consideradas.**
- *Ejecutar también los comandos del agente por pty*: descartado porque un pty inyecta secuencias de control VT en la salida que el modelo tendría que aprender a ignorar, degradando la calidad del parseo de resultados sin ningún beneficio para un proceso no interactivo.

**Consecuencias.** La terminal humana obtiene ConPTY nativo de Windows con soporte completo de aplicaciones interactivas `[VERIFICADO EN DOC OFICIAL: node-pty README]`; los comandos del agente devuelven texto plano truncado a nivel 0 (head 40 + tail 60 líneas, con el resto accesible vía `read_output`). El kill de comandos colgados usa `taskkill /PID <pid> /T /F` para matar el árbol completo, necesario en Windows porque `child_process.kill()` no siempre mata subprocesos `[VERIFICADO EN DOC OFICIAL: investigación 2 §C.3]`.

**Qué haría revisar esto.** Que node-pty 1.1 no cargue en Electron 44 sin rebuild (riesgo ya identificado en la columna vertebral); la mitigación documentada es que la terminal del usuario quede deshabilitada como funcionalidad opcional sin bloquear el resto de la app, ya que `run_command` no depende de node-pty.

---

## ADR-011: Protocolo de tools — nativo + fallback de texto

**Estado:** aceptada.

**Contexto.** No todos los modelos locales exponen `capabilities.tools` en `/api/show` (por ejemplo, algunos modelos Gemma o distills de R1 no lo tienen), pero SaurioLLM necesita que el agente pueda invocar herramientas sin importar el modelo elegido.

**Decisión.** Una interfaz única `ToolProtocol` con dos implementaciones: `NativeToolProtocol` (usa el campo `tools` de la API y escanea `content` por si el modelo mezcla texto y tool call en el mismo chunk) y `TextToolProtocol` (formato Hermes `<tool_call>{...}</tool_call>` en texto plano, con `stop: ['</tool_call>']`). La elección es automática según `capabilities.tools` del modelo, con override explícito por agente (`toolTransport: 'auto' | 'native' | 'text'`).

**Alternativas consideradas.**
- *Solo transporte nativo*: descartado porque excluiría directamente modelos sin esa capability, reduciendo la superficie de modelos utilizables del hito 1.
- *XML propio estilo Cline*: descartado porque es más frágil frente a argumentos que contienen código con ángulos o comillas que rompen el parseo, comparado con JSON embebido en el bloque `<tool_call>`.

**Consecuencias.** En el transporte de texto, los resultados de tools viajan como `role: 'user'` con un bloque `<tool_result>` en vez de `role: 'tool'`, porque no todos los modelos sin tool-calling nativo interpretan bien ese rol. La cantidad de tools expuestas al modelo depende del modo: el registro tiene **10 builtins** (`list_files`, `search_code`, `read_file`, `read_output`, `edit_file`, `write_file`, `delete_file`, `run_command`, `task_update`, `finish`); en modo `plan` el modelo ve 6 (las de solo lectura más `task_update` y `finish`); en modo `agent` ve las permitidas al agente, que por defecto son las 10. La recomendación de "6-8 tools" que aparece en una de las investigaciones previas es una guía para diseñar agentes personalizados con alcance acotado, no un límite duro del registro ni del modo agent por defecto.

**Qué haría revisar esto.** Medición del harness `eval/` mostrando que el transporte de texto degrada significativamente la tasa de acierto de tool calls frente al nativo en los modelos candidatos (Qwen3-8B, Qwen2.5-Coder-7B), lo que podría justificar preferir siempre modelos con soporte nativo en las recomendaciones del Centro de modelos.

---

## ADR-012: Conteo de tokens

**Estado:** aceptada.

**Contexto.** Ollama 0.34.1 no expone un endpoint de tokenización pública `[VERIFICADO EN DOC OFICIAL: ausente en openapi.yaml]`, pero el `ContextManager` necesita estimar el tamaño de cada bloque para respetar `numCtx − reserveForResponse` antes de enviar la solicitud.

**Decisión.** `TokenEstimator` heurístico: `chars / ratio[kind]` con ratios iniciales por tipo de contenido (prosa, código, JSON, paths), calibrado por modelo con una media móvil exponencial (EMA, α = 0,2) contra el `prompt_eval_count` real devuelto tras cada respuesta, persistido en `token_calibration`.

**Alternativas consideradas.**
- *tiktoken (WASM)*: descartado porque es el tokenizer de otra familia de modelos, no el tokenizer real de los modelos locales usados, por lo que su aproximación no sería necesariamente mejor que una heurística calibrada, a cambio de peso adicional en el bundle.
- *Esperar a que Ollama exponga `/api/tokenize`*: descartado como estrategia principal porque ese endpoint no existe en la versión instalada `[VERIFICADO EN DOC OFICIAL: ausente en openapi.yaml]` y bloquear el diseño a su disponibilidad futura no es viable para el MVP.

**Consecuencias.** El error de estimación es una incógnita empírica hasta tener varios turnos de calibración por modelo; se declara la meta de ±5% de error tras 3-5 turnos como hipótesis a validar, no como garantía `[HIPÓTESIS A PROBAR]`. La interfaz `TokenCounter` queda diseñada para poder enchufar un endpoint real de tokenización si aparece en una versión futura de Ollama, sin tocar el resto del `ContextManager`.

**Qué haría revisar esto.** Que la calibración EMA no converja (por ejemplo, si el ratio real varía mucho entre tipos de contenido dentro del mismo turno) y el margen de seguridad tenga que ampliarse de forma permanente, reduciendo el presupuesto útil de historial.

---

## ADR-013: Estado en la UI

**Estado:** aceptada.

**Contexto.** La UI necesita reflejar el estado de runs, permisos, checkpoints y tasks en tiempo real a partir de un flujo de eventos (`RunEvent`), sin duplicar lógica de negocio en el renderer.

**Decisión.** `zustand` 5 con slices por dominio (`project`, `chat`, `run`, `models`, `perf`, `terminal`); el `runStore` reduce directamente los `RunEvent` recibidos por IPC, en vez de mantener su propio modelo paralelo del estado del run.

**Alternativas consideradas.**
- *jotai 3*: descartado por ser una dependencia mayor recién actualizada, sin ventaja clara sobre zustand para este caso de uso (reducir un stream de eventos discriminados).
- *redux*: descartado por el boilerplate que introduce (actions, reducers, middleware) frente a un caso de uso que es, en esencia, "reducir un log de eventos ya tipado en `packages/shared`".

**Consecuencias.** El renderer nunca calcula el estado del run por su cuenta: consume exactamente los mismos eventos que se persisten en `run_events`, lo que garantiza que lo que ve el usuario y lo que queda grabado sean la misma fuente. El batching de eventos a 30 ms limita la frecuencia de re-render sin perder granularidad de datos (los eventos individuales siguen viajando, solo se agrupan en el envío).

**Qué haría revisar esto.** Necesidad de estado compartido entre ventanas o pestañas de proceso adicionales que zustand por slice no cubra bien, lo cual no está previsto en el alcance actual (una sola ventana `BrowserWindow`).

---

## ADR-014: Validación IPC

**Estado:** aceptada.

**Contexto.** El renderer está sandboxeado y solo puede comunicarse con `main` a través del `preload`; cualquier canal IPC mal validado es una superficie de ataque conocida en apps Electron.

**Decisión.** Un mapa único `channel → { input, output }` en `packages/shared/src/ipc.ts`, con schemas zod 4. `registerHandler(channel, schema, fn)` en `main` valida el payload de entrada y verifica `event.senderFrame`. El `preload` expone únicamente `invoke(channel, payload)` y `onEvent(cb)` genéricos; nunca se expone `ipcRenderer` crudo al renderer.

**Alternativas consideradas.**
- *electron-trpc*: descartado porque su compatibilidad con la versión de tRPC 11 y con Electron 44 no está verificada, y añade una capa de abstracción adicional sobre algo que un mapa de canales tipados con zod ya resuelve sin dependencias extra.

**Consecuencias.** Los tipos de entrada/salida de cada canal se derivan con `z.infer`, así que el cliente tipado del renderer (`src/ipc/client.ts`) y el handler de `main` comparten una única fuente de verdad. La validación de `senderFrame` sigue el checklist de seguridad recomendado para Electron `[VERIFICADO EN DOC OFICIAL: electronjs.org/docs/latest/tutorial/security]`. Este diseño hace explícito el contrato de cada canal, lo cual facilita auditar qué puede pedir el renderer y qué le puede llegar sin buscarlo en el código de `main`.

**Qué haría revisar esto.** Que la cantidad de canales crezca tanto que un único archivo de mapa se vuelva difícil de mantener, lo que sugeriría particionarlo por dominio manteniendo el mismo patrón de validación.

---

## ADR-015: Slots de inferencia y Scheduler

**Estado:** aceptada.

**Contexto.** La condición 2 exige separar explícitamente la organización lógica (chats/agentes, siempre ilimitada) de la concurrencia física de inferencia (limitada por hardware). Además, hubo desacuerdo entre distintas propuestas revisadas sobre dónde debía vivir el Scheduler respecto del Gateway.

**Decisión.** El `InferenceScheduler` vive **dentro** de `ModelGateway`, no como capa separada antes de él. El slot se adquiere dentro de `ModelGateway.chat()` y dura exactamente una generación; se libera automáticamente al `done`, error o abort, sin necesidad de un `release` manual por parte del `AgentRuntime`. `settings.inference.slots` es configurable por provider (`auto` = 1 para providers locales con VRAM < 24 GB).

**Alternativas consideradas.**
- *Runtime → Scheduler → Gateway (Scheduler como capa intermedia separada)*: descartada porque invierte el orden de capas ya fijado (`AgentRuntime → ModelGateway`) y expone al runtime detalles de infraestructura de inferencia que no le corresponden.
- *El runtime adquiere el slot por la duración completa del run (no por turno)*: descartada porque un run en `awaiting_permission` puede quedar esperando minutos sin estar generando nada; retener el único slot disponible durante esa espera bloquearía cualquier otro trabajo de inferencia sin necesidad.

**Consecuencias.** `awaiting_permission`, `executing_tool` y `compacting` no ocupan slot, lo que permite que otro run (o un run del mismo chat en background) use la GPU mientras uno espera una decisión humana. La contrapartida es que el prefijo de contexto cacheado por el runner de Ollama se puede perder si otro modelo pasa por el slot entre dos turnos del mismo run; esto se acepta como costo conocido y se mide con `cacheHitRatio` en vez de prohibirse. Con 1 slot (el caso del equipo del usuario) todo se serializa; con N slots se paraleliza sin que la UI ni la máquina de estados cambien.

**Qué haría revisar esto.** Que la pérdida de cache de prefijo por interleaving de modelos resulte, medida en la práctica, en una degradación de latencia mayor a lo tolerable; en ese caso se evaluaría una política de afinidad de slot por chat activo antes que romper la regla de "slot por turno".

---

## ADR-016: Model Manager — estimación vs medición

**Estado:** aceptada.

**Contexto.** La condición 3 prohíbe presentar estimaciones como mediciones, y la condición 11.A pide recomendaciones de modelos según hardware distinguiendo velocidad, calidad y si se prevé uso de CPU/RAM. No existe una API de Ollama que devuelva directamente "esto entra en tu GPU" antes de cargar.

**Decisión.** Separación estricta de responsabilidades: `ModelManager.MemoryEstimator` **calcula** (`fits()`, con fórmula explícita de KV-cache por arquitectura) y etiqueta el resultado como estimado; solo `Benchmark` (v0.3) **mide**, cargando el modelo de verdad vía `ModelGateway` y escribiendo el único registro de compatibilidad probada (`model_compat`). `ModelManager` lee `model_compat` pero nunca lo escribe. Cada número que ve el usuario lleva `quality: 'measured' | 'estimated' | 'unavailable'` y su fuente (principio 6 de la columna vertebral).

**Alternativas consideradas.**
- *Que `ModelManager` mida ejecutando cargas reales para "afinar" sus estimaciones automáticamente*: descartada para el MVP porque mezclaría en un mismo componente la responsabilidad de estimar (barata, sin cargar el modelo) con la de medir (cara, requiere cargar y liberar VRAM), complicando el diagnóstico de qué número es cuál; esta separación es, además, la corrección aplicada tras el injerto de la propuesta "mvp-pragmatic" sobre no duplicar responsabilidades entre Model Manager, Scheduler, Telemetry y Benchmark.

**Consecuencias.** En el MVP, sin `Benchmark` implementado todavía, toda cifra de VRAM en el Centro de modelos es `estimated` por definición; el badge "probado" solo puede aparecer a partir de v0.3. `model_load_samples` (escrita por `ModelManager` tras cada carga real que ocurre de todos modos por uso normal, no por benchmarking) sirve para calibrar el término de `overhead` de la fórmula de estimación sin necesidad de esperar al Benchmark dedicado.

**Qué haría revisar esto.** Que la fórmula de `MemoryEstimator` (basada en `block_count`, `head_count_kv`, `key_length`/`embedding_length` de `/api/show`) produzca estimaciones sistemáticamente alejadas de lo medido por `/api/ps` una vez que haya suficientes `model_load_samples`, lo que obligaría a revisar el término de overhead o el propio modelo de cálculo antes de v0.3.

---

## ADR-017: Protocolo de fallos — write-ahead de tool calls

**Estado:** aceptada.

**Contexto.** La condición 4 exige que ningún reinicio, caída del provider o cierre inesperado repita una acción peligrosa ni pierda trabajo ya hecho. Esto requiere saber, en todo momento, si una tool call con efectos secundarios se llegó a ejecutar o no.

**Decisión.** Toda tool call válida se registra en `tool_calls` con estado `pending` y evento `tool.registered` **antes** de evaluar permisos, y pasa a `running` **antes** de invocar el handler real (write-ahead). Al arrancar, `recover()` clasifica los runs que quedaron activos: los que estaban en `awaiting_permission` se mantienen así (nunca hubo una acción en curso); el resto pasa a `interrupted`, con sus tool calls `running → orphaned` y `pending|approved → abandoned`. Ninguna fila `orphaned` o `abandoned` se re-ejecuta jamás de forma automática; si el modelo vuelve a pedir la misma acción en un run continuado, se crea una fila nueva con id distinto (mismo `args_hash`, lo que permite avisar "ya intentaste esto antes del cierre").

**Alternativas consideradas.**
- *Registrar la tool call solo después de ejecutarla*: descartada de plano porque es exactamente el escenario que la condición 4 prohíbe: si el proceso muere durante la ejecución, no queda ningún registro de que se intentó, y al reiniciar el modelo podría pedir lo mismo sin que el sistema tenga memoria de un intento previo (por ejemplo, un `run_command` que ya modificó algo).
- *Reintentar automáticamente las tool calls `orphaned` al reiniciar*: descartada explícitamente porque una tool call interrumpida a mitad de ejecución puede haber tenido efectos parciales desconocidos (un `run_command` que empezó a escribir archivos, por ejemplo); auto-reejecutarla violaría "nunca repetir una acción peligrosa sin que el usuario decida".

**Consecuencias.** Para tools de archivo (`edit_file`/`write_file`/`delete_file`) huérfanas, el diagnóstico compara `hash(archivo actual)` contra `pre_hash`/`post_hash` del checkpoint asociado para decirle al usuario si la acción "no se aplicó", "se aplicó completa" o "quedó en un estado distinto a ambos" (posible edición externa durante el corte). Para `run_command` huérfano se muestra el comando y la salida parcial capturada, sin asumir nada sobre su efecto real fuera del workspace. La escritura atómica (archivo temporal + rename) en `edit_file`/`write_file` es el complemento necesario de esta garantía: si el proceso muere a mitad de una escritura, el archivo del usuario queda íntegro en su versión anterior, nunca a medio escribir.

**Qué haría revisar esto.** Un caso real (no hipotético) en el que la escritura atómica falle de forma silenciosa en Windows por bloqueo de archivo (`EPERM`/`EBUSY`) y el reintento con backoff no alcance (hoy la tool falla con `path_locked`; no existe fallback in-place); eso exigiría reforzar la detección de ese escenario en el propio `edit_file`.

---

## ADR-018: MCP como cliente detrás del ToolRegistry

**Estado:** aceptada (diseño); implementación diferida a v0.3.

**Contexto.** La condición del usuario pide que el Tool System sea extensible para incorporar MCP como cliente más adelante, sin que eso obligue a rediseñar el registro de herramientas ni el protocolo de tools ya elegido para modelos locales.

**Decisión.** Un único `ToolRegistry` donde conviven, detrás de la misma interfaz `ToolDefinition`, las tools builtin, las tools de servidores MCP y (a futuro) la tool `delegate` de subagentes. Un `McpClient` propio sobre `@modelcontextprotocol/sdk` 1.30 registrará las tools de cada servidor como `mcp__<server>__<tool>`, ya con esa convención de nombre reservada desde el diseño del MVP aunque el cliente no exista todavía (`source.kind = 'mcp'` está en el tipo desde el día 1; el `McpClient` en sí es v0.3).

**Alternativas consideradas.**
- *Un registro de tools separado para MCP, adaptado luego en el ToolProtocol*: descartada porque duplicaría la lógica de validación zod/ajv, clasificación de permisos y renderizado del protocolo (nativo/texto) para dos fuentes de tools que, desde la perspectiva del modelo, deberían ser indistinguibles.

**Consecuencias.** Cuando se implemente en v0.3, cada tool MCP pasará por las mismas validaciones de permisos que una builtin (categoría `mcp`, `ask` por tool por defecto) y por el mismo `ToolProtocol` ya elegido en el ADR-011, sin cambios en el runtime ni en la UI de permisos más allá de mostrar la categoría `mcp`. El costo de este diseño anticipado es mínimo: una variante de enum (`source.kind`) y un estado del enum `ToolCallStatus` (`awaiting_input`) reservados desde la migración 1, que es exactamente el tipo de costo que el principio 8 de la columna vertebral permite pagar por adelantado.

**Qué haría revisar esto.** Que la especificación de MCP cambie de forma incompatible entre la versión del SDK usada hoy (1.30) y la vigente al momento de implementar v0.3, lo cual ya está señalado como riesgo abierto en el roadmap.

---

## ADR-019: Ningún ajuste automático salvo capear `num_ctx` (CV ADR-7)

**Estado:** aceptada.

**Contexto.** La condición 11.C exige que cualquier ajuste automático sea visible y reversible, y sin `Benchmark`/`model_compat` real (ADR-016) todavía no hay evidencia medida en la que basar un ajuste automático de otros parámetros. Al mismo tiempo, Ollama recorta `num_ctx` a `contextMax` en silencio si se le pide un contexto mayor al que soporta el modelo `[VERIFICADO EN DOC OFICIAL: llm/llama_server.go]`, y el caso real del 17/09 (`gemma4:31b` con `context size set by user to 262144`, `cudaMalloc failed: out of memory` tras 1m14s, condición 12) muestra el costo de no anticipar ese límite: el OOM ocurre recién al cargar, después de que el usuario ya inició el run.

**Decisión.** El único ajuste automático del MVP es capear `EffectiveConfig.numCtx` al `contextMax` del modelo (derivado de `/api/show`) antes de enviar la solicitud. El ajuste se registra en `run_adjustments` (`param`, `requested`, `applied`, `reason`, `source`) y se muestra como evento `run.adjustment` en el chat y en el panel "Config efectiva", con un botón "Usar lo pedido" que reintenta con el valor original si el usuario lo prefiere. Cualquier otro caso en el que la estimación de `MemoryEstimator` (ADR-016) indique que el modelo no entra en VRAM **se avisa y se pregunta**; no se ajusta nada más de forma automática hasta que existan `evidence_compat_id` reales de `Benchmark` (v0.2/v0.3).

**Alternativas consideradas.**
- *Ajustar automáticamente `num_ctx` a lo que la estimación de VRAM sugiera como "seguro" (no solo al máximo del modelo)*: descartada para el MVP porque mezclaría un cálculo estimado (no medido) con una decisión que afecta directamente la calidad del contexto disponible para el agente, sin la evidencia que exige la condición 11.C para ese tipo de ajuste; queda para cuando haya `model_compat` medido.
- *No ajustar nada y dejar que Ollama recorte en silencio*: descartada porque el recorte silencioso de Ollama no queda registrado en `run_adjustments` ni es visible para el usuario, violando directamente la condición 11.C ("cualquier ajuste automático debe ser visible y reversible").
- *Bajar automáticamente a un modelo más chico si el pedido no entra*: descartada de plano porque cambiar de modelo nunca es automático (decisión explícita del usuario); ese caso siempre termina en "se avisa y se pregunta".

**Consecuencias.** Este es, por diseño, el único punto donde `AgentRuntime`/`ModelGateway` modifican un valor pedido sin preguntar antes de enviar la solicitud; todo el resto del sistema (incluida la mitigación de OOM del caso real del 17/09 para casos que no son "excede `contextMax`", como falta de VRAM con un `num_ctx` que sí entra dentro del límite del modelo pero no en la memoria disponible) pasa por aviso y confirmación. El panel de diagnósticos (§18 de la columna vertebral) puede citar el caso del 17/09 como ejemplo real de por qué este cap existe.

**Qué haría revisar esto.** Que `Benchmark` (ADR-016, v0.3) acumule suficientes `model_compat` medidos como para justificar, con evidencia y no con estimación, un segundo ajuste automático visible (por ejemplo, un `num_ctx` "seguro" medido por modelo); en ese momento este ADR se ampliaría, no se reemplazaría, porque el cap a `contextMax` sigue siendo necesario incluso con `Benchmark` disponible.

---

## Tabla resumen

| # | Decisión | Elección | Alternativa principal descartada | Revisar si… |
|---|---|---|---|---|
| 1 | Shell de escritorio | Electron 44 + electron-vite 5 | Tauri (sin Rust en el equipo) | Smoke test de nativos falla sin remedio |
| 2 | Dónde corre el runtime | `@saurio/runtime` en `main`, indexer en `utilityProcess` | Runtime en `utilityProcess` propio | Batching de 30 ms genera lag medido |
| 3 | Driver SQLite | better-sqlite3 13 tras `driver.ts` | `node:sqlite` (no verificado en Electron 44) | Sin binarios prebuilt para la ABI de Electron 44 |
| 4 | ORM | drizzle-orm 0.45 + SQL crudo para JSON1 | Prisma | Se necesitan queries dinámicas que drizzle no exprese bien |
| 5 | Persistencia | Híbrido: `run_events` fuente de verdad + proyecciones | Solo tablas mutables | `saurio db rebuild` se vuelve inaceptablemente lento |
| 6 | Edición de archivos | `edit_file` cascada + `write_file` | Unified diff | `eval/` propio muestra otro formato mejor con los modelos elegidos |
| 7 | Checkpoint | Snapshots content-addressed por archivo | Shadow git como mecanismo principal | Volumen de blobs insostenible |
| 8 | Repo map | web-tree-sitter 0.27 + grammars propias + PageRank | Embeddings + vector store | Incompatibilidad de grammars confirmada sin solución |
| 9 | Búsqueda | `@vscode/ripgrep` | fast-glob + regex manual | Se necesita búsqueda semántica (problema distinto) |
| 10 | Terminal | node-pty+xterm (usuario) / spawn (agente) | pty también para el agente | node-pty no carga en Electron 44 sin rebuild |
| 11 | Protocolo de tools | Nativo + texto Hermes tras `ToolProtocol` | Solo nativo | `eval/` muestra degradación fuerte en transporte texto |
| 12 | Conteo de tokens | Heurística calibrada con EMA | tiktoken WASM | EMA no converge, margen crece de forma permanente |
| 13 | Estado UI | zustand 5 reduciendo `RunEvent` | redux | Se necesita estado entre múltiples ventanas |
| 14 | Validación IPC | Mapa zod `channel → {input,output}` | electron-trpc | Mapa único se vuelve inmanejable por tamaño |
| 15 | Slots / Scheduler | Scheduler dentro del Gateway, slot por turno | Scheduler como capa separada antes del Gateway | Pérdida de cache por interleaving es peor de lo tolerable |
| 16 | Model Manager | Estimación (ModelManager) separada de medición (Benchmark) | Que ModelManager mida y estime a la vez | Fórmula de estimación diverge sistemáticamente de lo medido |
| 17 | Fallos / write-ahead | Registrar `pending`/`running` antes de ejecutar; nunca auto-reejecutar | Registrar después de ejecutar | Escritura atómica falla silenciosamente en Windows |
| 18 | MCP | Cliente detrás del mismo `ToolRegistry`, diferido a v0.3 | Registro separado para tools MCP | Spec de MCP cambia de forma incompatible |
| 19 | Ajustes automáticos (CV ADR-7) | Solo capear `num_ctx` a `contextMax`, registrado y visible | Ajustar automáticamente a un valor "seguro" estimado | `Benchmark` acumula evidencia medida para un segundo ajuste |

---

## Imprescindible para el MVP

Los ADR 1 a 5, 10 a 14 y 17 son de aplicación inmediata en el hito 1 (afectan el runtime, la persistencia y la recuperación de fallos, que son el núcleo del recorrido de validación #1). Los ADR 6, 7, 8, 9 y 11 también son de aplicación inmediata porque sostienen las tools builtin y el modo `agent`. El ADR-15 aplica desde el MVP con 1 slot (sin efecto visible de paralelismo todavía). El ADR-16 aplica parcialmente: la parte de estimación (`ModelManager`) es del MVP; la parte de medición (`Benchmark`) es v0.3. El ADR-18 (MCP) es diseño únicamente; su implementación es v0.3. El ADR-19 (cap de `num_ctx`) es de aplicación inmediata: sin él, el caso real del 17/09 (OOM al cargar `gemma4:31b` con contexto 256K) se repite desde el primer run del MVP.

## Previsto para más adelante

Implementación de `McpClient` (ADR-18, v0.3); `Benchmark` y `model_compat` como fuente de verdad medida (parte del ADR-16, v0.3); `OllamaProcessManager` en modo managed, que interactúa con varios de estos ADR (Scheduler, Model Manager) pero no cambia ninguno de ellos, solo agrega un segundo modo de conexión al provider (v0.3); N slots reales y providers remotos (extensión del ADR-15, v0.4); un segundo ajuste automático basado en evidencia medida (extensión del ADR-19, sujeta a que exista `Benchmark`).

## Nomenclatura agregada

Ninguna. Todos los nombres de componentes, tablas, columnas, tipos, eventos y canales IPC usados en este documento provienen directamente de las secciones 1 a 5 de la columna vertebral.

## Desvíos respecto de la columna vertebral

Ninguno. Este documento aplica de forma consistente las correcciones ya indicadas como obligatorias por la condición 13: se cita el registro de **10 tools builtin** (no ocho) en el ADR-011, se aclara que en modo plan el modelo ve 6 tools y en modo agent ve las permitidas por defecto (las 10), y se documenta la guía de "6-8 tools" como recomendación para agentes personalizados y no como límite duro del registro. Además, se agregó la tabla de equivalencias ADR-00N ↔ CV ADR-N y el ADR-019 (CV ADR-7, cap de `num_ctx`), que faltaba pese a ser la decisión más citada por el resto de los documentos.

## Preguntas abiertas

Ninguna que cambie el diseño de estos ADR. Las preguntas abiertas de la sección 20 de la columna vertebral (autorización para descargar un modelo con `tools`, default de permiso `write`, aprobación de smoke tests, terminal por defecto, confirmación del modo attach de Ollama) son decisiones operativas del usuario previas al scaffolding, no decisiones de arquitectura que estos ADR dejen pendientes.
