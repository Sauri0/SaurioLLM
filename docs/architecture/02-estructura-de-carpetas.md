# Documento 02: Estructura de carpetas

Propósito: fijar el árbol de carpetas y archivos de SaurioLLM (monorepo pnpm + electron-vite), sus convenciones de importación, nombres y tests, y qué carpeta de datos usa la app en runtime, para que el scaffolding se haga a partir de esto sin decisiones ad hoc.

Leyenda: `[COMPROBADO EN EQUIPO]` `[VERIFICADO EN DOC OFICIAL]` `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]`

---

## 1. Árbol completo del proyecto

Este árbol reproduce literalmente la sección 3 de la columna vertebral (fuente de nomenclatura), con una línea de explicación por carpeta y por archivo clave. `[DECISIÓN DE DISEÑO]` salvo que se indique lo contrario.

```
saurio/                              # raíz del monorepo pnpm; nombre de paquete interno "saurio" (no confundir con el
                                      # nombre de producto/instalador "SaurioLLM", ver §6)
  package.json                       # scripts del workspace raíz (ver §4.1); sin dependencias de runtime propias
  pnpm-workspace.yaml                # declara apps/* y packages/* como paquetes del workspace
  electron-builder.yml               # config de empaquetado (asar, asarUnpack, appId, productName; ver §4.4)
  .npmrc                             # node-linker=hoisted [HIPÓTESIS A PROBAR si hace falta con electron-builder]

  apps/desktop/                      # única app Electron del monorepo (MVP); si en v0.4 hay más frontends, cada uno
                                      # es una apps/<nombre> nueva sin tocar packages/*
    electron.vite.config.ts          # config de electron-vite: build de main/preload con externalizeDepsPlugin,
                                      # build de renderer con plugin de React (ver §4.3)
    src/main/
      index.ts                       # bootstrap del proceso main: primera línea `app.setName('SaurioLLM')` (ver §6.1,
                                      # antes de cualquier app.getPath('userData')), crea BrowserWindow (con
                                      # persistencia de estado de ventana), corre migraciones de Persistence,
                                      # llama recover() al arrancar
      ipc/                           # un archivo por dominio IPC: project.ts, chat.ts, run.ts, permission.ts,
                                      # checkpoint.ts, models.ts, terminal.ts, metrics.ts, settings.ts, bench.ts;
                                      # cada uno llama registerHandler(channel, schema, fn) contra packages/shared/ipc.ts
      host/RuntimeHost.ts             # instancia @saurio/runtime y le inyecta el HostAdapter (diálogos nativos,
                                      # notificaciones del SO, resolución de paths); único punto donde el runtime
                                      # "toca" Electron
      services/terminal/              # TerminalService: envuelve node-pty y expone su salida por MessagePort
      services/ollama-process/        # OllamaProcessManager (v0.3): lanza `ollama serve` en modo managed
      services/system-sampler/        # SystemSampler: os.cpus()/os.freemem() (MVP) + nvidia-smi bajo demanda;
                                       # -lms (nvidia-smi loop) en v0.2 para el Panel de rendimiento continuo
    src/preload/index.ts              # único archivo del preload; contextBridge.exposeInMainWorld con invoke(),
                                       # onEvent() y terminalPort(); nunca expone ipcRenderer crudo
    src/renderer/
      index.html                      # documento HTML del renderer; CSP script-src 'self'
      src/main.tsx                    # entry point de React 19
      src/features/                   # un subdirectorio por panel de UI, cada uno dueño de su propio estado local:
        chat/                         # chat con tarjetas de mensaje/tool/permiso/checkpoint
        diff/                         # visor de diff con @codemirror/merge
        files/                        # árbol de archivos del proyecto
        terminal/                     # terminal xterm.js conectada al MessagePort del preload
        permissions/                  # tarjetas y ajustes de PermissionEngine
        tasks/                        # checklist de tasks del run activo
        models/                       # Centro de modelos (§17 de la columna vertebral)
        perf/                         # Panel de rendimiento (§18; UI mínima en el MVP, completa en v0.2)
        bench/                        # Banco de pruebas (§19; v0.3, carpeta vacía con placeholder en el MVP)
        settings/                     # ajustes de la app y del proyecto
      src/stores/                     # slices de zustand por dominio: projectStore, chatStore, runStore (reduce
                                       # RunEvent), modelsStore, perfStore, terminalStore
      src/ipc/client.ts               # cliente tipado derivado de packages/shared/src/ipc.ts (mismo mapa channel→schema)

  packages/shared/                    # contratos puros; CERO dependencias de Electron o React (regla de imports, §3)
    src/domain.ts                     # tipos de dominio: Project, Chat, Run, Agent, ChatMessage, ToolCall, ToolResult,
                                       # Checkpoint, ModelRef, Task, Profile, PermissionRequest, etc.
    src/enums.ts                      # única fuente de los zod enums: RunState, ToolCallStatus, PermissionCategory,
                                       # Mode, Locality; todo el resto del código importa el tipo desde acá, nunca
                                       # redefine sus valores
    src/events.ts                     # RunEvent como z.discriminatedUnion sobre `type`
    src/ipc.ts                        # mapa channel -> { input, output } (zod schemas); fuente de verdad de IPC

  packages/runtime/                   # @saurio/runtime; paquete Node puro, sin Electron ni React; se testea con
                                       # vitest fuera del proceso main (regla de imports, §3)
    src/agent/                        # RunController, RunStateMachine, LoopDetector, recover.ts
    src/events/                       # EventStore (append + proyecciones en una transacción) y projections/
                                       # (un archivo por proyección: messages.ts, toolCalls.ts, tasks.ts, runs.ts)
    src/context/                      # ContextBuilder, TokenEstimator, Compactor, budgets.ts, RepoMapClient
    src/tools/                        # ToolRegistry, WorkspaceFs, protocols/native.ts, protocols/text.ts
    src/tools/builtin/                # un archivo por tool: list_files, search_code, read_file, read_output,
                                       # edit_file, write_file, delete_file, run_command, task_update, finish
    src/permissions/                  # PermissionEngine, CommandParser/pwsh.ts, CommandParser/bash.ts, rules.ts,
                                       # protected.ts (protected paths + .saurioignore)
    src/checkpoint/                   # BlobStore, CheckpointService, RevertPlanner, diff.ts (wrapper de jsdiff)
    src/gateway/                      # ModelGateway, InferenceScheduler, ModelQueue, locality.ts, Provider.ts
                                       # (la interfaz que implementan los providers)
    src/gateway/providers/
      ollama/                         # client.ts (fetch), ndjson.ts (parser de streaming), schemas.ts (zod espejo
                                       # de api/types.go), provider.ts (implementa Provider)
      openai-compat/                  # v0.2: mismo patrón para LM Studio / llama-server OpenAI-compatible
    src/models/                       # ModelManager, MemoryEstimator, HardwareProbe, DownloadManager (v0.2),
                                       # RecommendationEngine (v0.3)
    src/telemetry/                    # MetricsAggregator, Diagnostics, ringBuffer.ts (buffer circular en memoria
                                       # para el Panel de rendimiento antes de agregarse a metrics_minute)
    src/benchmark/                    # v0.3: protocol.ts, suites/ (una tarea por archivo)
    src/mcp/                          # v0.3: McpConnection sobre @modelcontextprotocol/sdk
    src/persistence/                  # schema.ts (drizzle), migrations/ (numeradas, embebidas en el binario),
                                       # repositories/ (uno por tabla o grupo de tablas), driver.ts (encapsula
                                       # better-sqlite3; punto único de reemplazo por node:sqlite), rebuild.ts
                                       # (`saurio db rebuild`)
    src/tasks/                        # TaskManager

  packages/repomap/                   # motor de repo map, consumido por RepoMapClient (vive en packages/runtime)
    loader                            # carga de grammars .wasm vía web-tree-sitter
    queries/*.scm                     # queries *-tags.scm por lenguaje (derivadas de Aider, licencia Apache-2.0
                                       # con atribución obligatoria en NOTICE)
    tags.ts                           # extracción de tags (definiciones/referencias) por archivo
    graph.ts                          # construcción del grafo de referencias entre archivos
    pagerank.ts                       # ranking de archivos por relevancia
    render.ts                         # serializa el repo map a texto dentro del presupuesto de tokens

  resources/
    grammars/*.wasm                   # una .wasm por lenguaje soportado, compiladas por nosotros con
                                       # tree-sitter-cli >= 0.26 (ts, tsx, js, python en el MVP; el resto en v0.2)
    prompts/                          # system prompts por rol en Markdown (lead.md, coder.md, reviewer.md,
                                       # explorer.md...) + few-shot en JSON; su hash entra en effective_config_json
    model-catalog.json                # v0.2: catálogo curado de modelos recomendables por el Centro de modelos

  eval/                               # harness de evaluación de agentes, independiente de la app empaquetada
    fixtures/                         # repos miniatura usados como workspace de las tareas
    tasks/                            # una tarea por carpeta: prompt, criterio de éxito, fixture asociado
    harness.ts                        # corredor de tareas contra packages/runtime en modo headless
    eval_runs                         # base SQLite propia del harness, separada de saurio.db

  docs/adr/                           # ADR-001..NNN; un archivo por decisión de arquitectura relevante, numerado
                                       # correlativamente (ver ADRs de la columna vertebral §1.3 como ADR-001..007)
```

