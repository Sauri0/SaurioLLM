# Documento 13: Centro de modelos y recomendaciones

Diseño del Model Hub de SaurioLLM: catálogo, descargas, almacenamiento, Hardware Profiler y motor de recomendaciones, sin invadir responsabilidades del Model Manager ni del Scheduler.

Leyenda: `[COMPROBADO EN EQUIPO]` `[VERIFICADO EN DOC OFICIAL]` `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]`

---

## 1. Objetivo

El **Centro de modelos** (Model Hub, en la UI bajo `features/models/`) es la pantalla donde el usuario ve qué modelos tiene, qué modelos podría tener, cuánto pesan, si le entran en su hardware, y decide instalar, borrar o elegir uno para un chat. No es un cliente genérico de Ollama: es la superficie de usuario sobre datos que ya produce `ModelManager` (columna vertebral §9, §17) más tres componentes nuevos que este documento especifica en detalle — `DownloadManager`, `HardwareProbe` y `RecommendationEngine` — todos alojados en `packages/runtime/src/models/` junto al `ModelManager` existente, nunca duplicando lo que él ya hace.

El caso concreto que ancla todo el documento: el usuario tiene hoy `gemma4:26b` y `gemma4:31b` instalados en `N:\OllamaModels` `[COMPROBADO EN EQUIPO]`, una RTX 3060 Ti de 8192 MiB `[COMPROBADO EN EQUIPO]` y 31,9 GB de RAM `[COMPROBADO EN EQUIPO]`. Ninguno de los dos modelos entra en la GPU, y el intento real del 17/09 con `gemma4:31b` terminó en `cudaMalloc failed: out of memory` tras 1m14s `[COMPROBADO EN EQUIPO]` (condición 12; ver §6.4). El Centro de modelos existe, entre otras cosas, para que esa situación se vea venir en la UI antes de que el usuario pierda un minuto y catorce segundos esperando un error.

---

## 2. Responsabilidades y límites

La regla general (spine §2.1, principio 8 y ADR-7): nada se ajusta solo, todo se mide antes de recomendarse como probado, y cada componente tiene un único escritor por tabla.

| Componente | Qué expone / hace | Qué NO hace |
|---|---|---|
| **ModelManager** (existente, spine §2.1 y §9) | Catálogo de modelos **instalados**, `capabilities`, `describeModel`, único poller de `/api/ps` (emite `models.loaded`), `MemoryEstimator.fits()` (estimación), `HardwareProbe` (inventario, ver §7), único **lector** de `model_compat` | No escribe `model_compat`; no decide catálogo de modelos **no instalados**; no descarga ni elimina |
| **Model Hub / DownloadManager** (nuevo, v0.2) | Catálogo curado + búsqueda, ficha de modelo, tamaño de descarga por tag, verificación de espacio, `pull` con progreso/velocidad/cancelación, `delete` | No estima VRAM ni tok/s (eso es `MemoryEstimator` y `Benchmark`); no cambia la configuración de Ollama sin autorización explícita |
| **HardwareProbe** (nuevo, dentro de `runtime/models`, ya nombrado en el diagrama de capas de spine §2 dentro de `ModelManager`; este documento lo trata como submódulo propio reutilizado por ambos) | Inventario de CPU/RAM/GPU/VRAM por plataforma, con `quality` y `source` por dato | No decide `fitClass` (eso es `MemoryEstimator`); no mide tok/s |
| **RecommendationEngine** (nuevo, v0.3) | Función pura: hardware × catálogo × `model_compat` → tarjetas ordenadas con etiqueta estimado/probado | No escribe `model_compat` (solo Benchmark la escribe); no descarga nada por sí solo; nunca cambia de localidad |
| **InferenceScheduler** (existente) | Impide `delete`/`unload` forzoso de un modelo con generación en curso: el Model Hub pide `unload` antes de `delete`, y si el modelo está en la cola con trabajo pendiente, el `delete` queda bloqueado con el motivo visible | No decide qué se descarga, no recomienda, no calcula catálogo ni tamaños |
| **Benchmark** (existente, v0.3, spine §19) | Único escritor de `model_compat`; produce el estado "probado" que usa el Centro de modelos | No aparece en el Centro de modelos como pantalla propia (pantalla separada, "Banco de pruebas"); el Centro de modelos solo **lee** sus resultados |

Esta tabla es una instancia de la frontera que spine §2.1 ya fija para Telemetry ("no consulta Ollama por su cuenta ni estima VRAM"): aquí el mismo principio se aplica al Centro de modelos ("no mide, no adivina por su cuenta: muestra lo que otros componentes midieron o estimaron, con su etiqueta").

---

## 3. Catálogo

**Fuente.** No existe un endpoint oficial de catálogo/búsqueda en la librería de Ollama `[VERIFICADO EN DOC OFICIAL: investigación 4 §3.4 — ausencia confirmada en la lista de endpoints de api.md]`. `https://ollama.com/api/tags` existe pero es no documentado, trae solo ~20 modelos destacados con tamaños genéricos (ej. `gemma4:31b` como bf16, no el Q4 real) y `details` vacíos `[VERIFICADO EN DOC OFICIAL: investigación 4 §3.4]` — **no sirve como catálogo** `[DECISIÓN DE DISEÑO]`.

