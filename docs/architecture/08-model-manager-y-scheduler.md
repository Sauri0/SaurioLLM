# Documento 08 — Model Manager y Scheduler

**Propósito.** Especificar, para revisión previa al scaffolding, cómo SaurioLLM descubre, mide y administra modelos de Ollama (y en el futuro de otros providers), y cómo el `InferenceScheduler` reparte la capacidad de inferencia entre chats y agentes, sin duplicar responsabilidades con el Centro de modelos (doc 13), el Panel de rendimiento (doc 14) ni el Banco de pruebas y perfiles (doc 15).

**Leyenda:** `[COMPROBADO EN EQUIPO]` `[VERIFICADO EN DOC OFICIAL]` `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]`

---

## 1. Alcance y límites de responsabilidad

`ModelManager` (`packages/runtime/src/models/`) es la única capa que habla con `/api/tags`, `/api/show` y `/api/ps` de Ollama. Todo lo demás —Centro de modelos, Panel de rendimiento, Banco de pruebas— **consume** lo que el ModelManager y el Gateway exponen; ninguno vuelve a golpear la API de Ollama por su cuenta `[DECISIÓN DE DISEÑO]`. Esto es la corrección explícita de la propuesta "mvp-pragmatic" mencionada en la condición 13(c): evita que tres paneles distintos pollee `/api/ps` con frecuencias distintas y muestren números que no coinciden.

| Quién | Qué expone | Quién lo consume |
|---|---|---|
| `ModelManager` | Catálogo instalado, capabilities, `describeModel`, `models.loaded` (único poller de `/api/ps`), `MemoryEstimator.fits()`, `HardwareProbe`, `model_load_samples` | Centro de modelos (doc 13), Telemetry (doc 14), Benchmark (doc 15), UI (selector de modelo) |
| `ModelGateway` / `InferenceScheduler` | `status()` → slots y cola, métricas por respuesta (`ResponseMetrics`), TTFT de cliente | Telemetry (doc 14), Centro de modelos (estado "cargando…") |
| `Benchmark` (doc 15, v0.3) | Escribe `model_compat` y `benchmark_runs` | `ModelManager` los **lee** para mostrar "probado"; nunca los escribe |
| `HardwareProbe` (dentro de `ModelManager`) | Inventario de CPU/RAM/VRAM con `{ value, unit, quality, source, sampledAt }` | Centro de modelos, `RecommendationEngine` (doc 13, v0.3), diagnósticos de Telemetry |

Regla de una sola línea, repetida porque es la que más se rompe en diseños parecidos: **el ModelManager mide y cataloga; el Scheduler reparte; el Benchmark certifica; nadie estima lo que otro ya midió.**

---

## 2. Descubrimiento: qué endpoint da cada dato

Todo lo siguiente es `[VERIFICADO EN DOC OFICIAL: docs.ollama.com/api, api/types.go]` salvo que se indique lo contrario.

| Dato necesario | Endpoint | Campos relevantes | Notas |
|---|---|---|---|
| Salud del provider | `GET /api/version` | `version` | Usado también como `health()` en `Provider` (interfaz §5 de la columna vertebral) |
| Catálogo instalado | `GET /api/tags` | `models[].name`, `.size`, `.digest`, `.capabilities` (campo de primer nivel del modelo, `omitempty`; puede venir ausente según versión), `.details.{family,parameter_size,quantization_level,context_length,embedding_length}` — `details` **no** trae `capabilities`, `.model_info` no viene acá — hay que pedirlo aparte | Es la lista base para `ModelInfo[]`; `/api/show.capabilities` es la fuente autoritativa cuando `/api/tags` no trae el campo `[VERIFICADO EN DOC OFICIAL: api/types.go, `ListModelResponse.Capabilities` y `ModelDetails`]` |
| Capacidades y metadatos de arquitectura | `POST /api/show` (`{ name, verbose: false }`) | `capabilities` (`completion`, `tools`, `vision`, `embedding`, `thinking`, según el modelo), `model_info` con `general.architecture`, `<arch>.block_count`, `<arch>.attention.head_count`, `<arch>.attention.head_count_kv`, `<arch>.attention.key_length`, `<arch>.embedding_length`, `<arch>.context_length`, `<arch>.attention.sliding_window` (si aplica) | La familia de claves cambia el prefijo `<arch>` según `general.architecture` (p. ej. `gemma3.*`, `qwen3.*`); `ModelManager.describeModel` normaliza esto a `ModelDescription` |
| Tamaño en disco | `GET /api/tags` (`size`) o suma de `layers[].size` del manifest remoto si aún no está instalado (ver Centro de modelos, doc 13) | — | El tamaño de `/api/tags` incluye proyector/draft cuando el modelo los trae |
| Estado loaded/unloaded y memoria real | `GET /api/ps` | `models[].name`, `.digest`, `.size`, `.size_vram`, `.context_length`, `.expires_at` | Único endpoint con datos **medidos** de memoria; no expone `num_predict` ni tok/s — eso sale del chunk final de `/api/chat` |
| Carga/descarga explícita | `POST /api/chat` con `messages: []` (o `[]` y sin `prompt`) y `options.num_ctx`, `keep_alive` | `load_duration` en la respuesta | Ollama no tiene un endpoint `/api/load` dedicado; cargar "en vacío" es el patrón documentado `[VERIFICADO EN DOC OFICIAL: api.md, sección "Load a model"]` |
| Descarga forzada | mismo `/api/chat` con `keep_alive: 0` | — | Libera el slot de VRAM sin cerrar el proceso `ollama serve` |
| Descargar/eliminar modelo del disco (v0.2) | `POST /api/pull`, `DELETE /api/delete` | progreso por capa (`completed/total`) | Fuera del alcance de este documento salvo como consumidor de `MemoryEstimator`/`fits` antes de bajar algo que no entra; detalle completo en doc 13 |