---

## 2. Qué carpetas existen desde el MVP y cuáles se agregan después

Esta sección proyecta la tabla de alcance de la columna vertebral (§16) sobre el árbol de carpetas; ante cualquier diferencia de detalle, manda esa tabla.

**Existen desde el MVP** (aunque algunas queden con un único archivo o un placeholder):
`apps/desktop/src/{main,preload,renderer}` completos, incluyendo `src/renderer/src/features/{chat,diff,files,terminal,permissions,tasks,models,settings}` (en `models/` solo la vista mínima del Centro de modelos: instalados, cargado/no cargado, capabilities, fit estimado, badge LOCAL); `packages/shared`; `packages/runtime` completo salvo los subdirectorios marcados v0.2/v0.3/v0.4 más abajo, que existen vacíos con un comentario `// v0.3` (o la versión que corresponda) en vez de código real, según el principio 8 de la columna vertebral (§1.1); `packages/repomap` limitado a ts/tsx/js/python; `resources/grammars` con esos cuatro lenguajes; `resources/prompts`; `eval/` con 5 tareas (criterio de "listo" del hito 1); `docs/adr/`.

**Se agregan o se llenan después:**
- `src/renderer/src/features/perf/` pasa de una vista mínima (MVP) a el Panel de rendimiento completo con `SystemSampler` continuo (v0.2).
- `src/renderer/src/features/bench/` se activa recién en v0.3 (Banco de pruebas, Benchmark, `model_compat`).
- `apps/desktop/src/main/services/ollama-process/` se implementa en v0.3 (modo managed); existe como carpeta vacía antes.
- `packages/runtime/src/gateway/providers/openai-compat/` se implementa en v0.2 (LM Studio / llama-server).
- `packages/runtime/src/models/` gana `DownloadManager` (v0.2) y `RecommendationEngine` (v0.3); `HardwareProbe` y `MemoryEstimator` existen desde el MVP.
- `packages/runtime/src/benchmark/` y `packages/runtime/src/mcp/` se implementan en v0.3.
- `resources/model-catalog.json` se agrega en v0.2.
- `resources/grammars/*.wasm` gana 10 lenguajes más en v0.2.
- Un futuro `apps/desktop/src/main/services/shadow-git/` (detector de cambios por comandos vía `GIT_DIR` externo, §13 de la columna vertebral) se agrega en v0.3 si no entra antes; **nunca** reemplaza al `CheckpointService`.
- `packages/runtime/src/agent/` gana soporte de subagentes (`delegate`, `parent_run_id`) recién en v0.4; hasta entonces `RunController` no acepta runs hijos aunque la columna `runs.parent_run_id` ya exista en el esquema desde la migración 1.