Por eso el catálogo de SaurioLLM es: `resources/model-catalog.json` `[DECISIÓN DE DISEÑO]`, una lista curada y versionada con `{ name, tag, sizeBytes, capabilities, contextMax, quantization, suggestedUse[], notes }` por entrada, mantenida a mano (no generada dinámicamente) y actualizada en cada release de SaurioLLM. Al mostrar una ficha, el tamaño se **refresca en vivo** contra el manifest real: `GET https://registry.ollama.ai/v2/library/<modelo>/manifests/<tag>` funciona sin autenticación `[VERIFICADO EN DOC OFICIAL: investigación 4 §3.2, probado contra gemma4:26b/31b]` y devuelve un manifest Docker v2 con `layers[].size` por capa (`model`, `projector`, `draft`, `template`, `license`, `params`). El tamaño de descarga real es la suma de las capas que **no** están ya en `OLLAMA_MODELS/blobs` (las capas se comparten entre tags, así que instalar `gemma4:e2b-it-qat` después de `gemma4:26b` puede pesar menos de lo que el manifest indica en bruto).

**Búsqueda.** Filtro de texto sobre el catálogo local (nombre, familia, uso sugerido) + un botón "buscar en ollama.com" que abre `https://ollama.com/search?q=<term>` en el navegador del sistema (nunca embebido, nunca scraping de HTML: eso sería frágil y no verificado como fuente estable `[DECISIÓN DE DISEÑO]`). Un modelo que el usuario quiere y no está en el catálogo curado se puede pedir por nombre libre ("pull manual"): el Model Hub intenta el manifest, y si el registry responde, arma una ficha mínima al vuelo (tamaño real, sin capabilities curadas hasta que se instale y `describeModel` las traiga).

**MVP vs después.** En el MVP el catálogo **no existe como pantalla**: el Centro de modelos mínimo solo lista lo instalado (spine §16). El catálogo, la búsqueda y el pull manual son v0.2.

---

## 4. Ficha de modelo

Cada tarjeta/ficha en el Model Hub combina tres fuentes con distinta frescura, y nunca mezcla sus etiquetas de calidad:

| Campo | Fuente | Cuándo se conoce | Calidad |
|---|---|---|---|
| Tamaño de descarga por tag | Manifest del registry (§3) | Antes de instalar, refrescado al mostrar | `measured` (es el tamaño real de las capas) |
| Capabilities (`tools`, `vision`, `thinking`, `embedding`) | Catálogo curado (antes de instalar) → `POST /api/show` (`capabilities`) tras instalar `[VERIFICADO EN DOC OFICIAL: investigación 1, investigación 4 §5.1]` | Curado: aproximado; instalado: exacto | Curado: nota "según catálogo"; instalado: `measured` |
| Contexto máximo (`context_length`) | Catálogo curado → `model_info.<arch>.context_length` de `/api/show` tras instalar | igual que arriba | igual que arriba |
| Cuantización | Catálogo curado → `details.quantization_level` de `/api/tags` tras instalar | igual | igual |
| Estado | `not_installed` \| `downloading` \| `installed_untested` \| `installed_tested` \| `loaded` | Se deriva de `downloads.status`, `models` y `/api/ps` | `measured` (son estados internos, no mediciones de hardware) |
| Compatibilidad **estimada** | `MemoryEstimator.fits()` (spine §9) contra el `HardwareProbe` actual | Sin cargar el modelo | `estimated`, siempre etiquetada así en la UI |
| Compatibilidad **probada** | `model_compat` con `status = 'fits'` y `hardware_fingerprint` igual al de esta máquina (spine §19) | Solo tras correr el Banco de pruebas | `measured`, con fecha ("Probado el 18/09: 14 tok/s a 16K") |

**Regla de UI** `[DECISIÓN DE DISEÑO]`: la ficha nunca muestra un tok/s o una VRAM sin la palabra "estimado" o "probado (fecha)" pegada al número, siguiendo el principio 6 de spine ("Medido ≠ estimado"). Si no hay `model_compat` para el `hardware_fingerprint` de esta máquina, el badge de velocidad es siempre "estimado" aunque el modelo ya esté instalado y cargado — cargarlo no prueba tok/s, solo prueba `fitClass` real vía `/api/ps` (eso sí es `measured`, ver tabla de §7).

---

## 5. Flujo de descarga (v0.2)

Todo el flujo vive en `DownloadManager` (`packages/runtime/src/models/DownloadManager.ts`), que escribe la tabla `downloads` ya definida en spine §4 y emite los eventos `download:progress` / `download:done` / `download:failed` ya definidos en spine §17.

