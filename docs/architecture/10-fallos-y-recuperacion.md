# Comportamiento ante fallos y recuperación

Cómo SaurioLLM detecta, muestra y recupera cada tipo de fallo de un run sin perder trabajo del usuario y sin repetir solo una acción peligrosa.

Leyenda: `[COMPROBADO EN EQUIPO]` `[VERIFICADO EN DOC OFICIAL]` `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]`

---

## 1. Principios

Este documento desarrolla la condición 4 y se apoya en la máquina de estados y el modelo de datos de la columna vertebral (§§ 3, 4, 5, 6 y 12). Tres principios gobiernan cada decisión de abajo `[DECISIÓN DE DISEÑO]`:

1. **Nunca perder trabajo.** Todo lo que el usuario aprobó y todo lo que el agente ya escribió en disco queda registrado y es recuperable, aunque el proceso de la app muera un instante después. Un mensaje parcial, un checkpoint a medio confirmar o un archivo recién editado nunca desaparecen sin dejar rastro consultable.
2. **Nunca repetir sola una acción peligrosa.** Ninguna `tool_calls` se ejecuta dos veces por accidente. Al reiniciar, ninguna fila `pending`, `approved` o `running` se retoma automáticamente: se reclasifica, se muestra y espera una decisión humana o del `run:continue`.
3. **Mostrar siempre el estado real.** La UI nunca inventa un estado optimista. Si el sistema no sabe si una escritura llegó a disco, lo dice ("estado distinto a ambos, ¿editado después?") en vez de asumir éxito o fracaso.

De estos principios se derivan dos reglas mecánicas que atraviesan todo el documento: **registrar antes de actuar** (§3) y **el log de eventos es la única fuente de verdad** (§2) — las tablas relacionales son proyecciones reconstruibles con `saurio db rebuild`.

---

## 2. Máquina de estados del run

La máquina de estados es la de la columna vertebral § 12, reproducida aquí porque este documento depende de cada arista:

```
created → preparing → [queued → generating → parsing]                (una vez por iteración)
parsing → completed                                finish / respuesta final
parsing → awaiting_permission                       tool con verdict ask
parsing → executing_tool                            verdict allow
awaiting_permission → executing_tool | parsing      permission:answer
executing_tool → compacting | queued                tool.status done/failed
compacting → queued                                 context.compacted
{queued|generating|parsing|executing_tool|awaiting_permission|compacting} → cancelling
cancelling → cancelling                            tool.status done/failed de un handler que ya estaba `running` (§ 6.7)
cancelling → cancelled                              todo handler `running` retornó, o venció `cancelKillTimeoutMs`
{preparing|queued|generating|parsing|executing_tool|compacting} → failed
(cualquier estado activo salvo awaiting_permission, detectado al arrancar) → interrupted
```

Cada arista es una transacción SQLite única que escribe, en este orden dentro de la misma transacción: una fila en `run_events` (`type: 'run.state'`, `from`, `to`, `reason?`) y un `UPDATE runs SET state, state_reason, iteration, last_event_seq`. Si algo mutable además cambió en esa transición (`tool_calls`, `messages`, `checkpoints`, `tasks`), su fila se escribe en la **misma** transacción que el evento — nunca hay un evento sin su proyección, ni una proyección sin su evento. Esto es lo que hace posible `saurio db rebuild`: reproyectar `messages`/`tool_calls`/`tasks`/`runs.state` desde `run_events` debe dar bit a bit el mismo resultado (criterio de "listo" del MVP, § 10).

`awaiting_permission` es la única excepción a "todo estado activo se interrumpe al reiniciar": no hay ninguna acción en curso mientras se espera una decisión humana, así que sobrevive tal cual a un reinicio (§ 5).

**Qué se persiste en cada estado** (columna vertebral § 12, con el detalle de qué campo respalda la recuperación):

| Estado | Qué se persiste | Por qué alcanza para recuperar |
|---|---|---|
| `preparing` | `effective_config_json` (modelo, `numCtx` capeado, tools por modo, hash del system prompt) + filas en `run_adjustments` | Un run interrumpido acá se relanza desde cero sin ambigüedad: nada se ejecutó todavía |
| `queued` | Evento `run.state` con `reason: 'queue:<n>'` | La posición en cola no es recuperable como tal (el proceso de Ollama no la persiste), pero el run vuelve a encolarse igual al reintentar |
| `generating` | Nada por chunk; al cortarse el stream, el mensaje parcial se persiste con `truncated = 1` | Los `message.delta` viven solo en memoria del proceso `main`; lo único que sobrevive es el mensaje ya cerrado (con o sin `truncated`) |
| `awaiting_permission` | La `PermissionRequest` completa dentro del evento `tool.permission` | Permite re-renderizar la tarjeta de permiso exactamente igual tras un reinicio, sin volver a pedirle nada al modelo |
| `executing_tool` | `tool_calls.running` + `started_at` + `checkpoint_id` (si `mutating`) | Es el estado que exige el diagnóstico por hash de § 5.4: sabemos qué archivo se tocaba y con qué pre-imagen |
| `compacting` | Fila `messages` con el resumen + `compacted_by` en los mensajes reemplazados | Los mensajes originales nunca se borran; si compactar falla a mitad, el historial sigue íntegro |
| `failed` | `error_json` (`{ code, message, raw }`) | Alimenta tanto la tarjeta de error como los diagnósticos (§ 7) |

---

## 3. Write-ahead de tool calls

Toda `tool_calls` nace en `pending` **antes** de que el `PermissionEngine` la evalúe (columna vertebral § 6, paso 7) — nunca después. La secuencia de estados de `ToolCallStatus` es:

```
pending → awaiting_permission → approved → running → done | failed
pending → approved                                          (verdict allow, sin pasar por awaiting_permission)
pending | approved | awaiting_permission → denied | cancelled
running → orphaned                                          (solo al arrancar, ver § 5)
pending | approved → abandoned                               (solo al arrancar, ver § 5)
```

Cada transición se acompaña de su evento (`tool.registered`, `tool.permission`, `tool.decision`, `tool.status`) y de la fila `tool_calls` correspondiente en la misma transacción, igual que el run. Tres columnas hacen posible razonar sobre peligrosidad y repetición sin re-ejecutar nada:

- **`category`** (`PermissionCategory`: `read | write | delete | terminal | git_commit | git_push | network | mcp`) y **`risk`** (`low | medium | high`), calculadas por `ToolDefinition.classify(args)` en el momento del registro — antes de saber si se va a pedir permiso. `run_command` las deriva parseando el comando (`rm` → `delete`, `git push` → `git_push`, etc., columna vertebral § 7); `edit_file`/`write_file`/`delete_file` declaran `paths`.
- **`args_hash`**, un hash determinístico de los argumentos. No identifica la fila (eso lo hace `tool_calls.id`, que siempre es nuevo): sirve para que el `LoopDetector` (§ 6.10) y la tarjeta de "run interrumpido" (§ 5) puedan decir "esto es lo mismo que intentaste antes", sin que eso implique reutilizar ni reejecutar la fila vieja.
- **`checkpoint_id`**, vinculado en `begin()` para toda tool `mutating: true`, antes de invocar el `handler`. Es el punto exacto donde "registrar antes de actuar" se vuelve "guardar la pre-imagen antes de escribir": si el proceso muere entre `begin` y `commit`, la pre-imagen ya está en `appData/blobs/<hash>`.
- **`expected_pre_hash`** (columna `TEXT`, nullable, agregada a `tool_calls`), escrita en el mismo `INSERT` que produce el evento `tool.registered`: el hash del archivo tal como lo vio **este run** la última vez que lo leyó (`read_file` o el preview en seco de un `edit_file` anterior), o `NULL` si el run nunca leyó ese path. Existe para que la comparación de "¿alguien tocó el archivo mientras tanto?" (§ 6, caso 13) no dependa de un estado en memoria del `RunController` que un reinicio de la app borra — ver § 5.2.

La regla de idempotencia (columna vertebral § 12) es absoluta: **el runtime rechaza ejecutar cualquier fila que no esté en `approved` y cuyo `run_id` no corresponda a un run vivo en memoria de la sesión actual.** Esto es lo que impide, por diseño y no por buena voluntad, que un `recover()` mal implementado reejecute algo: no hay ningún camino de código que lea `tool_calls` en `pending`/`approved` de un run muerto y llame al `handler`. El único camino de ejecución nace en el bucle del `RunController` de un run activo (columna vertebral § 6).

---

## 4. Marca de peligrosidad y qué protege

`risk: 'high'` no es cosmético: condiciona tres comportamientos independientes del `PermissionEngine`:

1. **Comandos críticos** (`rm -rf`/`Remove-Item -Recurse` sobre raíz de unidad, home o project root; `git push --force`; `git push` en general) se marcan `risk: 'high'` y quedan en `ask` **no configurable a `allow`**, ni siquiera con "permitir siempre" (columna vertebral § 7).
2. **Comandos bloqueados por defecto** (`git reset --hard`, `git checkout --`, `git restore`, `git clean`, `git stash` sobre paths que el run no tocó) se registran igual como `pending` — el write-ahead corre siempre — pero el veredicto es `deny` de fábrica; solo una regla explícita creada desde Settings → Permisos (nunca desde el diálogo del chat) puede cambiarlo.
3. **Protected paths** (`.git/**`, `.saurio/**`, `.env*`, `*.pem`, `id_rsa*`, `.vscode/**`, `.idea/**`) hacen que `edit_file`/`write_file`/`delete_file` fallen en el `WorkspaceFs` mismo, antes de que el `PermissionEngine` tenga que decidir nada — es una invalidación en la capa de herramientas, no una regla de permisos que alguien pueda relajar.

La combinación de `category` + `risk` + protected/critical/bloqueados es lo que la tabla de fallos del § 6 llama "garantía de no repetición": no es solo que la fila no se reejecuta sola, es que una fila peligrosa **nunca llega a `approved`** sin una decisión humana explícita y trazada en `permission_decisions`.

---

## 5. Recuperación al iniciar la app

`recover()` corre una sola vez, en el bootstrap de `src/main/index.ts`, después de las migraciones y antes de que la UI pida `chat:history`.

**5.0 Single instance lock, primera línea del bootstrap.** `recover()` asume implícitamente que es el único proceso corriendo runs sobre esta base SQLite; eso deja de ser cierto en cuanto el usuario abre una segunda ventana de SaurioLLM. `app.requestSingleInstanceLock()` de Electron corre antes de abrir la base y antes de cualquier otra cosa del bootstrap: si ya hay una instancia, la nueva se cierra sin llamar a `recover()` y sin tocar SQLite, y la instancia existente se enfoca. Esto cubre el caso normal (una sola instalación, un usuario). Como defensa en profundidad para perfiles o bases compartidas entre máquinas (donde el lock de Electron no aplica, porque son procesos en sistemas distintos), `runs` agrega `owner_session_id TEXT` y `heartbeat_at INTEGER`, este último actualizado cada 5 s por el `RunController` mientras el run está activo. `recover()` (§ 5.1) solo reclasifica como `interrupted` los runs activos cuyo `owner_session_id` no sea el de la sesión actual **y** cuyo `heartbeat_at` tenga más de 30 s de antigüedad; si encuentra un run activo con heartbeat fresco de otro `owner_session_id`, no lo toca y muestra "hay otra instancia de SaurioLLM trabajando sobre este proyecto" en vez de interrumpirlo. Sin este chequeo, abrir una segunda ventana mientras la primera tiene un run en `executing_tool` haría que la segunda instancia marcara ese run como `interrupted` y su tool call `running → orphaned` mientras la primera sigue escribiendo archivos — la UI ofrecería revertir una tool que está corriendo en ese instante, con resultado indeterminado si el usuario acepta.

**5.1 Selección de runs activos.** `SELECT * FROM runs WHERE state IN (...)` usando el índice parcial `runs_active` (columna vertebral § 4), que cubre exactamente los mismos estados que la máquina de § 2 marca como "activo", y filtrando por `owner_session_id`/`heartbeat_at` según § 5.0. Ningún run `completed`/`cancelled`/`failed`/`interrupted` se toca, y ningún run activo con heartbeat fresco de otra sesión se toca tampoco.

**5.2 Caso `awaiting_permission`: no hay nada que interrumpir, pero la comparación de hash debe sobrevivir al reinicio.** Estos runs permanecen en `awaiting_permission` tal cual. La `PermissionRequest` ya está completa en el evento `tool.permission`, así que la UI la re-renderiza sin volver a llamar al modelo. Cuando el usuario responde, el run se rehidrata desde el log (última proyección conocida + eventos posteriores al `last_event_seq`) y continúa exactamente donde estaba: la tool pasa `approved → running` **por primera vez**. Esto no es una excepción a "nunca repetir": es que todavía no había ejecución que repetir.