---

## 3. Convenciones de nombres y límites entre módulos

**Nombres.** Identificadores de código (variables, funciones, tipos, interfaces, nombres de archivo y de carpeta) en inglés, siguiendo los nombres ya fijados por la columna vertebral (`RunController`, `ToolRegistry`, `WorkspaceFs`, etc.); no se traducen ni se abrevian de otra forma. Carpetas en `kebab-case` o una sola palabra en minúsculas (`ollama-process`, `system-sampler`); archivos de clase/servicio en `PascalCase.ts` cuando exportan una clase o factory principal (`ModelGateway.ts`, `CheckpointService.ts`), y en `camelCase.ts` cuando exportan funciones sueltas o un módulo de utilidades (`budgets.ts`, `diff.ts`). Comentarios y documentación (Markdown) en español rioplatense neutro, como el resto de los documentos.

**Regla de imports (capas).** Reproduce la regla de la columna vertebral (§2): ninguna capa importa la de arriba; `providers/*` solo se importa desde `gateway/`. En términos de paquetes del monorepo:
- `packages/shared` no importa nada de `packages/runtime`, `packages/repomap` ni de `apps/desktop`. Es la base de la que todos dependen.
- `packages/runtime` importa `packages/shared` y `packages/repomap`; **nunca** importa nada de `apps/desktop` ni paquetes de Electron o React (`electron`, `react`, `zustand`). Esto es lo que permite testear el paquete con vitest sin levantar Electron.
- `packages/repomap` importa `packages/shared` (para tipos) pero no conoce `packages/runtime`; se comunica con él únicamente a través de `RepoMapClient`, que vive del lado de `packages/runtime/src/context/`.
- `apps/desktop/src/main` importa `packages/runtime` (vía `RuntimeHost`), `packages/shared` y paquetes de Electron/Node; es el único lugar del monorepo con permiso para importar `electron` en el lado "backend".
- `apps/desktop/src/preload` importa únicamente `electron` y `packages/shared` (para tipar `invoke`/`onEvent`); no importa `packages/runtime`.
- `apps/desktop/src/renderer` importa `packages/shared` (tipos e IPC) y librerías de UI (`react`, `zustand`, `@codemirror/*`, `@xterm/xterm`); **nunca** importa `packages/runtime` ni módulos de Node (`fs`, `child_process`) — todo lo que necesita del sistema pasa por `src/ipc/client.ts`.
- Dentro de `packages/runtime`, `gateway/providers/*` solo se importa desde `gateway/` (nunca desde `agent/`, `tools/` ni desde `apps/desktop`), para que cambiar o agregar un provider no toque el resto del runtime.

