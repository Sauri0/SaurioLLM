# Manual de uso — SaurioLLM (MVP)

Guía simple para probar la app. Si algo no funciona como dice acá, es información útil:
anotalo (ver la sección "Cómo reportar un problema" al final).

## 1. Requisitos

- **Windows 11** (target principal de esta versión).
- **Node.js >= 24.14** (probado con 24.14.1 y con el 24.21.0 que trae embebido Electron 44.4.2).
- **pnpm 10** (probado con 10.33.0).
- **Ollama** corriendo en `http://127.0.0.1:11434`, con estos dos modelos instalados:
  - `qwen3:8b` — modelo recomendado, usa tool calling nativo.
  - `qwen2.5-coder:7b` — modelo alternativo, usa tools "por texto" (transporte distinto, ver más abajo).
  - Instalalos con `ollama pull qwen3:8b` y `ollama pull qwen2.5-coder:7b` si todavía no los tenés.
- Dependencias del repo ya instaladas (`pnpm install` en la raíz del monorepo).

No hace falta configurar nada de Ollama a mano: los scripts de arranque lo detectan solos.

## 2. Cómo abrir la app

Hay dos scripts `.cmd` en la raíz del repo (`N:\SaurioLLM`). Se abren con doble clic.

- **`SaurioLLM.cmd`** — arranque normal para probar la app:
  1. Chequea si Ollama responde en `127.0.0.1:11434`.
  2. Si no responde, intenta levantarlo solo con `ollama serve` en segundo plano y espera hasta que
     conteste (hasta ~30 segundos).
  3. Corre `pnpm dev`, que compila y abre la ventana de SaurioLLM.
  4. Para cerrar todo: cerrá la ventana de la app y después la consola (o `Ctrl+C` en la consola).

- **`SaurioLLM-build.cmd`** — genera una versión empaquetada (no hace falta para probar la app día a
  día, solo si querés una carpeta "instalable" sin correr `pnpm dev`):
  1. `pnpm build` (compila main/preload/renderer).
  2. `pnpm --filter @saurio/desktop run build:installer -- --dir` (arma la carpeta desempaquetada con
     electron-builder en `apps/desktop/release/win-unpacked/`, sin generar el instalador `.exe` de
     NSIS — solo el ejecutable suelto, más rápido para probar).
  3. Al terminar, el ejecutable queda en `apps\desktop\release\win-unpacked\SaurioLLM.exe`: se puede
     abrir con doble clic como cualquier `.exe` de Windows.

  Para generar además el instalador NSIS (`SaurioLLM Setup <versión>.exe`, con asistente de
  instalación/desinstalación), corré `pnpm --filter @saurio/desktop run build:installer` (sin
  `-- --dir`) — deja el instalador en `apps/desktop/release/`, junto a la misma carpeta
  `win-unpacked/`.

  **Verificado de punta a punta en esta versión** (antes esta sección decía "este paso falla": el
  bug real era `electron-builder.yml` armando mal las rutas relativas al `cwd` de `apps/desktop/`,
  ya corregido en una sesión anterior a esta nota — lo que quedaba roto era la propia documentación).
  `apps\desktop\release\win-unpacked\SaurioLLM.exe` abre, dibuja la interfaz completa (verificado con
  una captura real, `docs/capturas/smoke-packaged-build.png`) y responde IPC contra Ollama real
  (`app:ping`/`models:list` con los modelos instalados en este equipo). Las grammars de tree-sitter
  (resaltado/repo map) y las queries de repo map viajan junto al ejecutable en
  `resources/grammars/` y `resources/repomap-queries/` — no dentro del `.asar` (es de solo lectura).

## 3. Primer uso, paso a paso

1. **Abrir una carpeta de proyecto.** Al abrir la app por primera vez, elegí la carpeta del proyecto
   que querés que SaurioLLM edite (un repo de código). Solo se puede tener **un proyecto abierto a la
   vez** en esta versión.