**Lo que la API NO expone** `[VERIFICADO EN DOC OFICIAL: ausencia confirmada contra la lista de endpoints de api.md]`: la carpeta `OLLAMA_MODELS`, el `kv_cache_type` efectivo en modo attach, un endpoint de tokenización, y el desglose de VRAM por proceso ajeno. Estos puntos están resueltos en el doc 13 (carpeta de modelos) y en el doc 14 (VRAM del sistema vs VRAM del modelo); acá solo se documenta que el `ModelManager` no inventa esos datos: los marca `unavailable` o delega en `HardwareProbe`.

---

## 3. Capacidades del modelo: qué significa cada una para el runtime

`ModelCapabilities` (interfaz §5 de la columna vertebral) tiene cuatro campos booleanos que `describeModel` llena desde `/api/show.capabilities`:

- **`tools`.** Si es `true`, el `AgentConfig.toolTransport = 'auto'` resuelve a `NativeToolProtocol`. Si es `false`, resuelve a `TextToolProtocol` (Hermes `<tool_call>`) sin que el usuario tenga que elegir nada; se muestra un badge "tools por texto" en el selector y en la cabecera del chat (condición 13(a): en modo agent el agente ve, por defecto, las 10 tools builtin del registro — `list_files, search_code, read_file, read_output, edit_file, write_file, delete_file, run_command, task_update, finish` —, y el transporte no cambia cuántas tools ve, solo cómo se las describe).
- **`vision`.** Habilita adjuntar imágenes en el chat (`ContentPart` tipo `image`); sin esta capability la UI oculta el botón de adjuntar imagen para ese modelo. No hay tool builtin de visión en el MVP; es una capability del modelo, no del ToolSystem.
- **`thinking`.** Si es `true`, `AgentConfig.thinking: 'auto'` puede pedir `think: true` en modo `plan` y dejarlo en `false` en modo `agent` por defecto `[HIPÓTESIS A PROBAR, fuente secundaria: aider polyglot con Qwen3]`, midiendo con el harness de `eval/` si conviene invertir esa regla para el modelo elegido en el hito 1.
- **`embedding`.** No usado por el MVP (el repo map usa tree-sitter + PageRank, no embeddings — decisión ya cerrada en la columna vertebral §1.2). Se guarda igual en `models.capabilities_json` para no tener que volver a golpear `/api/show` cuando el diseño de v0.4 lo necesite.

**Contexto máximo.** `contextMax` en `ModelInfo` sale de `<arch>.context_length` de `/api/show`. Es el techo que el runtime nunca cruza: el ADR-7 de la columna vertebral obliga a capear `options.num_ctx` a este valor antes de mandar el primer `/api/chat` del run, y el evento `run.adjustment` deja registro de ese recorte en `run_adjustments`. Esto es **distinto** del contexto que el servidor de Ollama aplica por defecto cuando no se manda `num_ctx`: la condición 12 comprobó que la app de bandeja de este equipo corre con `OLLAMA_CONTEXT_LENGTH:262144` `[COMPROBADO EN EQUIPO: server.log del 18/09, sección "server config"]`, así que si SaurioLLM alguna vez omitiera `num_ctx` (nunca debería) heredaría 256K en vez del valor que el usuario espera. Por eso la regla ya cerrada en la columna vertebral (§6 paso 4) se repite acá como regla dura del Model Manager: **`ModelGateway.chat` nunca manda un `ChatRequest` sin `options.num_ctx` explícito**, y tras cada carga real `ModelManager` verifica `context_length` de `/api/ps` contra el `num_ctx` pedido; si difieren, Telemetry dispara el diagnóstico "el servidor asignó otro contexto" (doc 14, tabla de diagnósticos).