Esto sí es una excepción para la protección de § 6 caso (13): esa protección compara el archivo contra la última lectura *de este run*, y si esa lectura vive solo en memoria del `RunController`, un reinicio la borra sin borrar la tarjeta de permiso pendiente — el escenario es el agente propone editar `src/a.ts`, el usuario deja el permiso pendiente, cierra la app, edita el archivo a mano, reabre y aprueba: sin baseline persistido, `edit_file` correría sin comparar nada. Por eso la comparación nunca lee memoria: lee `tool_calls.expected_pre_hash` (§ 3) de la fila que se está aprobando, tanto si el run sigue vivo en memoria como si se rehidrató después de un reinicio. Si `expected_pre_hash` es `NULL` (el run nunca leyó ese path antes de proponer la edición), la tool falla pidiendo releer el archivo en vez de aplicar a ciegas.

**5.3 Los demás runs activos pasan a `interrupted`.** Un solo `UPDATE` marca el run; sus tool calls en curso o en cola se reclasifican:
- `running → orphaned` — había un `handler` ejecutándose cuando el proceso murió; no sabemos si terminó.
- `pending | approved → abandoned` — estaban en la fila de ejecución del `RunController` pero el `handler` nunca arrancó.

Se emite un evento único `run.recovered { orphaned: ToolCallRecord[], abandoned: ToolCallRecord[] }` por run afectado, y ese evento entra al log igual que cualquier otro — la recuperación en sí queda auditada.

**5.4 Diagnóstico por hash para `orphaned` de tools de archivo.** `checkpoint.after()` (columna vertebral / doc 09 § 3.4) escribe `post_hash` **después** del `rename` atómico que aplica el cambio; si el proceso muere entre el `rename` y ese `after()`, `post_hash` queda `NULL` aunque la escritura ya haya terminado. Comparar solo contra `pre_hash`/`post_hash` con `post_hash` en `NULL` es indistinguible de "nunca llegó a escribir", así que `recover()` evalúa **cuatro reglas en orden**, no una comparación de dos casos, para cada `orphaned` de `edit_file`/`write_file`/`delete_file`:

| # | Condición | Diagnóstico mostrado | Acción de `recover()` |
|---|---|---|---|
| 1 | `post_hash` NO NULL y `hash(actual) == post_hash` | "Se aplicó completa" | Cierra el `commit` del checkpoint (ya tenía post-imagen) |
| 2 | `post_hash` NO NULL y `hash(actual) == pre_hash` | "No se aplicó" | Nada que reparar: la pre-imagen sigue intacta |
| 3 | `post_hash` IS NULL y `hash(actual) == pre_hash` | "No se aplicó" | El proceso murió antes o durante la escritura del archivo temporal; el `rename` nunca ocurrió |
| 4 | `post_hash` IS NULL y `hash(actual) != pre_hash` | "Se aplicó pero no se registró" | El `rename` sí ocurrió justo antes del corte. `recover()` calcula el hash del archivo actual, lo guarda como blob post, completa `checkpoint_files.post_hash` y `checkpoints.stats_json`, y deja el checkpoint en `active` para que el revert funcione con una vista de tres vías completa (doc 09 § 5.4) |
| — | Ninguna de las anteriores (`post_hash` NO NULL y no coincide con `pre_hash` ni con `hash(actual)`) | "Estado distinto a ambos (¿editado después?)" | El archivo cambió por otra vía (el usuario, otro proceso) entre el corte y el reinicio; no se asume nada, se muestra para decisión manual |

Para `delete_file`, el "archivo actual" puede no existir: si el archivo no está en disco y `post_hash` es el hash reservado que `delete_file` usa para "ausencia" (columna vertebral § 4), se aplica la regla 1 igual (borrado completo); si el archivo sigue estando, se aplican las reglas 2-4 comparando contra `pre_hash` como con cualquier otra tool de archivo.

Para `orphaned` de `run_command` no hay hash posible (el efecto no es necesariamente un archivo): se muestra el comando completo y la salida parcial capturada en `tool.progress` hasta el corte, sin inferir si terminó bien o mal.

*Nota de alcance:* esta misma tabla de cuatro reglas reemplaza la versión de dos comparaciones que pudiera existir en doc 09 § 3.5; esa réplica queda fuera del alcance de esta edición porque el encargo de este turno es únicamente doc 10 (ver "Skipped" en la salida estructurada).

**5.5 Qué ve el usuario.** El chat interrumpido abre con una tarjeta: *"Este run se interrumpió en la iteración N mientras ejecutaba `<tool>`: `<diagnóstico>`. Podés: revisar el checkpoint / revertir / marcar como hecho / continuar el chat."* Ninguna de esas cuatro acciones reejecuta la tool `orphaned`/`abandoned` original.

**5.6 "Continuar" crea un run nuevo, con el historial siempre bien formado.** `run:continue` abre un `Run` con id nuevo que hereda el historial de mensajes del chat. Si el modelo, ya en el run nuevo, decide volver a pedir la misma tool, es una fila `tool_calls` completamente nueva (id nuevo), aunque comparta `args_hash` con la abandonada — y es justamente esa coincidencia de `args_hash` la que permite a la UI avisar *"ya intentaste esto antes del cierre"* sin bloquear al modelo, que puede tener buenas razones para reintentar (por ejemplo, con un `old_string` corregido).

Heredar el historial "tal cual" sería un problema en cualquier run que se cierre con una `tool_calls` en `orphaned`, `abandoned` o `cancelled`: el historial queda con un mensaje `assistant` que trae `tool_calls` sin su mensaje `role: 'tool'` de respuesta. Eso es una conversación mal formada para el transporte nativo — varias plantillas de chat la rechazan o la degradan — y un modelo de 7-8B casi con certeza reintenta la misma tool creyendo que nunca recibió respuesta, que es exactamente lo que el write-ahead quiere evitar en una tool peligrosa. Por eso, al cerrar cualquier run, por cada `tool_calls` que quede en `orphaned`, `abandoned` o `cancelled` el runtime escribe un mensaje sintético `role: 'tool'` con el `tool_call_id` correspondiente y un texto fijo ("interrumpido: esta herramienta no se ejecutó o no se sabe si terminó; verificá el estado antes de repetirla"), persistido en `messages` y emitido como su propio `tool.status` en la misma transacción de cierre del run. El caso `denied` ya resolvía esto (el modelo recibe "acción no permitida" como resultado de la tool, § 6.5); esta regla lo extiende a los otros cuatro estados terminales, así que `run:continue` siempre hereda un historial donde todo `assistant` con `tool_calls` tiene su `tool` de respuesta.