2. **Elegir el modelo.** En el selector de modelo del chat, elegí `qwen3:8b` (recomendado: tool calling
   nativo, es el que se probó de punta a punta) o `qwen2.5-coder:7b` (tools por texto, transporte
   distinto y menos ejercitado en pruebas reales).
3. **Elegir el modo:**
   - **Modo `plan`**: el modelo puede leer archivos y proponer un plan, pero no edita nada. Útil para
     pedirle que entienda el proyecto o describa un cambio antes de tocarlo.
   - **Modo `agent`**: el modelo puede editar archivos, crear/borrar archivos, correr comandos, etc.
     (según el preset de permisos activo).
4. **Pedir un cambio.** Escribí el pedido en el chat (por ejemplo: "arreglá el bug de la función X" o
   "agregá un endpoint que haga Y"). El modelo va a ir respondiendo en streaming.
5. **Ver las tarjetas de herramienta ("tool cards").** Cada vez que el modelo usa una herramienta
   (leer un archivo, editarlo, correr un comando, buscar código) aparece una tarjeta en el chat con el
   nombre de la tool, sus argumentos y el resultado. En modo `agent`, las tools que modifican archivos
   (`edit_file`, `write_file`, `delete_file`) generan además un **checkpoint** automático antes de
   aplicar el cambio.
6. **Permisos.** El preset por defecto es `balanced`, que en esta versión tiene `write = allow` dentro
   de la carpeta del proyecto: el modelo puede escribir archivos sin pedir confirmación cada vez.
   Comandos marcados como críticos sí van a mostrar una tarjeta de permiso pidiendo que confirmes antes
   de ejecutarlos. **El flujo de permiso en modo "preguntar siempre" (`ask`) no se probó todavía de
   punta a punta contra un modelo real en esta versión** — si lo activás y algo se comporta raro,
   es justamente lo que falta validar.
7. **Revisar el diff.** Desde la tarjeta de checkpoint (o el panel de archivos) podés ver el diff
   exacto de lo que cambió (`+N -M` líneas) antes o después de que se haya aplicado.
8. **Deshacer (revert).** Cada checkpoint se puede revertir individualmente: el archivo vuelve
   exactamente a como estaba antes de esa edición puntual (comparación probada byte a byte en las
   pruebas de esta versión).
9. **Terminal.** Hay un panel de terminal integrado (usa PowerShell de Windows por defecto, o `pwsh`
   si está instalado) para correr comandos vos mismo, en paralelo a lo que hace el agente.
10. **Centro de modelos.** Tres pestañas: "Instalados" (modelos detectados en vivo desde
    `127.0.0.1:11434`, con capabilities y ajuste estimado de VRAM), "Explorar" (catálogo curado,
    descargar/borrar modelos) y "Descargas" (progreso de la sesión actual). Ver §4 para el detalle.
11. **Panel de rendimiento.** CPU/RAM/GPU/VRAM en vivo (con gráficos de los últimos ~10 minutos
    mientras el panel está abierto), tokens/segundo de las respuestas del modelo, y una sección de
    diagnósticos con acciones sugeridas.

## 4. Qué está y qué no está en esta versión

### Sí está (probado de punta a punta contra Ollama real, ver `docs/architecture/16-estado-de-implementacion.md` §6)

- Listar modelos reales de Ollama y elegir uno.
- Correr un chat en modo `plan` hasta terminar (`completed`), con tool calls de lectura reales
  (`list_files`, `read_file`).
- Correr un chat en modo `agent` que edita un archivo real (`edit_file`), con checkpoint, diff y
  métricas de tokens/segundo.
- Ver el diff de un checkpoint.
- Revertir un checkpoint (el archivo vuelve exacto a su contenido original).
- Cerrar la app y volver a abrirla: el historial de chats, mensajes, tool calls y checkpoints se
  conserva (base SQLite persistente en `%APPDATA%\SaurioLLM`).

### Nuevo en esta pasada (integración parcial de escritorio)

- **Panel de archivos real**: `files:tree`/`files:read` ya existen (antes degradaba con un aviso).
  Árbol perezoso por carpeta (cada clic en una carpeta pide sus hijos, nunca el repo entero de una),
  `fs.watch` marca "modificado externamente" en vivo, y seleccionar un archivo lo abre en un visor de
  solo lectura con CodeMirror (cargado en un chunk aparte, no infla el bundle inicial).