1. **Tamaño y espacio.** Se pide el manifest (§3), se calcula el faltante restando lo que ya existe en `blobs/`, y se llama `fs.statfsSync(root de OLLAMA_MODELS)` — disponible porque Electron 44.4.2 embebe Node 24.21.0 y `fs.statfs` está soportado desde Node 19.6 `[VERIFICADO EN DOC OFICIAL: investigación 4 §2, probado en esta máquina: N: 480.359.034.880 bytes libres = 447 GB]` `[COMPROBADO EN EQUIPO]`. **Regla explícita de bloqueo** `[DECISIÓN DE DISEÑO]` (condición 11.A): antes de emitir `models:pull`, `DownloadManager` compara el `sizeBytes` faltante del manifest contra el espacio libre detectado. Si `libre < faltante + 2 GiB` de margen, la descarga **no se inicia**: `downloads.status` pasa a `insufficient_space` (nuevo valor del enum de estado de `downloads`, junto a `pending | downloading | done | cancelled | failed`, sin agregar columna nueva) y el botón "Descargar" queda deshabilitado con el motivo visible ("faltan X GB en N:"), sin bloquear la exploración del catálogo. Esta verificación se repite si el usuario reintenta tras liberar espacio (no queda cacheada la respuesta negativa).
2. **Pull con progreso.** `POST /api/pull { model, stream: true }` con `AbortSignal` propio (nunca el cliente `ollama` npm, por ADR-2). El progreso es por capa (`completed/total`); el progreso global se calcula como `(bytes ya locales + completado de la capa activa + capas ya terminadas) / Σ layers[].size` `[VERIFICADO EN DOC OFICIAL: investigación 4 §3.3]`. Velocidad con media móvil sobre `Δcompleted/Δt` (el servidor emite progreso cada ~60 ms en 16 partes paralelas, por lo que `completed` avanza a saltos) `[VERIFICADO EN DOC OFICIAL: investigación 4 §3.3]`; ETA = restante / velocidad.
3. **Cancelación.** Abortar la request HTTP corta la descarga en el servidor (`context.WithCancel`); `downloads.status = 'cancelled'`.
4. **Reanudación.** Ollama guarda `<blob>-partial` y partes `<blob>-partial-N`; una descarga cancelada y reiniciada **desde la misma sesión de SaurioLLM** se reanuda. Tras un **reinicio del servidor de Ollama**, la reanudación **no está garantizada**: la documentación dice que se reanuda, pero el código de poda (`PruneLayers`, con 1 h de gracia, desactivable con `OLLAMA_NOPRUNE`) corre dentro del propio `PullModel` y no hay garantía documentada de qué sobrevive a un reinicio del proceso `[VERIFICADO EN DOC OFICIAL: investigación 4 §3.3, contradicción declarada entre api.md y server/images.go]`. La UI lo comunica así: "si Ollama se reinicia durante la descarga, puede que tengas que empezar de nuevo" — no se promete algo que no está confirmado.
5. **Errores.** Manifest 404 (nombre/tag inexistente), pull que corta a mitad (`connection_refused`/`stream_cut`, mismo vocabulario de `ProviderErrorCode` que usa el Gateway), espacio agotado a mitad de descarga (el filesystem lo rechaza; se detecta por el error de escritura y se muestra "sin espacio en N:").
6. **Eliminación.** `DELETE /api/delete { model }` tras confirmación con el tamaño en GB a liberar. Si el modelo está `loaded` (según el último `/api/ps` del `ModelManager`), el Model Hub primero pide `unload(name)` al Provider (vía el Gateway, nunca directo) y espera confirmación antes de habilitar el botón; si el modelo tiene trabajo encolado en el `InferenceScheduler`, el botón queda deshabilitado con "modelo en uso" hasta que la cola se vacíe — esta es la única intervención del Scheduler en el Centro de modelos (condición 11.A).

**MVP vs después.** Todo este flujo es **v0.2** (spine §10, §16). En el MVP el Centro de modelos es de solo lectura sobre lo instalado; `pull`/`delete` no existen todavía en la UI ni en `Provider` (los métodos están declarados como opcionales en la interfaz `Provider`, spine §5, marcados `// v0.2`).

---

## 6. Almacenamiento: carpeta de modelos y modos attach/managed

**Detección (attach, MVP).** La API de Ollama no expone la carpeta de modelos en ningún endpoint — la lista completa documentada es `/api/generate, /api/chat, /api/create, /api/blobs/:digest, /api/tags, /api/show, /api/copy, /api/delete, /api/pull, /api/push, /api/embed, /api/ps, /api/embeddings, /api/version`, ninguno la devuelve `[VERIFICADO EN DOC OFICIAL: investigación 4 §3.1]`. SaurioLLM la infiere leyendo la variable de entorno con `[Environment]::GetEnvironmentVariable('OLLAMA_MODELS', 'User')` y luego `'Machine'`, con fallback al default (`C:\Users\%username%\.ollama\models` en Windows `[VERIFICADO EN DOC OFICIAL: docs.ollama.com/windows]`), y **valida** el resultado comprobando que exista `manifests/registry.ollama.ai/library/<nombre>/<tag>` para al menos un modelo de los que devuelve `/api/tags` en ese momento. Hoy esa carpeta es `N:\OllamaModels`, configurada como variable de usuario **y** de máquina `[COMPROBADO EN EQUIPO]`.

**Modos del servidor** `[VERIFICADO EN DOC OFICIAL: investigación 4 §3.5]`:

- **Attach** (MVP y default siempre): SaurioLLM se conecta al servidor que ya corre en `127.0.0.1:11434`, sea porque el usuario lo dejó corriendo desde una terminal o porque la app de bandeja de Ollama lo levantó. **Nunca** mata ni relanza ese proceso — matarlo no sirve de nada porque la app de bandeja lo relanza automáticamente `[VERIFICADO EN DOC OFICIAL: issue ollama/ollama#14761, citado en investigación 4 §3.5]`, y hacerlo violaría la condición 6 (modo lectura) y el principio "local por defecto, ningún componente cambia configuración sin autorización". **Cambiar la carpeta en attach** significa guiar al usuario paso a paso fuera de la app (cerrar la app de bandeja, editar la variable de entorno, reiniciar la app o el terminal) — SaurioLLM nunca edita esa variable por su cuenta, ni con confirmación, porque no controla el proceso que la lee.
- **Managed (v0.3):** SaurioLLM lanza su propia instancia (`ollama serve`) en un puerto propio (`127.0.0.1:11435`, para no chocar con la instancia de bandeja) con `OLLAMA_MODELS` puesto por el usuario en ese momento, tras una confirmación explícita que aclara que la instancia de bandeja sigue corriendo sin cambios y que, si la carpeta elegida es distinta, los modelos **no se comparten** entre ambas instancias. **Cambiar la carpeta en managed** es simplemente relanzar el proceso propio con otro valor de `OLLAMA_MODELS`, sin tocar la instancia ajena.

En ambos modos, cambiar la carpeta de modelos **requiere autorización explícita del usuario en cada ocasión**; SaurioLLM nunca la cambia como efecto colateral de una recomendación o de una descarga.

**Advertencias sin tocar la configuración** (condición 12.c, obligatorias en modo attach): el relevamiento de la máquina del usuario encontró, en la base de la app de escritorio de Ollama (`%LOCALAPPDATA%\Ollama\db.sqlite`, tabla `settings`), `context_length = 262144` y `expose = 1` `[COMPROBADO EN EQUIPO]`; el `server.log` del mismo día confirma que el servidor arrancó con `OLLAMA_CONTEXT_LENGTH:262144` y `OLLAMA_HOST:http://0.0.0.0:11434` (escucha en toda la red) `[COMPROBADO EN EQUIPO]`. El Centro de modelos muestra dos avisos permanentes mientras el provider esté en modo attach y estos valores se detecten (vía `/api/ps context_length` para el contexto, y por convención — no hay endpoint que confirme el bind — para la exposición, con un enlace "cómo revisar/cambiar esto vos mismo"):

- "Ollama expuesto en la red (`0.0.0.0`): cualquier equipo en tu red puede usarlo."
- "Contexto por defecto de 256K en la app de bandeja: SaurioLLM siempre manda su propio `num_ctx`, pero si usás Ollama directamente desde otra herramienta, revisalo."

**Alcance de la detección de exposición en red** `[DECISIÓN DE DISEÑO]`: no existe ningún endpoint de la API de Ollama que confirme a qué interfaz está bindeado el servidor (§6, lista completa de endpoints ya verificada), así que SaurioLLM nunca "sabe" el bind real. Lo que hace es una heurística limitada a lo observable desde el cliente: contrasta si el `baseUrl` configurado es loopback (`127.0.0.1`/`localhost`) o no, y — cuando el `baseUrl` es loopback — igual advierte si detecta señales indirectas de exposición amplia (p. ej. el valor `OLLAMA_HOST` leído del entorno, cuando es legible, o el patrón ya confirmado en esta máquina de que la app de bandeja de Ollama expone `0.0.0.0` por defecto). El caso concreto documentado arriba (`0.0.0.0`, `db.sqlite.settings.expose = 1`, `server.log` de esta máquina) es `[COMPROBADO EN EQUIPO]`; el caso general — por ejemplo, un usuario con `OLLAMA_HOST` apuntando a una IP de LAN específica en lugar de `0.0.0.0`, o un servidor detrás de un proxy/túnel — **no está cubierto** por esta heurística y puede dar falsos negativos (no avisa aunque el servidor esté expuesto) o falsos positivos (avisa sobre un bind que en realidad es seguro); esto queda `[HIPÓTESIS A PROBAR]` para cualquier máquina distinta de la relevada, y el Centro de modelos lo comunica en el propio texto del aviso ("SaurioLLM no puede confirmar a qué red escucha Ollama; esto es una estimación basada en tu configuración") en vez de presentarlo como una detección certera.

Ninguno de los dos avisos incluye un botón que cambie la configuración: son solo texto y un enlace a la documentación de Ollama, en línea con la condición 6.

**Consecuencia obligatoria de diseño (condición 12.b).** Por esto mismo, `ModelGateway`/`OllamaProvider` **siempre** manda `options.num_ctx` explícito en cada `/api/chat` (spine §1.2, ADR-2 y §6 paso 4 ya lo fijan; este documento lo repite porque es la mitigación directa del incidente de OOM de abajo) y el `AgentRuntime` verifica el `context_length` efectivo devuelto por `/api/ps` contra lo pedido, mostrando un `run.adjustment`/diagnóstico si difieren (spine §18, regla de diagnóstico "`/api/ps context_length` ≠ `numCtx` pedido").

**El caso real del 17/09 (condición 12.d, ejemplo de referencia para este documento y los docs 08/10/14).** El usuario intentó cargar `gemma4:31b` con el contexto heredado de 262144 de la app de bandeja. El log muestra: `llama_kv_cache: size = 20480.00 MiB (262144 cells, 10 layers)`, solo 1 de 61 capas offloadeadas a GPU, un intento de reservar 2405 MiB de compute buffers con `cudaMalloc failed: out of memory`, `Load failed`, y `POST /api/chat` devolviendo HTTP 500 después de 1m14s de espera `[COMPROBADO EN EQUIPO]`. Este es el escenario exacto que el diagnóstico "Modelo no entra / OOM en carga" de spine §12 cubre, y que el flujo del Centro de modelos (§4, columna "compatibilidad estimada") busca anticipar **antes** de que el usuario espere ese minuto y catorce segundos: si `MemoryEstimator.fits()` con el `num_ctx` que va a usar SaurioLLM (nunca 256K por defecto) devuelve `no_fit` o `partial_offload`, la ficha lo muestra en rojo antes de intentar cargar.