**Dónde van los schemas zod compartidos.** Viven exclusivamente en `packages/shared/src/{domain,enums,events,ipc}.ts`. Un schema que describe una forma de datos usada por más de una capa (por ejemplo, el payload de un evento de IPC, o el shape de un `ToolCall`) se define una sola vez ahí y se importa con `z.infer<>` donde haga falta; no se duplica ni se redefine "parecido" en `packages/runtime` o en el renderer. Los schemas que son puramente internos de un provider (por ejemplo, el espejo de `api/types.go` de Ollama) viven junto al provider, en `packages/runtime/src/gateway/providers/ollama/schemas.ts`, porque ningún otro módulo debe depender de la forma exacta de la respuesta HTTP de Ollama: lo que cruza esa frontera ya son los tipos de `packages/shared`.

**Dónde van los tests.** `[DECISIÓN DE DISEÑO]`, no está fijado de forma explícita en la columna vertebral más allá de "el paquete se prueba con vitest sin Electron" (§1.2). Convención: tests unitarios colocados junto al archivo que prueban, como `NombreOriginal.test.ts` (por ejemplo `RunStateMachine.test.ts` al lado de `RunStateMachine.ts`); no se usa una carpeta `__tests__` separada, para que mover o borrar un módulo arrastre su test. Tests de integración que cruzan varios módulos de `packages/runtime` (por ejemplo, un run completo contra un `OllamaProvider` fake) van en `packages/runtime/src/agent/__integration__/`, con doble guion bajo para distinguirlos a simple vista de los unitarios. El harness de `eval/` es un tipo de prueba distinto (evalúa calidad de agente contra fixtures reales, no corrección de código) y por eso vive fuera de `packages/runtime`, como carpeta de primer nivel.