- **Carpeta de modelos detectada**: el Centro de modelos ahora muestra la carpeta `OLLAMA_MODELS`
  detectada (variable de usuario/máquina o default), si está validada contra los manifests instalados,
  y el espacio libre/total del disco (`fs.statfs`). Los avisos de modo attach (exposición en red,
  contexto 256K de la app de bandeja) salen del mismo canal, en modo lectura, sin ningún botón que
  cambie configuración de Ollama.
- **Cambiar modelo/modo de un chat ya creado** desde selectores en la cabecera del chat
  (`chat:setModel`/`chat:setMode`); no afecta un run en curso, solo el próximo turno.
- **Terminal con varias pestañas** y puerto de datos real (antes había una nota de que el preload
  exponía un stub; ya no es así — cada pestaña es una sesión `node-pty` propia).
- **Un solo proyecto abierto a la vez, con cancelación real**: abrir otro proyecto cancela los runs
  que hubieran quedado vivos del proyecto anterior.
- **Code-splitting**: CodeMirror y xterm.js salen del bundle inicial del renderer (`FileViewer` y
  `TerminalPanel` se cargan con `React.lazy` recién cuando se usan).

### Nuevo en esta pasada (Centro de modelos v0.2/v0.3, Panel de rendimiento v0.2, Ajustes, onboarding)

- **Descargar/borrar modelos desde la app** (`DownloadManager`, doc 13 §5): el Centro de modelos
  ahora tiene pestañas **Instalados / Explorar / Descargas**. "Explorar" muestra el catálogo curado
  (`resources/model-catalog.json`, 16 modelos con tamaño verificado contra el registry real de
  Ollama) con filtro por uso (programación/conversación/análisis/visión), botón "Descargar" con
  progreso en vivo (velocidad, ETA, cancelación) y "Eliminar" con confirmación mostrando los GB a
  liberar (hace `unload` antes si el modelo está cargado, y se bloquea si el scheduler lo tiene en
  cola). Probado de punta a punta contra Ollama real: se descargó y volvió a borrar `all-minilm`
  (~46 MB) con progreso real medido. **Limitación conocida**: si no hay espacio suficiente
  (`checkSpace`, margen de 2 GiB), el pull se rechaza con un error antes de crear ningún registro —
  no queda un estado `insufficient_space` visible en una tabla `downloads` persistida, porque esa
  tabla (ya migrada) no admite ese valor en su columna `status` y ampliar el `CHECK` es una migración
  de `packages/runtime/src/persistence` (zona de otro agente en esta sesión). El historial de
  "Descargas" tampoco sobrevive a un reinicio de la app todavía (vive en memoria del proceso).
- **Recomendaciones de modelos según tu hardware** (`RecommendationEngine`, doc 13 §8): se usa en el
  asistente de primer arranque (ver más abajo) para sugerir modelos que entran en tu GPU. La fórmula
  de "entra/no entra" para un modelo **todavía no instalado** es más simple que la de un modelo ya
  instalado (no tiene la arquitectura exacta hasta que `/api/show` responde) — está marcada
  `estimado` siempre y documentada como aproximación en el código.
- **Panel de rendimiento con muestreo continuo** (`MetricsTicker`, doc 14 §6/§8): mientras el panel
  está abierto (o hay una tarea real corriendo en el scheduler), CPU/RAM/GPU/VRAM/temperatura/potencia
  se miden cada 2 s, se ven en gráficos de línea simples (SVG propio, sin librería) de los últimos
  ~10 minutos, y se agregan por minuto en la tabla `metrics_minute` con retención de 30 días. Sección
  nueva de "Diagnósticos" (poca VRAM libre, cola larga del scheduler, offload a CPU, Ollama caído,
  contexto no coincidente) con la evidencia medida y una acción sugerida — nunca cambia nada solo.