---

## 7. Hardware Profiler

**Qué hace.** Arma el inventario de hardware que consume `MemoryEstimator.fits()` y `RecommendationEngine`. Cada dato se guarda con la forma `{ value, unit, quality: 'measured' | 'estimated' | 'unavailable', source, sampledAt }` — el mismo contrato de calidad que usa Telemetry (spine §18) — en `settings.hardware_inventory_json` (spine §17).

**Fuentes por dato y por plataforma**, con confiabilidad explícita `[VERIFICADO EN DOC OFICIAL / COMPROBADO EN EQUIPO: investigación 4 §1]`:

| Dato | Fuente confiable (`measured`) | Fuente no confiable / fallback (`estimated` o descartada) |
|---|---|---|
| CPU nombre, hilos lógicos | `os.cpus()` | — |
| Núcleos físicos | `systeminformation.cpu()` (una sola vez al abrir el Hub, no en polling: cada llamada lanza un proceso hijo) | — |
| RAM total / libre | `os.totalmem()` / `os.freemem()` | — |
| VRAM total (NVIDIA, Windows/Linux) | `nvidia-smi --query-gpu=memory.total,... --format=csv,noheader,nounits` | WMI `Win32_VideoController.AdapterRAM`: es `uint32`, satura en 4 GiB — en esta máquina reporta 4293918720 bytes (4 GiB) para una GPU de 8 GiB `[COMPROBADO EN EQUIPO]`, **no usar** salvo como último recurso marcado "posiblemente truncado" |
| VRAM total (cualquier vendor, Windows) | Registro `HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000 → HardwareInformation.qwMemorySize` (QWORD, 64 bits): en esta máquina da 8589934592 bytes (8 GiB), el valor correcto `[COMPROBADO EN EQUIPO]` | El `DWORD` hermano `MemorySize`/`AdapterRAM` en la misma clave está truncado igual que el WMI (4293918720) `[COMPROBADO EN EQUIPO]` |
| VRAM usada / utilización GPU (NVIDIA) | `nvidia-smi` puntual al abrir el panel (MVP) o `-lms` continuo (v0.2) | `nvidia-smi --query-compute-apps` por proceso devuelve `[N/A]` bajo WDDM `[VERIFICADO EN DOC OFICIAL: investigación 4 §1.2]` — no atribuye VRAM por proceso; usar `/api/ps size_vram` para eso |
| VRAM usada (Windows, cualquier vendor) | Contadores `\GPU Adapter Memory(*)\Dedicated Usage` con período ≥ 10 s (v0.2) | — |
| GPU AMD (Linux) | `rocm-smi --showmeminfo vram --json` / `amd-smi metric --mem-usage --json` (v0.2) | En Windows no hay rocm-smi/amd-smi: usar registro `qwMemorySize` + contadores + log de Ollama |
| GPU Apple Silicon | Línea `inference compute ... available=` del log de Ollama (memoria unificada vía `MTLDevice.recommendedMaxWorkingSetSize`) (v0.2) | `os.totalmem() × factor` es `estimated`; no hay VRAM separada que medir |
| VRAM por modelo cargado | `/api/ps size_vram` tras carga real (`ModelManager`, ya especificado en spine §9) | Fórmula de `MemoryEstimator` antes de cargar, siempre `estimated` |
| Espacio en disco de `OLLAMA_MODELS` | `fs.statfsSync` sobre la raíz de la unidad (§5) | — |

**Cacheo y refresco.** El inventario de CPU/RAM se recalcula en cada apertura del Centro de modelos (barato, sin spawn de procesos). El de GPU vía `nvidia-smi`/`systeminformation.cpu()` se cachea en `settings.hardware_inventory_json` con `sampledAt` y se refresca manualmente con un botón "Actualizar hardware" o automáticamente una vez por sesión de la app (spawnear un proceso en cada render sería costoso: cada llamada a `si.graphics()` tarda cientos de ms `[VERIFICADO EN DOC OFICIAL: investigación 4 §1.5]`). El valor **medido** en esta sesión de referencia: 8192 MiB totales, 867–915 MiB usados en dos lecturas distintas en reposo, utilización 29–32 % `[COMPROBADO EN EQUIPO]` — ese "ruido de base" (~900 MiB ya ocupados por el compositor de Windows/Chrome antes de que Ollama cargue nada) se resta implícitamente en `MemoryEstimator.fits()` al calcular `vramAvailable` (spine §9: `vramFree(HardwareProbe) − 512 MiB`).

**MVP vs después.** CPU/RAM (siempre medidos), VRAM NVIDIA por `nvidia-smi` bajo demanda, badge de localidad, aviso si Ollama no corre: todo MVP (spine §16, fila ModelManager). AMD/Apple/registro Windows, contadores continuos y `-lms`: v0.2.

---

## 8. Motor de recomendaciones (v0.3)

**Entradas.** `{ vramAvailable, ramFree, cpuThreads }` (del Hardware Profiler) × `uso ∈ { coding, chat, analysis, vision }` × `objetivo ∈ { speed, quality }`, elegidos por el usuario en la UI del Hub.