**Grammars .wasm y binarios como ripgrep.** Los `.wasm` de tree-sitter se compilan una vez con `tree-sitter-cli` y se versionan en `resources/grammars/`; no se descargan en runtime ni se instalan como dependencia npm de grammar precompilada, porque la columna vertebral marca como riesgo la incompatibilidad de `tree-sitter-wasms 0.1.13` con `web-tree-sitter 0.27` `[HIPÓTESIS A PROBAR, fuente secundaria]`. El binario de `@vscode/ripgrep` vive donde pnpm lo instale dentro de `node_modules/@vscode/ripgrep*/`; no se copia a `resources/`, sino que se declara explícitamente en `asarUnpack` de `electron-builder.yml` (ver §4.4) junto con los `.node` y los `.wasm`, para que el binario nativo quede accesible fuera del `.asar` empaquetado `[VERIFICADO EN DOC OFICIAL: electron.build/docs, investigación 2 C.8]`.

---

## 4. Archivos de configuración de la raíz

Se describen, no se escriben (regla explícita del brief). El objetivo es que quien haga el scaffolding sepa qué tiene que crear y con qué contenido conceptual, sin que este documento contenga ya el código de esos archivos.

### 4.1 `package.json` (raíz del workspace)

Scripts previstos `[DECISIÓN DE DISEÑO]`, todos delegando a los paquetes vía pnpm `-r`/`--filter`:
- `dev`: levanta `electron-vite dev` sobre `apps/desktop` con hot-reload de main/preload/renderer.
- `build`: `electron-vite build` (compila los tres targets) seguido de `electron-builder` para generar el instalador de Windows.
- `typecheck`: `tsc --build` sobre las referencias de proyecto (ver §4.2), sin emitir, para validar todo el monorepo de una pasada.
- `test`: `vitest run` filtrado a `packages/runtime` y `packages/repomap` (los paquetes Node puros); `apps/desktop` no tiene tests unitarios propios en el MVP, solo smoke tests manuales del recorrido de validación #1.
- `test:eval`: corre `eval/harness.ts` contra el modelo indicado por variable de entorno, para el criterio de "listo" del hito 1 (§10 de la columna vertebral).
- `db:rebuild`: invoca `saurio db rebuild` (packages/runtime/src/persistence/rebuild.ts) contra la base del usuario, para mantenimiento manual.
- `lint`: eslint sobre todo el workspace con una config compartida en la raíz.

No lleva dependencias de runtime propias: todas las dependencias reales viven en `apps/desktop/package.json` y en cada `packages/*/package.json`, siguiendo el patrón estándar de monorepo pnpm, para que `electron-builder` empaquete únicamente lo que `apps/desktop` necesita en producción.

### 4.2 `tsconfig` por target

`[DECISIÓN DE DISEÑO]`, nombres nuevos (ver §7 Nomenclatura agregada). Un `tsconfig.base.json` en la raíz fija opciones compartidas (`strict: true`, `moduleResolution: bundler`, `target` acorde a Node 24/Electron 44). Cada paquete y cada target de `apps/desktop` extiende esa base con su propio `tsconfig.json`:
- `apps/desktop/src/main/tsconfig.json` y `.../preload/tsconfig.json`: `module`/`lib` de Node, sin DOM.
- `apps/desktop/src/renderer/tsconfig.json`: `lib` con DOM, JSX de React 19.
- `packages/shared/tsconfig.json`, `packages/runtime/tsconfig.json`, `packages/repomap/tsconfig.json`: Node puro, sin DOM ni Electron, coherente con la regla de imports del §3.