**5.7 Limpieza de procesos por pid.** `run_command` no usa pty (columna vertebral § 1.2); cada ejecución guarda el pid del proceso raíz en memoria del `RunController`, no en SQLite — es deliberado, porque un pid de una sesión anterior de Windows no es válido en la siguiente. En Windows **no existe herencia de árbol de procesos**: matar al proceso `main` de Electron no mata a sus hijos, estén o no `detached` `[VERIFICADO EN DOC OFICIAL: investigación 2 §C.3]`. Por eso la mitigación no puede ser "confiar en que el sistema operativo los termine": el `RunController` mantiene en memoria el pid raíz de cada `run_command` vivo y, en los handlers `before-quit`/`will-quit` de Electron y en `process.on('exit')`, invoca `taskkill /PID <pid> /T /F` sobre cada uno antes de dejar salir al proceso — el mismo mecanismo que ya usa el caso (6) de timeout (§ 6.6). Esto cubre el cierre ordenado (el usuario cierra la ventana, `Alt+F4`, menú Salir). Ante un **cierre forzado** (un `taskkill` externo sobre el propio proceso `main` de SaurioLLM, un corte de luz, un crash del proceso Electron) esos handlers nunca corren y los hijos sobreviven como huérfanos de Windows; SaurioLLM **no** los mata al reiniciar, porque el pid guardado en memoria se perdió con el proceso y un pid guardado en disco de una sesión de Windows anterior es reasignable a un proceso completamente distinto — matarlo por número sería matar un proceso ajeno. Se documenta como límite conocido en el diagnóstico (§ 7) y como pregunta abierta operativa, no de diseño (§ 9).

---

## 6. Tabla de casos

Todas las filas comparten la garantía general de § 3: ninguna fila de `tool_calls` que termine en la columna "Recuperación" vuelve a ejecutarse sola. La columna "Sin repetir" describe el mecanismo específico de cada caso.

### (1) Modelo no entra en memoria (OOM en carga o en generación)

| | |
|---|---|
| **Detección** | En carga: `/api/chat` o `load()` devuelven HTTP 500 con texto de llama-server ("model is too large", `cudaMalloc failed`) `[VERIFICADO EN DOC OFICIAL: sched.go]`, o `/api/ps` reporta `size_vram ≪ size` tras la carga. En generación: llega un chunk `{"error": "..."}`  con HTTP 200 a mitad del stream `[VERIFICADO EN DOC OFICIAL: docs.ollama.com/api/errors]`. El caso real de referencia es el OOM del 17/09 relevado en esta PC: `gemma4:31b` con `num_ctx = 262144` reservó `llama_kv_cache = 20480 MiB` y falló al pedir 2405 MiB de compute buffers, con `Load failed` y `POST /api/chat` devolviendo 500 tras 1m14s `[COMPROBADO EN EQUIPO: server-1.log 2026-09-17]` |
| **Qué ve el usuario** | Carga: *"El modelo no entró en la GPU. Opciones: bajar contexto a X (se registra como ajuste), KV q8_0 (requiere modo managed), probar otro modelo, continuar con offload a CPU (lento)."* Generación: *"La generación falló por memoria en el turno N; el mensaje parcial se guardó."* |
| **Recuperación** | Carga: `run.failed(oom_load)` sin haber ejecutado ninguna tool; `model_load_samples` registra el intento fallido (`size_vram = null` o parcial) para que el `MemoryEstimator` no vuelva a sugerir la misma combinación sin avisar. Generación: el mensaje parcial ya recibido se persiste con `truncated = 1`; `run.failed(oom_generate)`; botón "Reintentar turno con menos contexto" abre un `run:continue` con un `num_ctx` menor, registrado en `run_adjustments` |
| **Sin repetir** | Nada se ejecutó en el caso de carga. En generación, los tool calls que pudiera traer el chunk cortado nunca llegan a parsearse completos (el `ToolProtocol.parse` exige un JSON válido) y por lo tanto nunca llegan a `tool_calls.pending` |

### (2) Ollama no corre al iniciar

| | |
|---|---|
| **Detección** | `health()` (`GET /api/version`) falla con `ECONNREFUSED` al abrir el proyecto o al iniciar un run |
| **Qué ve el usuario** | Banner persistente: *"Ollama no está corriendo."* con botón *Reintentar* (y, en v0.3, *Iniciar (modo managed)*) |
| **Recuperación** | Si el fallo ocurre al iniciar un run, este pasa directo a `failed(provider_down)` sin haber consumido ninguna iteración; el Centro de modelos muestra el mismo banner de forma persistente hasta que `health()` vuelva a responder |
| **Sin repetir** | No hay ninguna tool call registrada todavía: el run nunca sale de `preparing` |

### (3) Ollama se cae a mitad de un stream

| | |
|---|---|
| **Detección** | El `fetch` del `OllamaProvider` rechaza (conexión cerrada) o el stream NDJSON termina sin un chunk `{"done": true}` |
| **Qué ve el usuario** | *"Se perdió la conexión con Ollama en la iteración N; lo hecho hasta acá está guardado."* |
| **Recuperación** | Un único reintento automático de **la generación de ese turno** (no del run completo) a los 2 segundos, y solo si `health()` vuelve a responder antes; si no, `run.failed(provider_lost)`. Una tool que estuviera `executing_tool` en paralelo (no depende de Ollama) sigue su curso normal o vence por su propio timeout; el botón "Continuar" abre un run nuevo que hereda el historial. El mensaje parcial con `truncated = 1` de ese turno se conserva en el historial **visible** del chat (el usuario ve lo que alcanzó a llegar), pero el `ContextBuilder` lo **excluye** del contexto que arma para el reintento del mismo turno (doc 07): el modelo no ve una frase propia cortada a la mitad como si la hubiera terminado así. Si en cambio se reintenta desde un `run:continue` posterior (turno ya cerrado, no un reintento del mismo turno), el mensaje truncado sí entra al contexto pero con la marca `[respuesta cortada]` agregada, para que el modelo sepa que ese mensaje no es su intención completa |
| **Sin repetir** | Las tool calls que ya estaban `done` no se repiten porque el historial las conserva como mensajes `tool` ya cerrados; las que quedaron `pending`/`approved` sin ejecutar pasan a `abandoned` al cerrarse el run, con el mensaje `tool` sintético de § 5.6 y el mismo mecanismo de `args_hash` si el modelo las vuelve a pedir en el run nuevo |

### (4) Modelo sin soporte de tools

