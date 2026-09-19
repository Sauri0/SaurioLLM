# SaurioLLM: documento del proyecto

Última actualización: 2026-09-19. Última versión PUBLICADA: v0.2.2, publicada por decisión del dueño CON un problema conocido (ver sección 5). Este archivo es la referencia viva del proyecto: quien lo retome, persona o IA, debe leerlo primero y mantenerlo actualizado al cerrar cada versión. Pensado para que otra persona u otra IA de código retome el proyecto sin contexto previo. Leé esto primero; después `docs/architecture/16-estado-de-implementacion.md` (estado detallado por módulo) y `docs/MANUAL.md` (uso).

## 1. Qué es

App de escritorio (Windows) para trabajar con agentes de IA sobre carpetas locales, al estilo Claude Code / Codex, con modelos locales o por API. El centro es un runtime de agentes propio; los motores de inferencia son reemplazables.

- Stack: Electron 44 + electron-vite 5, React 19, TypeScript estricto, zustand, SQLite (better-sqlite3 + drizzle), monorepo pnpm.
- Paquetes: `packages/shared` (contratos zod: dominio, eventos, IPC), `packages/runtime` (Node puro: agent, tools, permissions, checkpoint, context, gateway + providers, models, telemetry, persistence), `packages/repomap` (tree-sitter + PageRank), `apps/desktop` (main, preload, renderer).
- Providers: Ollama (nativo, `/api/chat`), OpenAI-compatible (OpenAI, OpenRouter, Groq, LM Studio, llama.cpp, vLLM), Anthropic nativo. Claves con Electron safeStorage. Nunca hay fallback local a nube.
- Repo público: https://github.com/Sauri0/SaurioLLM (rama `main`). Releases con instalador NSIS y auto-actualización (electron-updater).

## 2. Cómo trabajar

```bash
pnpm install          # el postinstall restaura node_modules/electron/dist
pnpm dev              # app en modo desarrollo (o SaurioLLM.cmd)
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm test:eval        # harness real de punta a punta contra Ollama (necesita qwen3:8b y qwen2.5-coder:7b)
pnpm --filter @saurio/desktop run build:installer   # instalador + latest.yml + blockmap en apps/desktop/release
```

Variables útiles para pruebas: `SAURIO_USER_DATA=<carpeta temporal>` (datos aislados, usar SIEMPRE en smokes), `SAURIO_SMOKE=1`, `SAURIO_SMOKE_UI=1`, `SAURIO_SMOKE_SHOT=<png>`, `SAURIO_SMOKE_STATE=<json>` (modo demo), `SAURIO_SMOKE_CLICK`, `SAURIO_OLLAMA_URL` (simular motor apagado con un puerto vacío), `SAURIO_NO_UPDATE=1`, `SAURIO_GPU=1` (desactiva la mitigación de GPU).

Trampas conocidas de este entorno:
- pnpm 10 no debe compilar nativos: no hay toolset C++ de MSVC. `better-sqlite3` usa su prebuild N-API incluido y NO va en `pnpm.onlyBuiltDependencies`.
- `pnpm install/add` borra `node_modules/electron/dist`; el postinstall lo restaura.
- La virtualización de GPU de Electron falla en la PC de desarrollo: la app desactiva la aceleración por hardware por defecto.
- Grammars de tree-sitter: usar `@vscode/tree-sitter-wasm` (las de `tree-sitter-wasms` no cargan en web-tree-sitter 0.27).
- PowerShell 7 no está instalado: el shell por defecto es `powershell.exe`.
- Todo `child_process` debe usar los wrappers `spawnHidden/execFileHidden` (hay tests que fallan si no): si no, en Windows parpadean consolas.
- Si varios agentes editan el mismo árbol: commits chicos con `git commit -m "..." -- <paths exactos>`; nunca `git add -A`, `git stash` ni `git reset` sobre trabajo ajeno.

## 3. Cómo publicar una versión

`master` es la rama de trabajo PRIVADA (historial completo, no se sube). `public-release` es la rama saneada que se publica como `main`.