Se usan Project References (`references` + `composite: true`) para que `pnpm typecheck` recorra el grafo de dependencias en el orden correcto y para que los editores resuelvan tipos entre paquetes sin necesidad de build previo.

### 4.3 `electron.vite.config.ts`

Vive en `apps/desktop/`. Configura tres builds independientes: `main` y `preload` con `externalizeDepsPlugin()` (para que las dependencias nativas como `better-sqlite3` y `node-pty` no se agrupen en el bundle sino que se resuelvan como `node_modules` reales en producción `[VERIFICADO EN DOC OFICIAL: electron-vite.org/guide]`), y `renderer` con el plugin de React y alias hacia `packages/shared` para que el renderer importe tipos sin pasar por `dist/`.

### 4.4 `electron-builder.yml`

Fija `appId` (formato inverso de dominio, p. ej. `com.saurio.desktop`) y `productName: SaurioLLM` (nombre visible del instalador, del ejecutable y de las ventanas; ver §6.1 para por qué esto solo no alcanza para fijar la carpeta de datos del usuario); `asar: true`; `asarUnpack` con `["**/*.node", "node_modules/@vscode/ripgrep*/**", "**/*.wasm"]` (tal como fija la columna vertebral §3); target de instalador para Windows (NSIS); `afterSign`/firma de código quedan fuera del alcance del MVP y del hito 1.

---

## 5. `.gitignore` y `.saurioignore`: no confundir

Son cosas distintas y ambas se describen acá porque afectan qué carpetas quedan "visibles":
- `.gitignore` (del repo del usuario, si lo tiene) es de git; SaurioLLM lo lee de forma pasiva (`git status --porcelain`) pero nunca lo escribe ni lo interpreta para decidir qué mostrar en el árbol de archivos.
- `.saurioignore` es propio de SaurioLLM `[DECISIÓN DE DISEÑO]`, vive en la raíz del proyecto del usuario (no en el monorepo de SaurioLLM) y filtra qué archivos entran al repo map y a la lectura del agente (`read_file(!.env*)` es la regla `deny` por defecto en el preset `balanced`, según §13 de la columna vertebral). No afecta al árbol de archivos que ve el humano en la UI, solo lo que el modelo puede leer o indexar.

---

## 6. Carpeta de datos del usuario en runtime

### 6.1 Ubicación

`[DECISIÓN DE DISEÑO]`. Electron resuelve `app.getPath('userData')` como `appData + app.getName()`, y `app.getName()` sale del `package.json` empaquetado del proceso main (`productName` si está definido ahí, si no `name`) `[VERIFICADO EN DOC OFICIAL: electronjs.org/docs/latest/api/app#appgetnames y appgetpathname]` — **no** del `electron-builder.yml`: ese archivo solo nombra el instalador y sus metadatos, y en un monorepo pnpm el `package.json` que Electron empaqueta es el de `apps/desktop/`, cuyo `name` de paquete interno sería algo como `desktop` o `@saurio/desktop` si no se fija nada más, dando `%APPDATA%\desktop` (y encima un valor distinto entre `pnpm dev` y el instalador, porque `pnpm dev` no siempre reempaqueta ese `package.json`).

Para que la carpeta sea siempre `%APPDATA%\SaurioLLM`, sin depender de cómo se corra la app, se fijan dos cosas junto con `productName: SaurioLLM` de `electron-builder.yml` (§4.4):
- `"productName": "SaurioLLM"` explícito en `apps/desktop/package.json` (no alcanza con el `name` del paquete pnpm).
- `app.setName('SaurioLLM')` como primera línea de `src/main/index.ts`, antes de cualquier `app.getPath('userData')` — incluido el que corren las migraciones de `Persistence` al arrancar — para que el nombre quede fijado sin importar el entorno de ejecución.