---

## 4. Tamaño en disco y estado loaded/unloaded

`models` (tabla SQLite, migración 1) guarda `provider_id, name, digest, size, details_json, capabilities_json, model_info_json, context_max, locality, refreshed_at`. Se refresca: (a) al abrir el Centro de modelos, (b) cada 30 s mientras el panel está abierto, (c) bajo demanda tras un `pull`/`delete` (v0.2). El estado loaded/unloaded **no vive en esta tabla** — vive en la lectura en vivo de `/api/ps`, cacheada en memoria por el `ModelManager` y emitida como evento `models:loaded` / `models:changed` a Telemetry y a la UI. Guardar "cargado" en `models` sería una proyección que se desincroniza sola (el `keep_alive` puede expirar sin que nadie avise); por eso la fuente de verdad de "¿está cargado ahora?" es siempre una lectura reciente de `/api/ps`, nunca una columna persistida `[DECISIÓN DE DISEÑO]`.

**Frecuencia del poller** (única instancia en todo el proceso, corrección de la condición 13(c) sobre no duplicar pollers): 5 s mientras hay un modelo cargado **y** (el panel de rendimiento está abierto **o** hay un run activo); 30 s en reposo. Este es el mismo poller que alimenta al Centro de modelos y a Telemetry — ninguno de los dos abre su propio intervalo.

---

## 5. Medición real de memoria vs estimación previa

Esta es la distinción más importante del documento y la que more se presta a confundir una hipótesis con un hecho, así que se etiqueta cada número por separado.

### 5.1 Medición real (`measured`)

Tras cada carga real del modelo (el primer `/api/chat` de un run, o un `ensureLoaded` de precalentamiento), `ModelManager` lee `/api/ps` y guarda una fila en `model_load_samples`:

```sql
model_load_samples(id, provider_id, model_name, model_digest,
  num_ctx, size, size_vram, context_length, load_ms,
  estimated_vram NULL, sampled_at)
```

`size` y `size_vram` son los campos que Ollama devuelve **medidos** de verdad: si `size_vram == size`, el modelo entró 100 % en GPU; si `size_vram < size`, la diferencia está en RAM/CPU (offload parcial). `load_ms` sale de `load_duration` del chunk final de `/api/chat` (o de la llamada de precalentamiento). Esto es lo único que el usuario puede ver etiquetado `[COMPROBADO/medido]` en la UI sin condiciones.

El `eval_count / eval_duration` de cada respuesta (tok/s de generación) y `prompt_eval_count / prompt_eval_duration` (tok/s de prompt) también son `measured` por respuesta y viven en `messages.response_metrics_json` / `runs.metrics_json` — el detalle completo de esa cadena de métricas es del doc 14; acá solo se aclara que el ModelManager no las calcula ni las guarda: las produce el `ModelGateway` en cada `chat()`.

### 5.2 Estimación previa (`estimated`) — fórmula y parámetros

Antes de cargar el modelo (por ejemplo, para decidir si conviene ofrecerlo en el selector, o para el diagnóstico "¿entra?" del Centro de modelos), `MemoryEstimator.fits(ref, numCtx)` calcula una proyección con los parámetros de `/api/show.model_info` `[HIPÓTESIS A PROBAR: la fórmula en sí; los parámetros de entrada sí están verificados en doc oficial]`:

```
head_dim               = key_length ?? (embedding_length / head_count)
bytesPerElem           = { f16: 2, q8_0: 1.0625, q4_0: 0.5625 }[kv_cache_type]
kvBytesPerLayerPerToken = 2 × head_count_kv × head_dim × bytesPerElem   -- por capa, SIN block_count
kv(numCtx)             = kvBytesPerLayerPerToken × block_count × numCtx × numParallel   -- numParallel = 1 en el MVP

-- si el modelo declara attention.sliding_window (arquitecturas híbridas tipo Gemma):
kvSwa(numCtx)          = kvBytesPerLayerPerToken × (capas_globales × numCtx
                       + capas_SWA × min(numCtx, sliding_window + ubatch))
                -- se calculan kv() y kvSwa() y se usa la que corresponda a la arquitectura del modelo
                -- (corrección: la versión anterior multiplicaba por block_count dentro de kvBytesPerToken
                -- Y volvía a sumar por capas en kvSwa, sobreestimando el KV cache ~40-60x en modelos
                -- con sliding_window como Gemma, lo que daba `no_fit` siempre; ver hallazgo de factibilidad)

vramNeeded      = weights(size de /api/tags, incluye projector/draft si los trae)
                + kv(numCtx) | kvSwa(numCtx)
                + overhead              -- overhead inicial 1 GiB; se recalibra por modelo con model_load_samples
                                         -- (overhead = size_vram_medido − weights − kv_teórico, promediado con EMA)

vramAvailable   = vramFree(HardwareProbe) − 512 MiB   -- margen de seguridad fijo
fitClass        = 'fits_gpu'         si vramNeeded ≤ vramAvailable
                | 'tight'            si vramNeeded ≤ vramAvailable × 1.05
                | 'partial_offload'  si vramNeeded > vramAvailable pero weights ≤ vramAvailable
                | 'no_fit'           si weights > vramAvailable
```