1. En `master`: subir versión en `package.json` y `apps/desktop/package.json`, con typecheck, lint y tests en verde; commit.
2. `pnpm --filter @saurio/desktop run build:installer`, luego `node scripts/release-local.mjs` (valida que versión, nombre y sha512 de `latest.yml` coincidan).
3. Smoke del exe empaquetado: `apps/desktop/release/win-unpacked/SaurioLLM.exe` con `SAURIO_NO_UPDATE=1 SAURIO_USER_DATA=<temp> SAURIO_SMOKE_UI=1 SAURIO_SMOKE_SHOT=<png>`; debe salir con exit 0 y `rootHtmlLength > 0`.
4. `git checkout public-release && git read-tree -u --reset master && git rm -r --cached docs/research docs/SaurioLLM-Arquitectura.md`; verificar que `git grep` no encuentre datos personales (usuario de Windows, emails, identificadores de hardware); commit con identidad `Sauri0 <Sauri0@users.noreply.github.com>`; `git push origin public-release:main`.
5. `gh release create vX.Y.Z --repo Sauri0/SaurioLLM --target main` adjuntando los TRES archivos: `SaurioLLM-Setup-X.Y.Z.exe`, su `.blockmap` y `latest.yml`. Volver a `master` con `git checkout -f master`.

El workflow de GitHub Actions quedó manual (`workflow_dispatch`) a propósito: publicar a mano garantiza que instalador y hash salgan del mismo build verificado. El instalador no está firmado (SmartScreen advierte).

## 4. Estado de la v0.2.2 (publicada)

Verificado: typecheck y lint limpios; tests unitarios en verde (runtime 692, desktop 241, repomap 14); instalador con hash coincidente; exe empaquetado abre, dibuja la UI y cierra limpio. Ver la sección 6 para el resultado del harness real de esta versión.

Funciona y está probado con modelos reales (harness): recorrido completo proyecto, chat, lectura, propuesta, permiso, aplicación, diff, revert y reinicio con historial; permisos ask/deny/allow_always persistidos; reanudación tras reinicio; transporte de tools por texto (qwen2.5-coder:7b); capado de contexto; compactación; recuperación sin pérdida de cambios del usuario; chat directo con agente personal y delegación a un worker temporal.

Entró en la v0.2.2 (con tests unitarios; revisar en uso real): Enter envía y Shift+Enter baja de renglón; una respuesta de texto sin tools termina el run (antes respondía dos veces y usaba tools para un saludo); prompt de sistema con carpeta de trabajo, sistema operativo y shell reales; salida de comandos sin códigos ANSI; checkpoints solo cuando hubo cambios; contexto real en el indicador (`effectiveNumCtx`); tool `make_dir`; cuatro presets de permisos por chat (preguntar siempre, editar en la carpeta, acceso total en la carpeta, sin límites); potencia por chat (rápida, equilibrada, profunda); adjuntos de archivos e imágenes en `run:start`; aviso de modelo chico en modo Agente; bloque "Actividad" plegado por run con línea viva y orden cronológico; compositor con selectores de modo, potencia y permisos; icono propio; migración 0006 y handlers para renombrar, archivar y borrar chats y para proyectos recientes.

## 5. Pendientes, por prioridad

**PROBLEMA CONOCIDO de la v0.2.2, primera tarea de la v0.2.3.** El dueño decidió publicar igual para poder probar el resto. Los tests unitarios están en verde, pero `pnpm test:eval` (harness real, 2026-09-19) dio 16 de 20: fallan (g.1) y (g.3) permiso ask con respuesta allow, y (q) delegación: tras APROBAR un permiso el run vivo no continúa (queda en timeout y la tool no se ejecuta), aunque la decisión y la regla sí se persisten; (g.4) sin pregunta y (h) reanudar tras reinicio pasan. También falla (k): en modo plan ya no se persisten tasks, porque ahora una respuesta de texto sin tools termina el run. Sospechosos: commits `a84342d` (fin de run), `8b25dcf` (presets de permisos), `3b00e5a` (run.activity), `462abbb` (effort) y el de adjuntos. Comparar con `git diff 9eea91d -- packages/runtime/src/agent/RunController.ts packages/runtime/src/permissions`. Arreglar, agregar un test unitario "ask, allow, la tool se ejecuta y el run completa", dejar el harness en 20 de 20 y publicar la v0.2.3 siguiendo la sección 3. Mientras tanto, para el usuario: el preset de permisos "Acceso total en la carpeta" evita la mayoría de las preguntas y por lo tanto el cuelgue; con "Preguntar siempre", aprobar un permiso puede dejar el run sin avanzar (se cancela con Detener).