**Reglas** `[HIPÓTESIS A PROBAR: los umbrales exactos, no la lógica]`:
1. Filtra por `capabilities` requeridas: `coding`/`agent` exige `tools`; `vision` exige `vision`.
2. Calcula `fitClass` con la misma fórmula que `MemoryEstimator` (spine §9: `fits_gpu | tight | partial_offload | no_fit`), usando el `num_ctx` que SaurioLLM va a mandar realmente (nunca el default de 256K de la app de bandeja).
3. Ordena por tamaño ascendente si `objetivo = speed`, por `quality_score` de `model_compat` (o, sin ninguna prueba todavía, por el `quality_score` **curado** del catálogo, marcado como tal) si `objetivo = quality`.
4. Cada tarjeta de salida trae: badge de localidad (LOCAL/LAN/NUBE, §9), tamaño de descarga, capabilities, y una de tres leyendas: "estimado: entra 100 % en GPU a 16K", "estimado: requiere CPU/RAM además de GPU (offload parcial)", o "no recomendado: no entra ni con offload razonable". La leyenda **"Probado el DD/MM: 42 tok/s a 16K"** solo aparece si existe una fila en `model_compat` con `status = 'fits'` para el `hardware_fingerprint` exacto de esta máquina (spine §19) — nunca se muestra un número de tok/s sin que Benchmark lo haya medido en esta PC.

**Resultado esperado para el caso concreto del usuario** `[HIPÓTESIS A PROBAR]` (investigación 4 §10, con la fórmula de KV cache derivada y verificada contra el log real del 17/09):
- `gemma4:31b` (30,7B denso, 20 GB): con offload de ~10–11 de 60 capas a GPU y el resto en RAM, la investigación proyecta 1,5–2,5 tok/s de generación, limitado por el ancho de banda de DDR4 dual-channel del Ryzen 5 5600X — inviable para un agente interactivo. El Hub lo marca **"no recomendado en este equipo"**, con un botón para eliminarlo (libera ~19,9 GB `[COMPROBADO EN EQUIPO, tamaño en blobs]`).
- `gemma4:26b` (25,2B MoE, 3,8B activos, 19 GB): el fit de llama.cpp manda los experts a CPU y deja atención/router en GPU; la investigación proyecta 8–20 tok/s de generación por analogía con una medición de terceros en hardware distinto `[HIPÓTESIS A PROBAR, fuente secundaria: ik_llama.cpp#1765, escalado a Zen3+DDR4]`. El Hub lo marca **"calidad, lento: pendiente de confirmar con el Banco de pruebas"**, sin bloquear su uso.
- El Hub sugiere activamente instalar `qwen3:8b` (5,2 GB) o `qwen2.5-coder:7b` (4,7 GB) como modelos que sí entran completos en los ~6,5 GiB disponibles de la GPU a 8–16K de contexto `[HIPÓTESIS A PROBAR: tamaños son measured del manifest, el ajuste de contexto es estimado]`, porque son el prerrequisito documentado del MVP (spine §0: "sin un modelo con `tools` que entre 100 % en GPU el hito 1 no se puede validar").

**Cómo se confirma (spine §19).** Ninguna de estas proyecciones se muestra como medición: se confirman corriendo el Banco de pruebas (documento 19 de esta serie / spine §19) contra cada modelo instalado, que escribe `model_compat` con `hardware_fingerprint`, `offload_ratio`, `gen_tps` medido y `status`. Recién ahí la tarjeta pasa de "estimado" a "probado el DD/MM".

**MVP vs después.** Todo este motor es **v0.3**, junto con Benchmark (spine §10, §16). En el MVP no hay recomendaciones activas; el usuario ve el `fitClass` estimado de cada modelo instalado y decide solo.

---

## 9. Frontera local/nube

`ModelRef.locality` (spine §5, tipo `Locality`) clasifica cada modelo en `local | lan | proxied-cloud | cloud`. La regla de clasificación (spine §17, `[VERIFICADO EN DOC OFICIAL: api/types.go; docs.ollama.com/cloud]`): `proxied-cloud` si `/api/tags` trae `remote_host`/`remote_model` o el tag contiene `cloud` (p. ej. `gemma4:cloud`); `lan` si el host del provider no es loopback; `local` solo si es loopback y sin campos remotos. Ollama ya mezcla ambos mundos por diseño — un tag `:cloud` corre en `ollama.com` aunque el request vaya a `localhost:11434`, y la documentación oficial es explícita: "Data does leave your machine when using cloud models" `[VERIFICADO EN DOC OFICIAL: docs.ollama.com/cloud]`.

**Indicador visible** (condición 11.A): badge permanente de localidad — LOCAL / LAN / NUBE, con color distinto — en el selector de modelos del Centro de modelos, en la cabecera de cada chat y en cada mensaje (no solo al elegir el modelo: si a mitad de una sesión larga alguien cambia el modelo del chat a uno cloud, el badge de los mensajes nuevos cambia con él).