El `kv_cache_type` efectivo **no es consultable por API en modo attach**; se asume `f16` salvo que el usuario haya configurado `OLLAMA_KV_CACHE_TYPE` y lo haya declarado en Settings (en modo managed, v0.3, SaurioLLM sí lo controla). Esto es una fuente adicional de error en la estimación que se documenta en la propia tarjeta de la UI ("estimado con KV f16; si tu Ollama usa q8_0 el número real es menor").

**Procedimiento de validación de la fórmula** (para que deje de ser `[HIPÓTESIS A PROBAR]` y se convierta en calibración medida, ejecutado por el Banco de pruebas del doc 15, no por el Model Manager):
1. Elegir un modelo con `tools` que se sepa que entra 100 % en GPU (prerrequisito del hito 1, condición de la columna vertebral §0).
2. Cargar con 3–4 valores de `num_ctx` distintos (por ejemplo 4k, 8k, 16k, 32k) y leer `size_vram` real de `/api/ps` en cada caso.
3. Graficar `size_vram_medido − weights` contra `kv(numCtx)_teórico`: la pendiente valida (o no) la fórmula de `kvBytesPerToken`; el intercepto calibra `overhead`.
4. Repetir con `gemma4:26b` para ver si el modelo MoE se comporta distinto (los MoE activan menos parámetros por token, pero el KV cache depende de `block_count`/`head_count_kv` igual que un modelo denso — la hipótesis a probar es si el `weights` efectivo en VRAM difiere del `size` total porque algunos experts pueden quedar en RAM).
5. Guardar el resultado en `model_load_samples.estimated_vram` (lo que la fórmula predijo) junto al `size_vram` real, para que el EMA de calibración del overhead tenga con qué ajustarse en cargas futuras.

### 5.3 Tabla de modelos candidatos para agentes de código

| Modelo | Tamaño (disco) | `tools` | Contexto máx. declarado | VRAM estimada a 16k (fórmula §5.2) | VRAM medida (pendiente) | Notas |
|---|---|---|---|---|---|---|
| `qwen2.5-coder:7b` | ~4,7 GB `[VERIFICADO EN DOC OFICIAL: ollama.com/library/qwen2.5-coder/tags]` | sí | 32k (declarado) | ~6–6,5 GB `[HIPÓTESIS A PROBAR]` | pendiente | Candidato principal para el prerrequisito del hito 1: cabe con margen en 8 GiB `[COMPROBADO EN EQUIPO: VRAM total de la RTX 3060 Ti]` |
| `qwen3:8b` | ~5,2 GB `[VERIFICADO EN DOC OFICIAL: ollama.com/library/qwen3/tags]` | sí | 32–40k (declarado, varía por variante) | ~7 GB `[HIPÓTESIS A PROBAR]` | pendiente | Segundo candidato para el prerrequisito del hito 1; requiere confirmar `tools` en la variante instalada con `/api/show` antes de asumirlo |
| `qwen3:4b` | ~2,5 GB `[VERIFICADO EN DOC OFICIAL: ollama.com/library/qwen3/tags]` | sí | igual que 8b | ~4 GB `[HIPÓTESIS A PROBAR]` | pendiente | Perfil "rápido" propuesto en el doc 15; más margen de VRAM para `num_ctx` alto |
| `gemma4:26b` | 19 GB `[VERIFICADO EN DOC OFICIAL: ollama.com/library/gemma4/tags]` (instalado `[COMPROBADO EN EQUIPO]`) | por confirmar con `/api/show` en este equipo | por confirmar | `no_fit` en pesos puros contra 8 GiB `[HIPÓTESIS A PROBAR]` | pendiente | MoE: la investigación de hardware proyecta que podría ser usable con experts en RAM (8–20 tok/s) `[HIPÓTESIS A PROBAR, fuente secundaria]`; primera prueba del Banco, no criterio del hito 1 |
| `gemma4:31b` | 20 GB `[VERIFICADO EN DOC OFICIAL: ollama.com/library/gemma4/tags]` (instalado `[COMPROBADO EN EQUIPO]`) | por confirmar | por confirmar | `no_fit`: denso, queda casi entero en CPU `[HIPÓTESIS A PROBAR, fuente secundaria]`, 1,5–2,5 tok/s proyectado | pendiente | El intento de carga del 17/09 confirma el riesgo: `context size set by user to 262144` con `llama_kv_cache size = 20480 MiB` y `cudaMalloc failed: out of memory` tras 1m14s y HTTP 500 `[COMPROBADO EN EQUIPO: server-1.log]` — evidencia real de que un `num_ctx` alto sin capear rompe la carga incluso antes de contar los pesos |