| | |
|---|---|
| **Detección** | Doble: (a) por capabilities, `ModelManager.describeModel` reporta `capabilities.tools = false` en `/api/show` — se decide **antes** de generar; (b) por error del provider, si igual se manda `tools` y el provider responde con un 400 o un error explícito de "modelo sin soporte de herramientas" `[HIPÓTESIS A PROBAR: el código exacto de error que devuelve llama-server para este caso en 0.34.1; se confirma provocándolo con un modelo sin `tools` real]` |
| **Qué ve el usuario** | Badge *"tools por texto"* en el selector de modelo y en la cabecera del chat, visible desde antes de generar, no como sorpresa a mitad de turno |
| **Recuperación** | Camino (a), el normal: `EffectiveConfig.transport = 'text'` se fija en `preparing`, el `TextToolProtocol` (formato Hermes `<tool_call>`) reemplaza al nativo sin que el usuario tenga que hacer nada. Camino (b), el de emergencia si (a) falló por datos incompletos de `/api/show`: se reintenta el mismo turno una vez en modo texto; si dos fallos de parseo consecutivos persisten, se activa el modo rescate con `format` (schema envelope en un request separado) y, si tampoco, `run.failed(format)` con aviso de que el modelo puede no ser apto para modo agente sin ajuste manual |
| **Sin repetir** | El cambio de transporte no reejecuta nada: ocurre antes de la primera llamada a `chat()` de ese run, o en el reintento del mismo turno (que todavía no había producido ninguna tool call válida) |

### (5) Comando bloqueado por permisos

| | |
|---|---|
| **Detección** | `PermissionEngine.evaluate(call, mode, policy)` devuelve `deny` — por regla explícita, por protected/critical path, o por estar en la lista de bloqueados por defecto |
| **Qué ve el usuario** | Aviso inline junto al mensaje del modelo, mostrando la regla o categoría que disparó el `deny` (`triggeredBy`) |
| **Recuperación** | No hay nada que recuperar: `tool_calls.denied` + evento `tool.decision`; el modelo recibe *"acción no permitida: `<regla>`"* como resultado de la tool y decide su siguiente paso dentro del mismo run, que sigue corriendo |
| **Sin repetir** | La fila `denied` nunca pasa por `approved`; si el modelo insiste con los mismos argumentos, es una fila nueva que vuelve a evaluarse desde cero (y alimenta al `LoopDetector` si se repite, § 6.10) |

### (6) Comando colgado

| | |
|---|---|
| **Detección** | Timeout de `run_command` (120 s por defecto, configurable hasta 600 s desde la UI antes de lanzar); aviso intermedio si no hay salida nueva durante 30 s |
| **Qué ve el usuario** | Tarjeta con la salida en vivo (`tool.progress`) y tres opciones: *"Esperar 2 min más" / "Pasar a background" / "Matar"* |
| **Recuperación** | Al vencer el timeout o al elegir *Matar*: `taskkill /PID <pid> /T /F` mata el árbol completo de procesos en Windows `[VERIFICADO EN DOC OFICIAL: investigación 2 §C.3]` (fallback POSIX: señal al grupo de procesos); `tool_calls.failed(timeout)` con la salida parcial capturada hasta el corte como resultado, para que el modelo decida con esa información. *Pasar a background* mueve la tool a un estado de espera sin bloquear el turno del modelo (el modelo recibe un resultado provisorio y puede seguir; la salida final llega como un evento posterior) `[DECISIÓN DE DISEÑO, detalle de UI para v0.2: el MVP solo ofrece Esperar/Matar]` |
| **Sin repetir** | La fila colgada nunca se reintenta automáticamente ni se relanza con los mismos argumentos; el modelo ve la salida parcial y decide explícitamente si repetir, y esa repetición es una fila nueva sujeta otra vez a permisos |

### (7) Cancelación por el usuario

| | |
|---|---|
| **Detección** | `run:cancel` desde la UI |
| **Qué ve el usuario** | *"Cancelando…"* → *"Cancelado en la iteración N"* con un resumen de qué checkpoints quedaron aplicados |
| **Recuperación** | `run.state → cancelling`; `AbortController.abort()` corta el `fetch` en curso (Ollama corta la generación al cerrarse la conexión `[HIPÓTESIS A PROBAR en 0.34.1: se confirma cancelando un stream largo y observando que el proceso de Ollama deja de consumir CPU/GPU]`); toda fila `pending/approved/awaiting_permission` pasa a `cancelled` de inmediato; el mensaje parcial del turno se persiste con `truncated = 1`. **`cancelling` es un estado de espera real, no un paso instantáneo hacia `cancelled`** (§ 6.7): si una tool ya estaba `running` (por ejemplo `run_command`, donde `taskkill /T /F` no es instantáneo y el proceso puede ignorar el cierre), el run permanece en `cancelling` hasta que ese handler retorne o hasta vencer `cancelKillTimeoutMs` (10 s por defecto). Un handler que retorna dentro de esa ventana escribe su `tool.status(done|failed)` y su checkpoint con total normalidad, aunque el run ya esté en `cancelling` — esa arista existe en la máquina de § 2. Un handler que no retorna a tiempo deja su fila en `orphaned` con el mismo diagnóstico por hash de § 5.4. Recién ahí el run cierra en `cancelled`. Lo que ya se aplicó (checkpoints `commit`eados, incluidos los que cerraron durante `cancelling`) queda aplicado y reversible normalmente desde el panel de diffs; la tarjeta de cancelación agrega la advertencia de que un comando que alcanzó a ejecutarse pudo haber modificado archivos sin checkpoint propio (límite de doc 09 § 6, `run_command` no genera checkpoint) |
| **Sin repetir** | Las tools canceladas antes de arrancar se listan en el resumen final como "canceladas, no reintentadas"; las que quedaron `orphaned` por no retornar a tiempo siguen el mismo mecanismo de no-repetición de § 5.4/§ 5.5; nada del ciclo de cancelación relanza una tool call por su cuenta |

### (8) Cierre inesperado de la app a mitad de una tool

| | |
|---|---|
| **Detección** | `recover()` al iniciar (§ 5): el run queda en un estado activo distinto de `awaiting_permission` |
| **Qué ve el usuario** | La tarjeta de "run interrumpido" de § 5.5, con el diagnóstico por hash cuando aplica |
| **Recuperación** | Se reconstruye desde `run_events` hasta `last_event_seq`; la escritura atómica de `edit_file`/`write_file` (temp + `rename`) garantiza que el archivo en disco queda **entero o intacto**, nunca a medio escribir, así que el diagnóstico por hash de § 5.4 siempre cae en uno de sus tres casos, nunca en un archivo corrupto a medias. El checkpoint permite revertir si algo se aplicó y no se quería |
| **Sin repetir** | Nunca hay auto-reejecución: el único camino para retomar es una decisión humana (revisar/revertir/marcar como hecho) o `run:continue`, y ambos producen una fila `tool_calls` nueva si hace falta repetir la acción |

### (9) JSON de tool call malformado o tool inexistente