**Política del Model Gateway** (spine §1.2, fila "Camino de inferencia", y §17): los providers remotos están **deshabilitados por defecto**; habilitar uno requiere una acción explícita en Settings más una confirmación por proyecto; cada `Run` fija su `authorizedLocality` al iniciar y el Gateway rechaza cualquier request cuya localidad no esté en esa lista (spine §5, interfaz `ChatContext`); **nunca hay fallback automático de local a nube** si un modelo local falla — el run falla o sugiere, no reintenta solo con otro provider; `settings.localOnly = true` bloquea también `proxied-cloud`, y en modo managed eso se traduce en pasar `OLLAMA_NO_CLOUD=1` al proceso propio `[VERIFICADO EN DOC OFICIAL: envconfig, citado en spine §9]`. Toda llamada no local queda en `audit_log` (spine §4).

El Centro de modelos es, en la práctica, el único lugar de la UI donde el usuario puede habilitar un provider `lan`/`proxied-cloud` — nunca ocurre como efecto colateral de elegir un modelo en el selector de un chat.

**MVP vs después.** El badge de localidad y la restricción a `local` son MVP (spine §16, fila ModelGateway: "locality `local` únicamente"). Habilitar providers remotos es v0.4.

---

## 10. Pantallas de la UI

El Centro de modelos vive en `apps/desktop/src/renderer/src/features/models/` y consume el store `models` de zustand (spine §2, `STORE`). Tres vistas:

1. **Instalados** (MVP). Lista de modelos en `models` (proyección de `/api/tags` + `/api/show`), cada uno con: nombre y tag, tamaño en disco, capabilities como chips, estado (`loaded`/`unloaded` desde el último `/api/ps`, refrescado por el único poller de `ModelManager`), badge de localidad, `fitClass` estimado con el `num_ctx` por defecto del perfil activo, y — si existe — "probado" con fecha. Acciones: "Usar en este chat", "Ver detalle" (abre la ficha completa de §4), y desde v0.2 "Eliminar" (bloqueado si `loaded`/en cola, §5 punto 6). Un banner persistente arriba si `ModelManager.health()` falla ("Ollama no está corriendo") o si se detecta la configuración de la app de bandeja descripta en §6 (exposición en red, contexto 256K).
2. **Catálogo** (v0.2). Grilla de fichas del `model-catalog.json` + resultado de "pull manual", con la búsqueda de §3. Cada ficha no instalada trae el botón "Descargar" con el flujo de §5, deshabilitado si no hay espacio.
3. **Recomendaciones** (v0.3). Los tres selectores de entrada (uso, objetivo, y — de solo lectura — el hardware detectado con un enlace "ver detalle de hardware") arriba, y debajo las tarjetas ordenadas del motor de §8, cada una con el mismo layout de ficha que en Catálogo pero con la leyenda de compatibilidad como elemento principal en vez del tamaño.

La ficha de detalle de un modelo (abierta desde cualquiera de las tres vistas) es un panel lateral o modal con todos los campos de §4, el manifest completo si está disponible, y — si hay corridas de Benchmark — un enlace a la comparación en el Banco de pruebas.

---

## 11. Tablas y eventos

Sin tablas nuevas respecto de spine §4: este documento usa `models`, `downloads`, `model_load_samples`, `model_compat` (solo lectura), `token_calibration` no aplica aquí, y agrega el uso de `settings` con la clave `hardware_inventory_json` (namespace `hardware`, ya prevista en la tabla `settings(key, value_json, scope, project_id)` de spine §4 — no requiere columna nueva, solo una convención de `key`) y `settings.toolTransportOverrides` (ya nombrada en spine §9, no de este documento). El catálogo curado (`resources/model-catalog.json`) es un archivo de recursos empaquetado, no una tabla.

Eventos IPC main→renderer (ya declarados en spine §5, `packages/shared/src/ipc.ts`): `models:changed`, `download:progress`, `download:done`, `download:failed`, `provider:health`. Canales IPC renderer→main (ya declarados): `models:list`, `models:loaded`, `models:describe`, `models:fits`, `models:pull` (v0.2), `models:pullCancel` (v0.2), `models:delete` (v0.2), `provider:health`. Este documento no agrega canales nuevos a la tabla `ipc` de spine §5 — todo lo que necesita el Centro de modelos ya estaba previsto ahí; ver §12 para el único nombre nuevo que sí hace falta.

---

## 12. Imprescindible para el MVP

- Lista de modelos instalados con capabilities, tamaño, `fitClass` estimado (etiquetado), estado `loaded`/`unloaded` vía el poller único de `ModelManager`.
- Carpeta `OLLAMA_MODELS` detectada en modo attach (variable de usuario/máquina + validación contra manifests), mostrada como "carpeta detectada" con espacio libre.
- Badge de localidad (LOCAL) en selector, cabecera y mensajes; restricción del Gateway a `locality = local`.
- Avisos de exposición en red y contexto 256K de la app de bandeja, sin botones que cambien nada.
- Aviso si `health()` falla ("Ollama no está corriendo").
- `options.num_ctx` explícito en cada request y verificación contra `/api/ps context_length` (responsabilidad del Gateway/Runtime, pero es la mitigación directa del riesgo de este documento).
- Hardware Profiler MVP: CPU/RAM medidos siempre; VRAM NVIDIA por `nvidia-smi` bajo demanda al abrir el panel.

## Previsto para más adelante

- v0.2: catálogo curado + búsqueda + pull manual; `DownloadManager` completo (progreso, cancelación, verificación de espacio, reanudación best-effort); eliminación de modelos; modo managed para elegir carpeta con autorización explícita; Hardware Profiler con `systeminformation.cpu()`, contadores de Windows y AMD/Apple.
- v0.3: `RecommendationEngine`; integración con `model_compat`/Benchmark para el badge "probado"; pantalla de Recomendaciones.
- v0.4: providers remotos habilitables desde el Centro de modelos con confirmación por proyecto.