El caso del 17/09 es la razón concreta por la que el ADR-7 (capear `num_ctx` a `contextMax`) y la verificación de `context_length` en `/api/ps` no son paranoia de diseño: son la reproducción exacta de un fallo ya observado en este equipo.

### 5.4 Recomendaciones que muestra la UI: heurísticas ajustables, no verdades

El Centro de modelos (doc 13) muestra frases como "entra en GPU", "requiere offload" o "no recomendado junto a X". Estas frases son la salida de la heurística de §5.2 con umbrales configurables (`settings.modelManager.fitThresholds`), **nunca** un hecho salvo que exista una fila `model_compat` con `status = 'fits'` para el `hardware_fingerprint` actual (única forma de mostrar "probado", y solo el Benchmark del doc 15 escribe esa tabla). El `ModelManager` no decide "no recomendado": calcula `fitClass` y dice, con las palabras que corresponden a cada clase, qué significa; la palabra "recomendado" o "no recomendado" es una capa de presentación en el Centro de modelos, ajustable sin tocar el runtime.

---

## 6. Perfiles de hardware

Los perfiles de hardware no son un tipo de dato nuevo en SQLite (no hay tabla `hardware_profiles`): son **rangos de VRAM/RAM que la UI usa para agrupar recomendaciones y para fijar el default de `slots`** `[DECISIÓN DE DISEÑO]`. Se derivan en caliente de `HardwareProbe`, no se persisten como perfil elegido salvo en `settings.hardware_inventory_json` (el último inventario leído, para no tener que re-sondear en cada arranque).

| Perfil | Umbral (VRAM dedicada) | `slots` por defecto | Qué cambia en la UI |
|---|---|---|---|
| CPU-only | sin GPU dedicada detectada, o `nvidia-smi`/equivalente ausente | 1 | Todas las recomendaciones son "lento, esperar tok/s bajo"; se sugieren modelos ≤ 4B |
| 8 GB | 6–10 GiB `[COMPROBADO EN EQUIPO: este equipo, 8192 MiB]` | 1 | Rango del prerrequisito del hito 1; `gemma4:26b/31b` marcados `no_fit`/`partial_offload` hasta medir |
| 12–16 GB | 10–18 GiB | 1 (el usuario puede subir a 2 si dos modelos chicos entran juntos, v0.4) | Modelos 13-14B empiezan a entrar completos |
| 24 GB+ | ≥ 20 GiB | `auto` = 1 por modelo que `fits` simultáneamente (§9 de la columna vertebral) | Habilita cargar más de un modelo a la vez sin descargar el anterior |
| Multi-GPU | ≥ 2 dispositivos con VRAM propia | una instancia managed por GPU, v0.4 | Fuera del MVP; el `Provider` de cada instancia se registra por separado |
| Cloud | N/A (no aplica VRAM local) | `providers.max_concurrency` del provider | Badge NUBE obligatorio (doc 13, frontera local/nube); nunca automático |

**Detección.** `HardwareProbe.cpu()` (`os.cpus()`, `measured`), `.ram()` (`os.totalmem/freemem`, `measured`), `.vram()` (`nvidia-smi --query-gpu=... --format=csv,noheader,nounits`, `measured` en NVIDIA `[VERIFICADO EN DOC OFICIAL: docs.nvidia.com/deploy/nvidia-smi]`; en este equipo 8192 MiB totales, 867–915 MiB usados en reposo con 29–32 % de utilización `[COMPROBADO EN EQUIPO: dos lecturas de nvidia-smi del relevamiento]`). El detalle de fuentes confiables vs no confiables por plataforma (WMI truncado a 4 GB, registro `qwMemorySize` sí confiable, contadores de Windows sin NVIDIA, ROCm en Linux, `inference compute` de Ollama como línea vendor-agnóstica) es responsabilidad de presentación del Centro de modelos y está desarrollado ahí (doc 13, tabla de fuentes); acá se usa tal cual la produce `HardwareProbe`, sin que el Model Manager reimplemente esa tabla.