| | |
|---|---|
| **Detección** | `ToolProtocol.parse` falla la validación `argsSchema` (`.strict()`), o el nombre de la tool no matchea ninguna registrada tras el intento de match tolerante (case-insensitive, snake/camel, Levenshtein ≤ 2) |
| **Qué ve el usuario** | *"Reintento 1/2"* visible en el turno; si el nombre no matchea, se muestra la lista de tools válidas que se le reenvió al modelo |
| **Recuperación** | Re-prompt con el error de validación o la lista de nombres válidos, como mensaje `role: tool`/`user` según transporte; contador de reintentos por turno con tope de 2; al tercer fallo, modo rescate con `format` (schema envelope en un request separado) `[HIPÓTESIS A PROBAR: que `format` y `tools` convivan sin degradar la salida en la misma llamada a `/api/chat`]`; si tampoco resuelve, `run.failed(format)` |
| **Sin repetir** | Una tool call que no pasa la validación **nunca llega a `tool_calls.pending`** — el registro en SQLite ocurre después de que `parse` produce un `ToolCall` válido, así que un JSON malformado no dejó rastro ejecutable que pudiera repetirse |

### (10) Loop del modelo (misma tool/args)

| | |
|---|---|
| **Detección** | `LoopDetector` sobre una ventana de 20 eventos: misma tool + mismo `args_hash` tres veces, mismo error tres veces, alternancia A-B seis veces, o tres mensajes seguidos sin tool ni `finish` |
| **Qué ve el usuario** | *"El agente se repite; se le pidió cambiar de estrategia."* |
| **Recuperación** | Primero un *nudge* (mensaje de sistema efímero pidiendo explícitamente otro enfoque); si el patrón persiste tras el nudge, `run.failed(loop)` con el historial completo disponible para revisar manualmente o continuar con una instrucción distinta |
| **Sin repetir** | El propio mecanismo de detección se apoya en `args_hash`, la misma columna que sostiene "no reutilizar filas": cada repetición detectada es una fila `tool_calls` nueva y separada, nunca la misma fila ejecutándose de nuevo por error del runtime |

### (11) Tool result gigante

| | |
|---|---|
| **Detección** | El resultado de una tool (típicamente `run_command` o `read_file` sobre un archivo grande) supera el umbral de truncado nivel 0 (30.000 caracteres, columna vertebral § 4) |
| **Qué ve el usuario** | En el chat, solo el `result_preview` truncado con una nota ("salida completa disponible") y un enlace para abrir el archivo completo en el panel de terminal/archivos |
| **Recuperación** | No es un fallo del run: `tool_calls.done` procede normalmente. El contenido completo se escribe a `appData/tool-outputs/<toolCallId>.txt`; `result_preview` (lo que efectivamente vio el modelo) queda en la fila de `tool_calls`. Si el propio truncado corta en medio de una necesidad real del modelo, este puede pedir `read_output(toolCallId, start, end)` para leer el archivo completo por partes dentro del presupuesto de contexto |
| **Sin repetir** | No aplica un riesgo de repetición peligrosa aquí — el resultado grande no es una acción, es un dato — pero el mismo mecanismo de truncado evita que un resultado gigante fuerce una compactación o un `context_overflow` en cascada, que sí podría inducir al modelo a repetir la tool creyendo que no se ejecutó |

### (12) Disco lleno o base de datos bloqueada

| | |
|---|---|
| **Detección** | Un `INSERT`/`UPDATE` de `run_events` o de una proyección falla con `SQLITE_FULL` (disco lleno, relevante en esta PC porque `C:` tiene 48,2 GB libres de 222,6 GB `[COMPROBADO EN EQUIPO]` mientras que `appData` suele vivir en `C:`) o con `SQLITE_BUSY` persistente pese al `busy_timeout` de WAL (base bloqueada por otro proceso, por ejemplo `saurio db rebuild` corriendo a mano). Una segunda instancia normal de SaurioLLM ya no puede producir este bloqueo: `requestSingleInstanceLock()` (§ 5.0) le impide abrir la base |
| **Qué ve el usuario** | Banner bloqueante, distinto de cualquier error de modelo: *"No se puede guardar el progreso: `<disco lleno / base de datos ocupada>`."* con la acción concreta ("liberá espacio en C:" o "cerrá el proceso externo que está usando la base de datos") |
| **Recuperación** | Como "registrar antes de actuar" exige que la fila `pending`/`running` exista en SQLite antes de invocar el `handler`, si el `INSERT` de esa fila falla, **el `handler` nunca se llama** — no hay ejecución fantasma. Si el fallo ocurre en el `commit` del checkpoint (después de que la tool ya escribió en disco), la post-imagen ya está en el blob store en memoria de proceso pero no en la tabla `checkpoints`; el run pasa a `failed` con un código propio (`db_write_failed`, ver § 8) y, al reiniciar, `recover()` trata ese run como cualquier `interrupted`: diagnóstico por hash sobre el archivo (§ 5.4), que en este caso caerá típicamente en "se aplicó completa" con el checkpoint reconstruido a partir del hash real, no del que se iba a escribir |
| **Sin repetir** | El mismo write-ahead que impide ejecutar sin fila `pending` impide, simétricamente, ejecutar cuando esa fila no se puede escribir: el fallo de persistencia es, por diseño, un fallo *antes* de actuar en la inmensa mayoría de los casos; el único punto donde la escritura en disco puede ir antes que el `commit` en SQLite es el `commit` del checkpoint mismo, y ese caso queda cubierto por el diagnóstico de `recover()` |

### (13) Conflicto con edición del usuario durante el run

| | |
|---|---|
| **Detección** | `edit_file` relee el archivo de disco al aplicar (nunca una copia cacheada de cuando se leyó) y compara su hash contra `tool_calls.expected_pre_hash` (§ 3) — la última lectura del run, persistida en SQLite y no en memoria, para que la comparación siga siendo válida aunque la tool call venga de un `awaiting_permission` que sobrevivió a un reinicio (§ 5.2); si difiere, o si `expected_pre_hash` es `NULL`, o si el `old_string` deja de matchear tras la cascada (`exact → eol → indent → whitespace → fuzzy`), se detecta que el usuario (o algo externo) tocó el archivo entre que el agente lo leyó/propuso y que se autorizó/ejecutó. `fs.watch` corriendo durante todo el run complementa esto marcando "archivo modificado externamente" en la UI apenas ocurre, sin esperar al intento de escritura |
| **Qué ve el usuario** | Si se detecta antes de escribir: *"El archivo cambió desde que lo leíste; releé antes de aplicar."* como resultado de error de la tool, con las 5–10 líneas más parecidas al `old_string` esperado, numeradas, para que el modelo pueda re-proponer con contexto actualizado |
| **Recuperación** | La tool falla (`tool_calls.failed`) **sin escribir nada**; el archivo del usuario permanece exactamente como estaba. El modelo recibe el error y puede volver a leer el archivo (`read_file`) y reproponer un `edit_file` nuevo. Si el conflicto se descubre después de haber escrito (caso límite: edición del usuario justo en la ventana entre el hash-check y el `rename` atómico), la próxima vez que se calcule un diff o se intente un revert, el mecanismo de `planRevert` (columna vertebral § 13) lo trata igual que cualquier archivo tocado también por el usuario: diff a tres vías (pre-imagen del agente / post-imagen del agente / estado actual) y decisión manual `restore`/`keep_mine`/`skip` |
| **Sin repetir** | La detección ocurre **antes** de la escritura en el caso normal, así que no hay nada que deshacer; en el caso límite, el revert nunca sobrescribe silenciosamente el trabajo del usuario — exige una decisión explícita por archivo, igual que cualquier conflicto de revert |