---

## Nomenclatura agregada

- `DownloadManager` — ya nombrado en spine §2.1 y §17 como componente futuro; este documento lo ubica en `packages/runtime/src/models/DownloadManager.ts` y detalla su contrato (§5), sin cambiar su nombre ni su tabla (`downloads`, ya en spine §4).
- `HardwareProbe` — ya nombrado en spine §2.1 y §17; este documento lo trata como submódulo de `runtime/models` reutilizado tanto por `ModelManager` (para `fits()`) como por el futuro `RecommendationEngine`, sin agregar una tabla nueva (usa `settings.hardware_inventory_json`, clave ya prevista en spine §17).
- `RecommendationEngine` — ya nombrado en spine §2.1, §9 y §17; este documento es su primera especificación funcional detallada (entradas, reglas, salida).
- `model-catalog.json` — ya nombrado en spine §3 (`resources/model-catalog.json`); este documento fija su esquema por entrada: `{ name, tag, sizeBytes, capabilities, contextMax, quantization, suggestedUse[], notes }`. Nombre de campo nuevo, sin tabla SQL asociada (vive en el archivo de recursos, no en SQLite).
- Estados de ficha de modelo en la UI: `not_installed | downloading | installed_untested | installed_tested | loaded` — son estados derivados para la vista (§4), no una columna SQL nueva; se calculan combinando `downloads.status`, presencia en `models` y presencia en el último `/api/ps`. No reemplazan ningún enum de spine §5.

## Desvíos respecto de la columna vertebral

1. **Qué:** spine §2.1 dice que `ModelManager` incluye `HardwareProbe` como parte de sus responsabilidades, pero spine §17 lo vuelve a listar como "(nuevo, `runtime/models`)" en la misma frase que `DownloadManager` y `RecommendationEngine`. **Por qué:** no es una contradicción de diseño sino de redacción entre secciones; este documento la resuelve tratando `HardwareProbe` como un submódulo compartido dentro de `runtime/models/` (mismo paquete que `ModelManager`, `DownloadManager` y `RecommendationEngine`), consumido por `ModelManager.MemoryEstimator` y expuesto también al Centro de modelos para mostrar el inventario crudo. No se creó ningún componente nuevo fuera de los ya nombrados en spine; solo se aclaró su ubicación para que este documento pudiera especificar su contrato sin ambigüedad.
2. **Qué:** la condición 11.A pide detallar "cómo se cambia la carpeta en cada modo [attach/managed]", pero spine §17 solo dice "cambiarla = guía paso a paso... sin tocar nada" para attach y no detalla el caso managed más allá de "SaurioLLM lanza `ollama serve`... con el `OLLAMA_MODELS` elegido por el usuario". **Por qué:** era necesario decidir explícitamente que managed sí permite fijar la carpeta al lanzar el proceso propio (porque SaurioLLM controla ese proceso) mientras que attach nunca la edita (porque no lo controla). Este documento explicita esa asimetría en §6; no cambia ninguna decisión de spine, solo la desarrolla al nivel de detalle que pide la condición 11.A.

## Adenda (sesión 2026-09-18): escala de seis niveles + iGPU/memoria unificada

Ver doc 16 §12 para el detalle completo (implementación, tests, hallazgos de hardware real). Resumen de los desvíos respecto de este documento:

- **§8 (motor de recomendaciones) se extiende, no se reemplaza**: `fitClass` (`fits_gpu | tight | partial_offload | no_fit`) sigue siendo el cálculo base de `MemoryEstimator`/`RecommendationEngine`; `TierClassifier` (`packages/runtime/src/models/TierClassifier.ts`) es una capa nueva encima que traduce esos mismos números a la escala de seis niveles que pidió el encargo posterior ("1 Perfecto ... 6 No recomendado instalar"), con badge de color y explicación en español simple para la UI. No hay dos fuentes de verdad: el cálculo de VRAM/RAM sigue siendo el mismo, solo cambia el corte en niveles.
- **§7 (Hardware Profiler) gana una fuente measured para GPUs sin `nvidia-smi`**: la línea `msg="inference compute"` del log de `ollama serve` (Intel/AMD/Apple, doc original ya preveía esto como "v0.2: AMD/Apple vía log de Ollama" en la tabla de fuentes). Memoria unificada (iGPU) se marca explícitamente con `HardwareProfile.gpu.integrated`.
- **§4/§8 (ficha, hallazgo de visión)**: modelos con capability `vision` necesitan más margen del que sugiere la suma de bytes del proyector — `MemoryEstimator` lo compensa con un overhead fijo adicional, `[HIPÓTESIS A PROBAR]` hasta que el Banco de pruebas mida el margen real en más de un modelo.

## Preguntas abiertas

Ninguna que cambie el diseño de este documento. Las preguntas abiertas de la columna vertebral (§20) que tocan al Centro de modelos — en particular la 1 (autorización para descargar `qwen3:8b`/`qwen2.5-coder:7b` antes del hito 1) y la 3 (smoke tests previos al scaffolding) — ya están planteadas ahí y no se repiten aquí; la 6 quedó resuelta por la condición 12 y no vuelve a aparecer como pregunta.