**Configuración manual.** El usuario puede forzar `settings.inference.slots` a un número explícito por provider en vez de `auto`; eso no cambia de qué perfil de hardware la UI cree que se trata (es cosmético/informativo), solo cambia el comportamiento real del Scheduler (§7).

---

## 7. Scheduler: slots de inferencia

El `InferenceScheduler` vive **dentro** de `ModelGateway` (ADR-5 de la columna vertebral) — no es un componente que el `AgentRuntime` vea directamente. Esto importa para este documento porque significa que todo lo que sigue es interno al Gateway y no aparece en el flujo de eventos del run salvo como `run.state: queued` con `reason: 'queue:<n>'`.

### 7.1 Slots

`settings.inference.slots` por provider: `'auto' | number`. `auto` resuelve a 1 para providers `local` con VRAM detectada < 24 GiB (el caso de este equipo: 1 slot fijo `[COMPROBADO EN EQUIPO: 8192 MiB]`) y a `providers.max_concurrency` para providers `lan`/`cloud`. Un slot = una generación de `/api/chat` en curso. El slot se adquiere **dentro** de `ModelGateway.chat()` al empezar una generación y se libera en `done`/`error`/abort — nunca lo retiene el `AgentRuntime` por fuera de esa llamada (esto es lo que evita que un run parado en `awaiting_permission` bloquee a otro run que sí puede generar).

### 7.2 Cola de solicitudes por modelo, con prioridad

`ModelQueue` es una cola por `(providerId, modelName)`, no una cola global: dos runs que piden el mismo modelo cargado hacen fila entre sí; un run que pide un modelo distinto no espera a los anteriores salvo que el Scheduler decida que hay que descargar uno para que el otro cargue (ver §7.3). Prioridad, de mayor a menor: `interactivo > subagente > benchmark > precalentamiento`. En el MVP, sin subagentes (v0.4) ni Benchmark (v0.3), la única prioridad activa es `interactivo`; el enum existe desde el día 1 (Principio 8 de la columna vertebral: las columnas/variantes que cuestan una línea hoy se dejan puestas) para no tener que tocar el tipo `ChatContext['priority']` cuando lleguen los subagentes.

### 7.3 Agrupamiento por modelo para minimizar cargas/descargas

Mientras haya trabajo encolado para el modelo que ya está cargado, el Scheduler **no cambia de modelo**, aunque haya otro run esperando con un modelo distinto y mayor antigüedad en la cola global — se prioriza terminar el lote del modelo cargado antes de pagar el costo de una cold load `[HIPÓTESIS A PROBAR: 3–10 s de carga fría según tamaño, fuente secundaria]` y la pérdida del prompt cache asociado (`cacheHitRatio` cae a 0 tras un `unload`). Cuando la cola del modelo cargado se vacía y hay trabajo esperando para otro modelo:

1. Se decide si hace falta liberar espacio sumando el `vramNeededBytes` de cada `fits(ref, numCtx, hardware)` individual (modelo cargado + modelo nuevo) contra `vramAvailableBytes` de `HardwareProbe` — con la interfaz de `MemoryEstimator` tal como está definida hoy (doc 04 §11: un solo `ModelRef` por llamada), sin una variante multi-modelo nueva.
2. Si la suma no entra, se descarga el modelo actual con `keep_alive: 0` (equivalente a `unload`).
3. Se carga el nuevo con el `num_ctx` que su primer run en cola pidió y `keep_alive: '30m'` (política de §7.4).
4. `load_ms` se registra en `model_load_samples` y en `runs.metrics_json` del run que disparó la carga.

Con 1 slot (el caso de este equipo) esto es simplemente "solo puede haber un modelo cargado a la vez, y se prefiere no rotarlo mientras tenga trabajo pendiente". Con N slots (v0.4, hardware con más VRAM) varios modelos pueden convivir cargados simultáneamente si `fits` lo permite, y el agrupamiento por modelo dentro de cada slot sigue aplicando igual, solo que ya no hace falta descargar tan seguido.

### 7.4 Política `keep_alive`

`keep_alive: '30m'` por defecto tras cada carga explícita del Scheduler; el usuario puede ajustarlo en Settings por perfil (v0.2, doc 15). `keep_alive: 0` es la forma explícita de "descargar ahora" que usa el Scheduler antes de instalar/eliminar un modelo (para no dejar un handle de VRAM sobre un modelo que se está borrando del disco) y antes de un `unload` forzado por presión de memoria. La app de bandeja de Ollama de este equipo, quieta y sin intervención de SaurioLLM, usa su propio `OLLAMA_KEEP_ALIVE:5m0s` `[COMPROBADO EN EQUIPO: server.log]` — un valor **distinto** al que el Scheduler pediría; esto es evidencia de que en modo attach dos configuraciones de keep-alive pueden convivir sin conflicto porque cada `/api/chat` que llega con su propio `keep_alive` en el body lo sobreescribe para esa sesión, pero es una razón más para que el diagnóstico de Telemetry (doc 14) avise si el modelo se descargó solo entre dos turnos por vencimiento de keep-alive ajeno al que Saurio pidió.