**REQUISITO DEL DUEÑO, prioridad máxima después del bloqueante: cero requisitos previos.** Quien instale el .exe sin tener nada debe poder usar todo. Hoy NO se cumple: para modelos locales hace falta Ollama instalado (el asistente solo abre la página de descarga). Diseño acordado: motor local administrado por la app. En el primer arranque, un botón "Instalar motor local" descarga el paquete portable oficial de Ollama para Windows a la carpeta de datos de la app (sin instalador del sistema ni permisos de administrador), con progreso, verificación de espacio y de integridad; la app lo ejecuta en un puerto propio con su propia carpeta de modelos, lo actualiza y lo apaga al cerrar; si ya hay un Ollama del usuario, ofrecer usar ese. Después: recomendación de modelo según el equipo, descarga con un clic y primer chat. El camino por clave de API ya funciona sin instalar nada. Verificar el tamaño real del paquete y su licencia de redistribución antes de decidir si se descarga bajo demanda (lo previsto) o se incluye en el instalador.

1. Proyectos persistentes en la UI: el contrato y los handlers existen (proyectos recientes, renombrar, quitar), falta la barra lateral con todos los proyectos y sus chats anidados, y confirmar que al iniciar se reabre el último proyecto y chat.
2. Apertura y cierre de la app: mostrar la ventana de inmediato y diferir lo pesado (hardware, Ollama, catálogo, updater); cierre en menos de 2 s con timeout duro; preguntar si hay un run activo. No se hizo.
3. Pulido del chat según la referencia de Claude Code: la línea de actividad debe ser tenue y de un renglón, con detalle desplegable por paso; métricas solo bajo un "i". Quedó un retoque de estilos del botón de adjuntar a medio revisar.
4. Agentes: el modo de modelo "automático" no está conectado al RunController (se comporta como fijo); la tarjeta de delegación correlaciona por orden y no por `toolCallId`; falta sección "Mis agentes" en la barra lateral; equipos con chat grupal (E3b) y controles de automatización y proactividad (E4a) sin empezar. Diseño en `docs/architecture/19-agentes-personales-y-equipos.md`.
5. Centro de modelos: registrar cargas fallidas por memoria como "probado: no entra en este equipo"; el asistente recomienda primero modelos muy chicos (afinar el orden); la vista Explorar se validó con tests y poca verificación visual; botón "actualizar hardware".
6. Proveedores por API: imágenes en OpenAI-compatible y Anthropic sin verificar; formulario de alta algo apretado; costo por tokens no disponible.
7. Varios: ajuste `updates.auto` sin interruptor en Ajustes; condición de carrera al combinar `SAURIO_SMOKE` con `SAURIO_SMOKE_UI`; una advertencia de lint (`environmentPrompt.ts`, import sin usar); la prueba opcional `createRuntime.providers.e2e` requiere red, `OPENROUTER_API_KEY` y Ollama encendido.

## 6. Equipos de prueba y mediciones reales

- PC de desarrollo: Ryzen 5 5600X, 32 GB, RTX 3060 Ti 8 GB. Medido: qwen3:8b entra en GPU con contexto 8192 a unos 60 tok/s y hace offload con 16384 (unos 18 tok/s); qwen2.5-coder:7b a unos 66 tok/s y responde tools en texto; gemma4:26b corre a 15-31 tok/s y `/api/ps` reporta mal su memoria.
- Notebook del usuario: Intel Core Ultra 9 288V, 32 GB, gráfica integrada Arc 140V por Vulkan (unos 17 GB compartidos), sin NVIDIA. gemma4:26b no entra por el proyector de visión. La app instalada ahí se actualiza sola desde la v0.2.0.
- La app de bandeja de Ollama puede forzar contexto 256K y escuchar en toda la red: la app SIEMPRE manda `num_ctx` explícito y solo avisa, nunca cambia esa configuración.

## 7. Reglas de trabajo acordadas con el dueño del proyecto

- Español rioplatense en textos de usuario y documentos; identificadores en inglés.
- Distinguir siempre lo medido de lo estimado; nunca presentar estimaciones como mediciones.
- Proteger el proyecto del usuario: no tocar su `.git`, revert solo de lo que tocó el agente, el revert no deshace efectos de comandos.
- Local por defecto; la nube solo con autorización explícita y siempre visible.
- No cambiar la configuración de Ollama del usuario. No publicar datos personales.
- Si se usan subagentes: modelo y esfuerzo medidos por tarea (lo caro solo donde hace falta), zonas de archivos separadas y commits chicos.