---

## 7. Health check, reconexión y limpieza al iniciar

**Health check.** `ModelManager` (único poller de `/api/ps`, columna vertebral § 9) hace `GET /api/version` al abrir el Centro de modelos, al iniciar un run que no tenga un health check reciente (< 5 s), y bajo demanda desde el banner de "Ollama no está corriendo". No hay un poller de salud independiente y continuo en el MVP — sería un segundo consumidor de red además del poller de `/api/ps`, contra el principio de no duplicar responsabilidades (condición 11).

**Reconexión.** Los únicos reintentos automáticos del sistema son los descritos en los casos (1)-(3): `connection_refused`/`stream_cut` una vez con backoff de 2 s si `health()` vuelve, y `server_busy` (cola llena de Ollama) hasta 3 veces con backoff de 3 s. Nunca hay reintento automático de una tool call — la condición 4 lo prohíbe explícitamente y el write-ahead lo hace además innecesario: el modelo, no el runtime, decide si repetir una acción tras verla fallar.

**Limpieza al iniciar.** Además de `recover()` (§ 5), el bootstrap hace, en orden: (a) `app.requestSingleInstanceLock()` (§ 5.0) — si falla porque ya hay una instancia, el proceso termina acá, antes de tocar SQLite; (b) migraciones de `drizzle-kit` embebidas; (c) apertura de la conexión SQLite con WAL y `busy_timeout` configurado; (d) `recover()` sobre `runs_active` filtrando por `owner_session_id`/`heartbeat_at`; (e) recién entonces, `chat:history` queda disponible para la UI. No hay limpieza de pids del sistema operativo más allá de lo descrito en § 5.7: SaurioLLM no mantiene una lista propia de "procesos que debería matar al reiniciar" persistida en SQLite en el MVP, porque un pid es válido solo dentro de la sesión de Windows en que se creó.

---

## 8. Logs y diagnóstico

Tres niveles, todos ya definidos por el modelo de datos, sin tabla nueva salvo la extensión de nomenclatura de § 10:

1. **`run_events`** es el log estructurado y consultable de cada run — la fuente de verdad de la condición 4. Todo lo que aparece en las tablas de este documento tiene un evento correspondiente.
2. **`audit_log`** (columna vertebral § 4) registra acciones administrativas de alto nivel que no son parte del ciclo de un run: reverts, cambios de reglas de permisos, `saurio db rebuild`.
3. **`tool-outputs/<toolCallId>.txt`** y el `error_json`/`error` de `runs`/`tool_calls`/`model_load_samples` son el detalle técnico crudo (stdout/stderr de comandos, texto de error de llama-server) que un desarrollador —el propio usuario, en este proyecto solo— necesita para diagnosticar un caso de la tabla del § 6 sin adivinar.

El diagnóstico expuesto en la UI (§ 5.5, banners de §§ 6.2 y 6.12) siempre cita la fuente: "medido" cuando viene de `/api/ps` o de un evento real, "estimado" cuando viene del `MemoryEstimator`, nunca mezclado sin aclarar (principio 6 de la columna vertebral, condición 3).

---

## 9. MVP vs después

**Imprescindible para el MVP.** Los 13 casos de la tabla del § 6 con su detección, mensaje y recuperación descritos arriba; la máquina de estados completa de § 2 con persistencia por transición, incluyendo `cancelling` como estado de espera real (§ 6.7); el write-ahead de tool calls con `category`/`risk`/`args_hash`/`expected_pre_hash`; `app.requestSingleInstanceLock()` y el par `owner_session_id`/`heartbeat_at` en `runs` (§ 5.0); `recover()` con las cuatro reglas de diagnóstico por hash para `orphaned` de tools de archivo (§ 5.4) y con salida parcial para `run_command`; los mensajes `tool` sintéticos para tool calls que quedan `orphaned`/`abandoned`/`cancelled` al cerrar un run (§ 5.6); reintentos automáticos únicamente para `connection_refused`/`stream_cut` y `server_busy`; truncado nivel 0 + `tool-outputs/`; `LoopDetector`; escritura atómica de `edit_file`/`write_file`.

**Previsto para más adelante.** Reanudación con confirmación granular por tool, es decir la posibilidad de retomar una tool `orphaned` puntual con un solo click en vez de crear un `run:continue` completo (v0.3, columna vertebral § 12); *"Pasar a background"* real para comandos largos que siguen corriendo mientras el modelo continúa con otra cosa (v0.2, hoy el MVP solo ofrece Esperar/Matar); un `OllamaProcessManager` en modo managed que permita además "Iniciar Ollama" desde el banner del caso (2) (v0.3); shadow repo (`GIT_DIR` externo) como detector adicional de archivos tocados por comandos, útil para ampliar el caso (13) a efectos de `run_command` y no solo de `edit_file`/`write_file` (v0.3, columna vertebral § 13); limpieza activa de procesos huérfanos por heurística de línea de comandos en vez de solo documentar el límite (evaluar en v0.2 si los huérfanos de un cierre forzado, § 5.7, resultan ser un problema real en la práctica).

---

## Nomenclatura agregada

Estos nombres no existen en la columna vertebral y se derivan del mismo estilo (`snake_case` para códigos de error, `PascalCase` para tipos) para cubrir casos que el brief pide documentar y que la columna vertebral no tipó explícitamente:

- **`db_write_failed`** — nuevo valor de `RunError.code` (extiende el enum de `packages/shared/src/events.ts`) para el caso (12) cuando una escritura de `run_events`/proyección falla por `SQLITE_FULL` o `SQLITE_BUSY` agotado. No reemplaza ningún valor existente.
- **`ToolCallErrorCode`** — nuevo tipo, `z.enum(['disk_full', 'db_locked', 'result_too_large', 'edit_conflict', 'path_denied', 'timeout', 'process_killed', 'unknown'])`, pensado para estructurar `tool_calls.error_json.code` (hoy la columna vertebral solo define `error_json` como TEXT libre). Es aditivo: no cambia el DDL de `tool_calls`, solo da forma al contenido JSON que ya existía sin tipar. `edit_conflict` cubre el caso (13); `disk_full`/`db_locked` cubren el (12); `result_too_large` documenta, sin ser un error real, el motivo de un truncado nivel 0 cuando conviene registrarlo explícitamente en logs de diagnóstico.
- **`read_output(toolCallId, start, end)`** — parámetros de la tool builtin `read_output` (ya listada en la columna vertebral § 3 y § 13 sin firma detallada); se documenta aquí la firma usada para el caso (11), consistente con `read_file` que también pagina por líneas.
- **`tool_calls.expected_pre_hash`** (columna `TEXT`, nullable) — nueva columna en `tool_calls`, escrita junto con `tool.registered` (§ 3). Persiste en SQLite lo que hasta esta revisión era una comparación contra memoria del `RunController`, para que sobreviva a un reinicio con el run en `awaiting_permission` (§ 5.2).
- **`runs.owner_session_id` / `runs.heartbeat_at`** (columnas `TEXT` / `INTEGER`) — nuevas columnas en `runs`, defensa en profundidad detrás de `app.requestSingleInstanceLock()` para el caso de perfiles o bases compartidas entre procesos de sistemas distintos (§ 5.0).
- **`cancelKillTimeoutMs`** — nueva constante de configuración (10 s por defecto) que acota cuánto tiempo un run permanece en `cancelling` esperando a que retornen los handlers `running` antes de cerrar en `cancelled` (§ 6.7).

## Desvíos respecto de la columna vertebral

- **Cobertura de casos ampliada de 11 a 13 filas.** La tabla de fallos de la columna vertebral § 12 documenta explícitamente 11 situaciones (agrupando OOM de carga y de generación en dos filas separadas dentro de esa tabla). El brief de este documento pide además "tool result gigante" (11), "disco lleno o base de datos bloqueada" (12) y "conflicto con edición del usuario durante el run" (13). No hay contradicción: los mecanismos que sostienen estos tres casos ya existen en la columna vertebral (truncado nivel 0 y `tool-outputs/` en § 4; write-ahead en § 1 y § 12; hash-check de `edit_file` y `planRevert` en § 13) pero no estaban reunidos como filas propias de la tabla de fallos. Se los agrega aquí como extensión, no como rediseño, y se introduce el código `db_write_failed` y el tipo `ToolCallErrorCode` (ver arriba) porque la columna vertebral no tenía un lugar tipado para ellos.
- **Corrección de la condición 13(a) aplicada.** Todo este documento usa "10 tools builtin" (`list_files, search_code, read_file, read_output, edit_file, write_file, delete_file, run_command, task_update, finish`) y "6 tools en modo plan", no "8 tools", siguiendo la corrección explícita de la condición 13(a) sobre el resumen ejecutivo de la columna vertebral.
- **§ 5.7 (limpieza de procesos huérfanos) es más cauto que un "matar por pid" ingenuo.** La columna vertebral menciona "procesos huérfanos al reiniciar" en el enunciado de la condición 4 pero no especifica el mecanismo en el § 12. Se optó por *no* matar pids guardados de sesiones anteriores (un pid de Windows no es estable entre reinicios del sistema) y documentar el límite operativo del cierre forzado en vez de prometer una limpieza que no se puede garantizar de forma segura. Esto no contradice ninguna decisión cerrada, pero rellena un vacío operativo con una decisión propia, por eso se declara aquí.
- **Correcciones aplicadas en esta revisión (hallazgos de coherencia/factibilidad/adversario).** Se corrigió § 5.7 para eliminar la suposición refutada de que Windows termina hijos de un proceso muerto, reemplazándola por `taskkill /T /F` en los handlers de cierre de Electron y documentando el límite real ante un cierre forzado. Se reescribió § 5.4 con las cuatro reglas de diagnóstico por hash (en vez de tres), agregando el caso de `post_hash NULL` con archivo ya distinto de `pre_hash`. Se agregó `tool_calls.expected_pre_hash` para que la protección de § 6 caso (13) sobreviva a un `awaiting_permission` persistido a través de un reinicio (§ 5.2, § 3). Se agregaron `app.requestSingleInstanceLock()` y `runs.owner_session_id`/`heartbeat_at` para que `recover()` no interrumpa un run que otra instancia todavía está ejecutando (§ 5.0). Se redefinió `cancelling` como estado de espera real con `cancelKillTimeoutMs`, en vez de un paso instantáneo hacia `cancelled` (§ 2, § 6.7). Se agregaron mensajes `tool` sintéticos para `orphaned`/`abandoned`/`cancelled` al cerrar un run, y se aclaró que el mensaje `truncated = 1` se excluye del contexto del reintento del mismo turno (§ 5.6, § 6.3). Ninguna de estas correcciones cambia una decisión cerrada de la columna vertebral: todas rellenan un mecanismo que el brief pedía pero que la columna vertebral no detallaba a este nivel.
- **Fuera de alcance de esta edición (no aplicado en este documento).** Dos hallazgos pedían replicar cambios en otros documentos: la tabla de cuatro reglas de § 5.4 en doc 09 § 3.5, y la exclusión de mensajes truncados del contexto de reintento en doc 07. El encargo de esta revisión es exclusivamente doc 10; ambas réplicas quedan señaladas en el texto de este documento (§ 5.4, § 6 caso 3) para que se apliquen en una edición separada de doc 09 y doc 07, y se listan en "skipped" de la salida estructurada por la misma razón, no porque contradigan la columna vertebral.

## Preguntas abiertas

Ninguna de las anteriores cambia el diseño: son extensiones consistentes con las interfaces y las tablas ya definidas en la columna vertebral. La única cuestión no resuelta que sí podría afectar el diseño de este documento en el futuro es si vale la pena, ya en v0.2, guardar una lista best-effort de pids de `run_command` en una tabla nueva (por ejemplo `running_processes(pid, tool_call_id, started_at)`, borrada al cerrar limpio) para poder al menos *intentar* un `taskkill` dirigido al reiniciar después de un cierre forzado — hoy (§ 5.7) se decidió no hacerlo por el riesgo de matar un proceso reasignado, pero si en la práctica quedan procesos huérfanos con frecuencia, esa mitigación cambiaría el modelo de datos de este documento.