- **Ajustes nuevos**: toggle de mitigación de GPU (antes solo se podía tocar editando
  `settings.local.json` a mano o con la variable `SAURIO_GPU=1`; requiere reiniciar la app para que
  el cambio tenga efecto) y `num_ctx` por defecto por modelo, editable por modelo instalado —
  alimenta el ajuste estimado que se ve en "Instalados" **y** (desde la pasada de Proveedores/API, ver
  abajo) el `num_ctx` real que un run manda al modelo.
- **Asistente de primer arranque**: se muestra una sola vez. Si no detecta Ollama corriendo, ofrece
  "Modelos en mi PC" (abre `https://ollama.com/download` en tu navegador tras pedir confirmación
  explícita — SaurioLLM no instala nada) o "Tengo una clave de API" (te lleva a Ajustes > Proveedores).
  Si Ollama ya está corriendo, recomienda modelos para programar en tu equipo. Se puede reabrir desde
  Ajustes ("Volver a ver el asistente de primer arranque").

### Nuevo en esta pasada (Proveedores/API, frontera local-nube)

- **Ajustes > Proveedores es real**: agregar un proveedor (Ollama attach, OpenAI, OpenRouter,
  Anthropic u "OpenAI-compatible personalizado" — LM Studio, llama.cpp server, vLLM, Groq...), pegar
  su clave de API (se guarda cifrada con `safeStorage` de Electron; nunca se ve de nuevo, solo
  "clave configurada: sí" + los últimos 4 caracteres), "Probar conexión" (health + listado de modelos
  reales), habilitar/deshabilitar y borrar. Los modelos de todos los proveedores habilitados aparecen
  juntos en `models:list`, cada uno con su localidad real.
- **Selector de modelo agrupado por proveedor**, en la barra lateral (próximo chat) y en la cabecera
  del chat activo, con badge **LOCAL** / **LAN** / **NUBE** según de dónde viene cada modelo.