### 7.5 Preempción y cancelación

El MVP no preempta una generación en curso para darle el turno a una de mayor prioridad (no hay subagentes ni benchmark todavía compitiendo con el uso interactivo). Lo que sí existe desde el MVP es la cancelación: `run:cancel` corta el `AbortSignal` que el Gateway pasó al `Provider.chat()`; el slot se libera inmediatamente en el `catch`/`finally` del Gateway, no espera a que Ollama confirme el corte del lado servidor `[HIPÓTESIS A PROBAR: si Ollama cancela la generación en curso al cerrarse la conexión HTTP en 0.34.1, o si sigue generando en el servidor con el cliente ya desconectado; se valida en los smoke tests de riesgo previos al scaffolding]`. Si la cancelación de servidor no ocurre de verdad, el slot lógico de SaurioLLM queda libre para el siguiente run igual, aunque el llama-server de Ollama siga ocupado un rato más internamente — este es un caso donde "slot libre en el Scheduler de Saurio" y "GPU libre de verdad" pueden no coincidir por un instante, y es información que Telemetry debería poder mostrar si el próximo `/api/chat` tarda más de lo esperado en el primer token.

### 7.6 1 slot vs N slots: qué cambia y qué no

Ya cerrado en la columna vertebral (§14) y repetido acá porque es la pregunta que más se hace sobre un Scheduler: **con 1 o con N slots la máquina de estados del run, los eventos, el modelo de datos, los permisos y la UI no cambian nada.** Lo único que cambia es cuánto tiempo un run pasa en `queued` y si dos runs generan al mismo tiempo. En este equipo, con 1 slot fijo por la VRAM disponible, todo el trabajo interactivo se serializa; el usuario puede tener 5 chats abiertos (organización lógica, siempre ilimitada) pero solo uno de ellos estará realmente generando texto en un momento dado, y los demás muestran "en cola (posición N)".

### 7.7 Mismo modelo con distintos roles en el MVP

La columna vertebral ya decide (§9) que el multi-agente secuencial de v0.4 usa el **mismo modelo** para todos los roles (Lead/Coder/Reviewer) y solo distinto system prompt, porque un segundo modelo se justifica recién para visión a demanda o un Reviewer más fuerte corrido en batch al final. Para el Scheduler esto es una simplificación real: en el MVP, sin subagentes, nunca hay dos `AgentConfig` con modelos distintos compitiendo por el mismo slot dentro de un mismo chat — la cola por `(providerId, modelName)` en la práctica tiene, la mayor parte del tiempo en este equipo, un solo miembro activo.

---

## 8. Providers no-Ollama (OpenAI-compatible)

`OpenAICompatProvider` (v0.2, para LM Studio o `llama-server` con API `/v1`) implementa la misma interfaz `Provider` que `OllamaProvider`, pero con degradación explícita en varios puntos:

| Dato que Ollama da | Qué pasa en `/v1` OpenAI-compatible | Degradación aplicada |
|---|---|---|
| `capabilities` (`tools`, `vision`, `thinking`, `embedding`) por `/api/show` | No hay endpoint equivalente estandarizado; algunos servidores no lo exponen en absoluto | `capabilities.tools` se asume `true` si el modelo acepta el campo `tools` sin error 400 en el primer request, y se cachea el resultado; si falla, se reintenta una vez con `TextToolProtocol` antes de marcar `tools: false` para ese modelo |
| `size_vram` / `size` medidos por `/api/ps` | No existe `/api/ps` en la API OpenAI-compatible | Estado loaded/unloaded y VRAM por modelo quedan `unavailable`; el badge del Centro de modelos para estos providers dice "sin medición de memoria disponible" en vez de un número |
| `prompt_eval_count`, `eval_count`, `*_duration` medidos por chunk | Los servidores OpenAI-compatible devuelven `usage` (tokens) al final del stream, sin duraciones separadas de carga/prompt/generación | `ResponseMetrics.quality = 'estimated'` para estos providers; el tok/s se calcula con el reloj de cliente (tiempo total ÷ tokens de `usage`), lo cual mezcla TTFT y generación — se etiqueta así en la UI, nunca como `measured` |
| `context_length` real aplicado | No siempre expuesto | `ModelManager.describeModel` usa el valor declarado en la config del servidor si el usuario lo especifica en Settings al agregar el provider; si no, `contextMax` queda `unavailable` y el cap de `num_ctx` no puede aplicarse automáticamente — se avisa al usuario que ese provider no garantiza el techo de contexto |
| Descarga/carga explícita (`keep_alive`) | No hay concepto estándar de `keep_alive` en `/v1` | El Scheduler trata estos providers como "siempre cargados" (no intenta `unload`); el agrupamiento por modelo pierde sentido si el servidor externo ya decide su propia política de memoria |