La columna vertebral llama genéricamente a esta ubicación `appData` en las rutas `appData/blobs/<hash>` y `appData/tool-outputs/<toolCallId>.txt` (§4 y §13); este documento fija que ese `appData` es literalmente `app.getPath('userData')` una vez aplicadas las dos medidas de arriba, es decir `%APPDATA%\SaurioLLM` en Windows.

Esta carpeta es enteramente distinta de `N:\SaurioLLM` (el código fuente del proyecto) y de las carpetas de proyecto del usuario que SaurioLLM edita (workspaces arbitrarios que el usuario abre); nunca se mezclan.

### 6.2 Qué va en cada subcarpeta

```
%APPDATA%/SaurioLLM/
  saurio.db                 # única base SQLite (WAL activo); todas las tablas de la columna vertebral §4
  saurio.db-wal             # archivo WAL de SQLite mientras la app corre
  saurio.db-shm             # archivo de memoria compartida de SQLite (WAL)
  blobs/
    <hash>                  # pre/post imágenes de archivos tocados por el agente, content-addressed;
                             # alimenta CheckpointService y el diff (jsdiff); referenciadas por checkpoint_files
                             # y contadas por blobs.refcount (tabla de la columna vertebral §4)
  tool-outputs/
    <toolCallId>.txt         # salida completa de una tool call cuando supera 30.000 caracteres; lo que el
                              # modelo ve es solo tool_calls.result_preview, este archivo es el respaldo completo
  logs/
    main.log                 # log del proceso main (bootstrap, IPC, errores no capturados)
    <fecha>-renderer.log      # opcional; log de errores del renderer reenviados por IPC para diagnóstico
  cache/
    repo-map/
      <projectId>/            # cache de repo map por proyecto, espejo en disco de repo_map_cache (SQLite) para
                               # los .wasm cargados y resultados de PageRank costosos de recomputar; se invalida
                               # por mtime igual que la tabla
  shadow/
    <hash>/                   # v0.3: shadow repos (`GIT_DIR` externo) usados solo como detector de cambios por
                               # comandos; no existe en el MVP
```

`logs/` y `cache/repo-map/` no tienen tabla SQLite propia uno a uno: `logs/` es puramente de archivo (rotado por tamaño, sin retención definida en el MVP `[HIPÓTESIS A PROBAR el esquema de rotación]`) y `cache/repo-map/` es una proyección en disco de comodidad que siempre puede reconstruirse desde `repo_map_cache` y los archivos del proyecto; borrar `cache/` entero nunca pierde datos, solo obliga a reindexar. `blobs/` y `tool-outputs/` sí son fuente primaria (no derivables de otra cosa) y por eso `saurio db rebuild` (columna vertebral §4) explícitamente no los toca.

### 6.3 Qué existe desde el MVP

`saurio.db` (+ `-wal`/`-shm`), `blobs/`, `tool-outputs/`, `logs/` y `cache/repo-map/` existen desde el MVP. `shadow/` se crea recién si v0.3 activa el shadow repo detector; hasta entonces la carpeta no existe (no se crea vacía de antemano, para no sugerir una funcionalidad que todavía no corre).

---

## Imprescindible para el MVP

- El árbol completo de `apps/desktop` (main/preload/renderer) y de `packages/{shared,runtime,repomap}` tal como se detalla en §1 y §2, con los subdirectorios v0.2/v0.3/v0.4 presentes pero vacíos (principio 8 de la columna vertebral).
- Las cuatro subcarpetas activas de `%APPDATA%/SaurioLLM` (`blobs/`, `tool-outputs/`, `logs/`, `cache/repo-map/`) y el archivo `saurio.db`.
- Los archivos de configuración raíz descritos en §4 (`package.json`, `pnpm-workspace.yaml`, `electron-builder.yml`, `.npmrc`, `tsconfig.base.json` + un `tsconfig.json` por target, `electron.vite.config.ts`).
- La regla de imports entre capas (§3) y la convención de tests colocados (§3), porque condicionan cómo se organiza cualquier código que se escriba desde el primer commit del scaffolding.

## Previsto para más adelante