- **Frontera local/nube**: elegir un modelo NUBE para un chat (nuevo o ya creado) pide una confirmación
  explícita la primera vez por proyecto ("el contenido de este chat va a salir de tu PC hacia
  \<proveedor\>"); un ajuste global "Solo local" (Ajustes > Localidad) bloquea cualquier modelo no
  local aunque ya hubiera consentimiento. Nunca hay fallback automático a un modelo distinto del
  elegido. Cada llamada no local queda registrada en `audit_log`. El badge NUBE se ve en la cabecera
  del chat y junto a cada mensaje del agente mientras el chat use un modelo no local — limitación
  conocida: el badge por mensaje refleja el modelo **vigente** del chat, no necesariamente el que
  generó ese mensaje puntual si el chat cambió de modelo en el medio (no se persiste esa asociación
  por mensaje todavía).
- **Tokens de entrada/salida bajo cada mensaje**, incluso después de reabrir la app (antes solo se
  veían durante la sesión en la que se generaron). El costo en moneda siempre aparece como "no
  disponible": ningún proveedor del MVP (Ollama/OpenAI-compatible/Anthropic) lo informa.
- **`num_ctx` por defecto por modelo (Ajustes) ya llega al run real**, y el tope automático contra el
  `contextMax` real del modelo (`/api/show` o `/v1/models`, según el proveedor) también está
  conectado en la app (antes solo se probaba con `eval/harness.ts`, fuera de la app real).
- **Reanudar un permiso pendiente tras reiniciar la app**: si cerrás la app con un run esperando que
  contestes un permiso, al reabrir la tarjeta de permiso vuelve a aparecer sola (antes solo
  funcionaba si la app seguía viva).
- **Historial de Descargas persistido**: la pestaña "Descargas" del Centro de modelos ahora también
  muestra descargas de una sesión anterior (antes solo las de la sesión actual, en memoria).
- Probado de punta a punta contra OpenRouter real (agregar proveedor, probar conexión, listar
  modelos, un chat corto con un modelo gratuito, verificar el badge NUBE y el registro en
  `audit_log`) — ver `apps/desktop/src/main/host/createRuntime.providers.e2e.test.ts` (se salta si
  no hay `OPENROUTER_API_KEY` en el entorno).

### Todavía no está, o está a medias (conocido, documentado en el doc 16 §3 y §4)

- **Perfiles de configuración** — quedan para una versión futura.
- **Limpieza de estilos inline**: se hizo en las pantallas tocadas en las pasadas de diseño; varios
  otros paneles (chat, diff, archivos, terminal, sidebar, ErrorBoundary) todavía tienen
  `style={{...}}` sueltos.
- **El indexador del repo (repo map) corre en el mismo proceso** que el resto de la app (no en un
  proceso aparte todavía), así que un repo muy grande puede notarse en el uso de CPU/memoria del
  proceso principal.
- **`ripgrep`** no está en el PATH de este equipo de desarrollo; `search_code` y el repo map tienen un
  fallback manual cuando no lo encuentran, pero conviene verificar en tu equipo si `rg` está disponible
  para la búsqueda más rápida.
- **El estado "compactando contexto" nunca se muestra** en la UI aunque el motor de contexto sí
  compacta internamente cuando hace falta.
- **El badge NUBE por mensaje no es históricamente exacto** si un chat cambió de modelo local↔nube en
  el medio (ver arriba, "Nuevo en esta pasada (Proveedores/API...)").
- **El bundle del renderer pesa ~2.2 MB** (sin optimizar todavía para producción).
- **El flujo de permiso "preguntar siempre" (`ask`)** no se ejerció contra Ollama real en las pruebas
  de esta versión (el preset por defecto tiene `write = allow`, así que nunca se disparó la tarjeta de
  permiso durante las pruebas).
- **El modo `plan` no dejó tareas guardadas** en las pruebas: el modelo describe el plan en texto pero,
  con el prompt actual, no siempre llama a la herramienta que guarda tareas — no se determinó todavía
  si esto es lo esperado o una mejora pendiente del prompt.
- **Con modelos chicos (8B) el agente puede trabarse** reintentando una edición ambigua sin
  corregirse, hasta que el detector de bucles corta el run — es un comportamiento del modelo, no un
  error de la app, pero puede pasar. Si ves que el mismo `edit_file` se repite varias veces sin
  avanzar, es justamente esto: cancelá el run y pedí el cambio con más contexto (indicando la línea o
  función exacta).

## 5. Qué NO deshace el revert

Revertir un checkpoint deshace **el contenido del archivo o archivos que ese checkpoint tocó**, byte a
byte, hasta el estado justo antes de esa edición puntual. No deshace:

- **Comandos de terminal** que el modelo (o vos) hayan corrido — un `npm install`, un script que borró
  algo fuera del control de checkpoints, etc. Los checkpoints cubren archivos editados por las tools
  del agente, no efectos secundarios de comandos arbitrarios.
- **Cambios hechos después** del checkpoint sobre el mismo archivo por otra edición posterior (revertís
  ese checkpoint puntual, no "todo lo que pasó desde que abriste la app").
- **Archivos creados por otras tools sin pasar por el sistema de checkpoints** (fuera del flujo normal
  de `edit_file`/`write_file`/`delete_file`).
- **El historial del chat**: revertir un checkpoint no borra los mensajes ni las tarjetas de tool del
  chat, solo restaura el contenido del archivo en disco.
- **Cambios en la base de datos de SaurioLLM** (proyectos, chats, configuración): eso no tiene revert,
  solo los archivos del proyecto.

## 6. Cómo reportar un problema

Si algo falla o se comporta raro, esto es lo que hace falta para poder investigarlo:

1. **Qué pediste** (el mensaje exacto o cerca) y **qué modelo/modo** estabas usando.
2. **Los logs de la app**: `%APPDATA%\SaurioLLM\logs\` (se abre pegando esa ruta en el explorador de
   Windows, o `Win+R` → `%APPDATA%\SaurioLLM\logs`).
3. **La base de datos**, si hace falta inspeccionar el historial: `%APPDATA%\SaurioLLM\saurio.db`
   (SQLite; se puede abrir con cualquier visor de SQLite, por ejemplo DB Browser for SQLite). No la
   edites a mano salvo que sepas lo que estás haciendo.
4. Si la ventana se cerró sola o no abrió: contá si la app venía de un `SaurioLLM.cmd` recién abierto o
   de una sesión larga, y si tu equipo tuvo antes problemas de GPU con Electron (ver más abajo).

### Nota sobre GPU

En el equipo donde se armó esta versión, Electron 44 falla al crear un contexto de GPU
("`ContextResult::kFatalFailure`") por cómo está virtualizada la GPU de esa máquina, y el renderer se
cae si no se desactiva la aceleración por hardware. Por eso la app **desactiva la aceleración de GPU
por defecto** al arrancar. Si en tu equipo la GPU funciona bien y preferís la aceleración activada,
podés desactivar esta mitigación de dos formas:

- Corriendo la app con la variable de entorno `SAURIO_GPU=1` (por ejemplo, en PowerShell:
  `$env:SAURIO_GPU=1; pnpm dev`), solo para esa sesión.
- O guardando `{"app.gpuMitigationDisabled": true}` en `%APPDATA%\SaurioLLM\settings.local.json` para
  que quede así siempre.

Si la ventana no abre o se cierra sola apenas arranca, probá primero **sin** tocar nada (la mitigación
ya está activa por defecto); si igual falla, es información valiosa para reportar tal cual.

## 7. Resultados medidos en tu equipo

Todo lo marcado `[COMPROBADO EN EQUIPO]` sale de mediciones reales hechas en este equipo
(RTX 3060 Ti 8 GiB, Ollama 0.34.1 en `127.0.0.1:11434`, 2026-09-18), no son estimaciones. Fuente
completa: `N:/saurio-smoke/RESULTADOS-ollama.md`.

- **`qwen3:8b`, num_ctx 8192**: entra 100% en GPU (5.76 GiB), **59–65 tok/s** de generación,
  recarga del modelo en 4.2–17.8 s según esté o no en caché de disco `[COMPROBADO EN EQUIPO]`.
  Tool calling nativo confirmado (`message.tool_calls` correcto) `[COMPROBADO EN EQUIPO]`.
- **`qwen3:8b`, num_ctx 16384**: ya no entra 100% en GPU en este equipo (offload ≈19.5%),
  **17–20 tok/s** `[COMPROBADO EN EQUIPO]` — más lento que a 8192 porque parte del modelo queda en
  CPU/RAM.
- **`qwen2.5-coder:7b`, num_ctx 8192**: entra 100% en GPU (4.78 GiB), **66–68 tok/s**
  `[COMPROBADO EN EQUIPO]`. Con el prompt usado en la medición, este modelo **no usó tool calling
  nativo** pese a declarar `tools:true`: devolvió el llamado a la tool como texto plano en vez del
  campo nativo `[COMPROBADO EN EQUIPO]` — por eso la app usa el transporte de tools "por texto" para
  este modelo (`TextToolProtocol`) en vez del nativo.
- **Recorrido de punta a punta contra Ollama real** (chat con `qwen3:8b`, modo `plan` seguido de modo
  `agent` arreglando un bug real, checkpoint, diff, revert, cerrar y reabrir la base): **6/6 pasos en
  verde** en tres corridas finales consecutivas, runs de 4.2–17 s según cuántas veces el modelo
  reintentó una edición, ~62–66 tok/s de generación medidos, sin tareas persistidas en modo `plan`
  (ver limitación arriba) `[COMPROBADO EN EQUIPO, eval/harness.ts]`.
- **Cambiar `num_ctx` de un modelo ya cargado siempre fuerza una recarga completa** (4.2–6.3 s medidos)
  y pierde el caché del prompt — evitalo si no hace falta `[COMPROBADO EN EQUIPO]`.
- **Cancelar una respuesta en curso** (abort) libera el modelo casi de inmediato (63–274 ms) con
  `qwen3:8b`/`qwen2.5-coder:7b` (100% en GPU) `[COMPROBADO EN EQUIPO]`.

Estos números van a variar según la GPU, la VRAM libre en el momento (otros programas usando la
tarjeta de video) y qué tan grande sea el proyecto que tengas abierto.

## 8. Capturas

Capturas reales de la UI (pasada de diseño visual), tomadas con la herramienta de verificación
visual descripta en `docs/architecture/01-arquitectura.md` §4.1 (`SAURIO_SMOKE_SHOT` +
`SAURIO_SMOKE_STATE`, implementada en `apps/desktop/src/main/index.ts`): el proceso main espera a
que el renderer termine de dibujar, captura la ventana con `webContents.capturePage()` y guarda el
PNG — sin retoques manuales. El contenido de ejemplo (chat, tool calls, checkpoint, tareas, permiso)
sale de `apps/desktop/src/renderer/src/demo/demoState.ts`, que siembra los stores de zustand para
poder mostrar la UI con datos sin necesitar Ollama corriendo.

### Chat con tool calls, checkpoint y tareas

![Chat con tool calls, checkpoint y checklist de tareas](capturas/01-chat-overview.png)

Barra lateral con proyecto y chats, checklist de tareas fijo arriba del centro de chat, dos tarjetas
de tool call (una con salida colapsable abierta), tarjeta de checkpoint con archivos +48/−6, árbol de
archivos en el panel derecho y barra de estado inferior (LOCAL, modelo activo, contexto usado, tok/s,
estado de Ollama).

### Tarjeta de permiso

![Tarjeta de permiso pendiente](capturas/02-permiso.png)

Permiso de escritura destacado con un borde de acento ámbar (no un rojo agresivo), categoría y riesgo,
motivo del pedido, preview del diff, patrón a recordar editable y jerarquía de botones clara
(Permitir una vez en azul primario, alternativas secundarias, Denegar como acción fantasma).

### Estado vacío (sin proyecto abierto)

![Estado vacío antes de abrir un proyecto](capturas/03-estado-vacio.png)

Guía explícita en vez de una pantalla en blanco: "Abrí una carpeta para empezar" en el centro de
chat y en la lista de chats, botón primario "Abrir carpeta…" en la barra lateral, y la barra de
estado mostrando "Contexto: —" / "— tok/s" / "Ollama no conectado" en vez de valores inventados.

### Centro de modelos — Instalados y Explorar (sesión 2026-09-18, tarde)

![Centro de modelos, pestaña Instalados, con los 4 modelos reales de esta máquina](capturas/smoke-models-panel.png)
![Centro de modelos, pestaña Explorar, catálogo curado con qwen3:8b cargado en ese momento](capturas/smoke-models-explore.png)

Capturas contra Ollama real (no modo demo): "Instalados" muestra los 4 modelos reales de esta
máquina con la carpeta `N:\OllamaModels` detectada; "Explorar" muestra el catálogo curado con
filtros por uso, `qwen3:8b` marcado "cargado" (coincide con el estado real del servidor en el
momento de la captura) y modelos no instalados con el botón "Descargar" habilitado.

### Panel de rendimiento con muestreo continuo

![Panel de rendimiento con CPU/RAM/GPU/VRAM medidos y un modelo real cargado](capturas/smoke-perf-panel.png)

CPU 9.6%, RAM 14 GB, GPU 16.0%, VRAM 6.9 GB, temperatura 43°C y potencia 28 W, todos `measured`;
gráficos de historial de los últimos segundos (ring buffer en memoria) y "qwen3:8b" real en Runtime
con su VRAM/contexto efectivos — sin alertas activas en el momento de la captura.

### Asistente de primer arranque

![Asistente de primer arranque recomendando modelos para programar](capturas/smoke-onboarding-recommendations.png)

Con Ollama ya corriendo, el asistente recomienda `qwen2.5-coder:1.5b`, `qwen2.5-coder:3b` y
`qwen3:4b` para programar en este equipo (RecommendationEngine real, ordenados de menor a mayor
tamaño porque el objetivo por defecto es velocidad), cada uno con su badge LOCAL y "estimado".

### Ajustes > Proveedores

![Ajustes > Proveedores: agregar un proveedor OpenAI y Ollama ya configurado](capturas/smoke-settings-providers.png)

Formulario para agregar un proveedor (tipo, nombre, base URL, clave de API) y la lista de
proveedores configurados — acá, el Ollama local sembrado por defecto, con "Probar conexión" y el
campo para pegar/reemplazar la clave.

## 9. Usar modelos por API

Además de Ollama local, podés usar un modelo de OpenAI, OpenRouter, Anthropic o cualquier servidor
"OpenAI-compatible" (LM Studio, llama.cpp server, vLLM, Groq...) sin salir de la app.

### 9.1 Agregar un proveedor

1. Abrí **Ajustes** (ícono de engranaje en el panel derecho) y bajá hasta **Proveedores**.
2. Elegí el **tipo**: OpenAI, OpenRouter, Anthropic, Ollama (attach — para otra instancia, por
   ejemplo en tu LAN) u "OpenAI-compatible personalizado" (para LM Studio/llama.cpp/vLLM/Groq/etc.,
   con base URL libre).
3. Completá el **nombre** (cómo lo vas a ver en el selector de modelo) y, si hace falta, la
   **base URL** — los tipos conocidos ya traen una por defecto.
4. Pegá tu **clave de API** (no hace falta para Ollama). Se guarda cifrada en tu equipo con
   `safeStorage` de Electron (DPAPI en Windows) — SaurioLLM nunca la guarda en texto plano, nunca la
   muestra de nuevo ni la manda a ningún lado salvo al proveedor elegido, y nunca la escribe en un
   log. Si tu sistema no tiene un backend de cifrado disponible, la app te avisa y no guarda nada.
5. Tocá **Agregar proveedor**. Después podés **Probar conexión** (confirma que la clave funciona y
   te dice cuántos modelos encontró), **habilitar/deshabilitar** sin borrar la configuración, o
   **borrar** el proveedor entero (menos Ollama, que siempre está disponible).

### 9.2 Elegir un modelo de un proveedor

En la barra lateral (para un chat nuevo) o en la cabecera del chat (para uno ya creado), el selector
de modelo agrupa las opciones por proveedor y muestra un badge junto a cada una:

- **LOCAL** — corre en tu PC (Ollama).
- **LAN** — corre en otra máquina de tu red.
- **NUBE** — corre en un servidor de terceros (OpenAI, OpenRouter, Anthropic, o cualquier
  "OpenAI-compatible" con una base URL pública).

### 9.3 La frontera local/nube

SaurioLLM nunca manda tu conversación a la nube sin que lo pidas explícitamente:

- La **primera vez** que elegís un modelo NUBE para un chat de un proyecto dado, la app te muestra
  un aviso — "el contenido de este chat va a salir de tu PC hacia \<proveedor\>" — y te pide
  confirmar. Si confirmás, no te vuelve a preguntar para ese proyecto (pero sí para uno nuevo).
- Si preferís que la app **nunca** use nada que no sea local, activá **Ajustes > Localidad > Solo
  modelos locales**: con eso prendido, ni siquiera se puede elegir un modelo LAN o NUBE, y la
  confirmación de arriba ni siquiera llega a mostrarse.
- La app **nunca** hace un fallback automático a otro modelo: si el que elegiste no está disponible,
  el run falla con un error claro, nunca sigue en silencio con otro proveedor.
- Cada llamada a un modelo no local queda registrada (proveedor, modelo, run) para que puedas
  auditar qué salió de tu PC y cuándo.
- Mientras un chat use un modelo no local, vas a ver el badge **NUBE** en la cabecera del chat y
  junto a los mensajes del agente.

### 9.4 Qué se ve de cada respuesta

Bajo cada mensaje del agente se muestran los tokens de entrada/salida, tokens por segundo (cuando el
proveedor los informa) y una etiqueta de calidad del dato (medido/estimado/no disponible). El
**costo en moneda siempre aparece como "no disponible"**: ningún proveedor del MVP (Ollama, ni
ningún "OpenAI-compatible", ni Anthropic) informa el costo de una respuesta — se muestra así en vez
de inventar un cálculo.