En todos los casos, el principio es el mismo que en el resto del documento: lo que no se puede medir se marca `unavailable` o `estimated`, nunca se simula un número "parecido" y se presenta como medido. Los fallos de este provider (desconexión, timeout, respuesta mal formada) siguen el mismo tratamiento de estados que cualquier otro `Provider` — ver doc 10 (fallos y recuperación) para la tabla completa; este documento no la repite.

---

## 9. MVP vs previsto

**Imprescindible para el MVP.**
- `ModelManager`: catálogo instalado vía `/api/tags` + `/api/show`, capabilities, `describeModel`, único poller de `/api/ps` (5 s/30 s), `MemoryEstimator.fits()` con etiquetado `estimated`/`measured`, `model_load_samples` tras cada carga real, `HardwareProbe` con CPU/RAM medidos y VRAM NVIDIA medida bajo demanda.
- Cap automático de `num_ctx` a `contextMax` (único ajuste automático permitido, ADR-7), con verificación posterior de `context_length` en `/api/ps`.
- `InferenceScheduler`: 1 slot (fijo en este equipo por VRAM < 24 GiB), cola por `(providerId, modelName)` con las cuatro prioridades declaradas en el enum aunque solo `interactivo` esté activa, agrupamiento por modelo, `load`/`unload` explícito con `keep_alive: '30m'`, estado `queued` visible en la UI.
- Tabla de modelos candidatos (§5.3) con columna "estimado" completa y columna "medido" pendiente, para que el usuario decida con qué modelo hace el prerrequisito del hito 1.
- Perfiles de hardware como agrupación informativa (§6), sin tabla nueva en SQLite.
- `OllamaProvider` únicamente (`/api/version, tags, show, ps, chat`); `OpenAICompatProvider` fuera del MVP.

**Previsto para más adelante.**
- v0.2: `DownloadManager` (pull/delete con progreso y verificación de espacio), catálogo curado (`resources/model-catalog.json`), `OpenAICompatProvider` completo, detección de VRAM en AMD (ROCm)/Apple Silicon/registro de Windows para VRAM de terceros vendors.
- v0.3: `RecommendationEngine` (heurísticas sobre inventario × catálogo × `model_compat`), `Benchmark` como único escritor de `model_compat`/`benchmark_runs` (calibra por fin la fórmula de §5.2 con datos medidos), modo managed (`OllamaProcessManager` con instancia propia en `127.0.0.1:11435`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=1`).
- v0.4: N slots reales para hardware con VRAM ≥ 24 GiB, una instancia managed por GPU en setups multi-GPU, providers cloud con `authorizedLocality` habilitado explícitamente por proyecto.

---

## Nomenclatura agregada

Ninguna. Todos los nombres de componentes, tablas, columnas, interfaces y eventos usados en este documento (`ModelManager`, `HardwareProbe`, `MemoryEstimator`, `InferenceScheduler`, `ModelQueue`, `model_load_samples`, `model_compat`, `models`, `ModelInfo`, `ModelDescription`, `LoadedModel`, `ModelCapabilities`, `fitClass`, `keep_alive`, `run_adjustments`, `models:loaded`, `models:changed`) ya existen en la columna vertebral (secciones 2, 4, 5 y 9) y se reutilizan sin variantes.

## Desvíos respecto de la columna vertebral

Ninguno. Este documento desarrolla la sección 9 de la columna vertebral sin contradecirla; donde agrega detalle (la fórmula de `MemoryEstimator` con sus parámetros exactos, la tabla de modelos candidatos, el procedimiento de validación, la degradación de providers OpenAI-compatible) es una expansión, no un cambio de decisión. Se aplicaron las correcciones ya conocidas de las condiciones 12 y 13: los datos del relevamiento (VRAM en reposo, `qwMemorySize`, `context_length` de la app de bandeja, el caso de OOM del 17/09) se citan como `[COMPROBADO EN EQUIPO]`, y la lista de 10 tools builtin (no 8) se usa consistentemente en la sección 3.

## Preguntas abiertas

Ninguna que cambie el diseño de este documento. Las preguntas abiertas de la columna vertebral (§20) sobre qué modelo descargar para el prerrequisito del hito 1 y sobre confirmar el modo attach de Ollama condicionan directamente la tabla de §5.3 y la política de `keep_alive` de §7.4, pero ya están planteadas ahí y no se duplican acá.