- `shadow/` en `%APPDATA%/SaurioLLM` y `packages/runtime/src/mcp/`, `.../benchmark/` con contenido real (v0.3).
- `resources/model-catalog.json` y `packages/runtime/src/models/DownloadManager` (v0.2).
- `apps/desktop/src/main/services/ollama-process/` con contenido real (v0.3).
- Subagentes en `packages/runtime/src/agent/` y una eventual segunda `apps/<nombre>` si se agrega otro frontend (v0.4).

## Nomenclatura agregada

Nombres nuevos derivados en este documento, no presentes literalmente en la columna vertebral, con el mismo estilo que ella usa:

- `tsconfig.base.json`: config TS compartida en la raíz de la que heredan todos los `tsconfig.json` de paquetes y targets (§4.2).
- Un `tsconfig.json` por paquete/target (`apps/desktop/src/main/tsconfig.json`, `.../preload/tsconfig.json`, `.../renderer/tsconfig.json`, `packages/shared/tsconfig.json`, `packages/runtime/tsconfig.json`, `packages/repomap/tsconfig.json`), todos con Project References.
- Convención de sufijo `.test.ts` colocado junto al archivo probado, y carpeta `__integration__/` para tests de integración dentro de `packages/runtime/src/agent/` (§3).
- `appId: com.saurio.desktop` y `productName: SaurioLLM` como valores concretos de `electron-builder.yml` (§4.4); `"productName": "SaurioLLM"` también en `apps/desktop/package.json` y la llamada `app.setName('SaurioLLM')` como primera línea de `src/main/index.ts` (§1 y §6.1), de los que en conjunto se deriva la ruta `%APPDATA%\SaurioLLM`.
- Scripts de `package.json` raíz: `dev`, `build`, `typecheck`, `test`, `test:eval`, `db:rebuild`, `lint` (§4.1).
- Subcarpetas de runtime `logs/` y `cache/repo-map/` dentro de `%APPDATA%/SaurioLLM` (§6.2); la columna vertebral solo nombra `blobs/` y `tool-outputs/` explícitamente.

## Desvíos respecto de la columna vertebral

- **Qué:** la columna vertebral nombra la carpeta de datos del usuario genéricamente como `appData` (en las rutas `appData/blobs/<hash>` y `appData/tool-outputs/<toolCallId>.txt`, §4 y §13) pero no fija un `productName` ni, por lo tanto, la ruta concreta en Windows. **Por qué:** el brief de este documento pide explícitamente describir "carpeta de datos del usuario en runtime (%APPDATA%/SaurioLLM...)", así que se fijó `productName: SaurioLLM` en `electron-builder.yml`, replicado como `"productName": "SaurioLLM"` en `apps/desktop/package.json` y reforzado con `app.setName('SaurioLLM')` al inicio de `src/main/index.ts` (§6.1), para que `app.getPath('userData')` resuelva a `%APPDATA%\SaurioLLM` de forma consistente con lo que el usuario ya espera, sin depender de si `apps/desktop/package.json` trae o no ese campo ni de si el entorno es `pnpm dev` o el instalador. No cambia ningún dato ni tabla de la columna vertebral, solo nombra algo que estaba implícito y corrige cómo Electron resuelve `app.getName()` en la práctica (no lee `electron-builder.yml` directamente).
- **Qué:** la ubicación de los tests (colocados vs. `__tests__/`) y la convención de tests de integración (`__integration__/`) no están fijadas en la columna vertebral, que solo dice "se prueba con vitest sin Electron" (§1.2, tabla de decisiones). **Por qué:** el brief pide indicar "dónde van los tests" como parte de las convenciones obligatorias de este documento; se optó por colocación junto al archivo (patrón más común en monorepos TS y el que menos fricción genera al mover o borrar módulos) en vez de inventar una tabla o esquema nuevo en la columna vertebral. Es una convención de bajo costo de cambiar si el usuario prefiere otra.

## Preguntas abiertas

Ninguna de las decisiones de este documento cambia el diseño fijado en la columna vertebral; no hay preguntas abiertas nuevas que agregar a su §20.
