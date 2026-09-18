# Documento 14 — Panel de rendimiento y consumo

Propósito: definir qué mide SaurioLLM, de dónde sale cada dato, cómo se agrega y se guarda, y qué le dice al usuario cuando algo anda mal, sin que el módulo de telemetría duplique responsabilidades del Model Manager o del Scheduler.

Leyenda: [COMPROBADO EN EQUIPO] [VERIFICADO EN DOC OFICIAL] [DECISIÓN DE DISEÑO] [HIPÓTESIS A PROBAR]

---

## 1. Objetivo

El Panel de rendimiento le contesta al usuario tres preguntas mientras trabaja con el agente: *¿cuánto contexto y cuántos tokens estoy gastando?*, *¿mi máquina tiene margen o está al límite?* y *si algo salió lento o falló, por qué fue?* [DECISIÓN DE DISEÑO]. No es un monitor de sistema genérico: solo expone lo que el runtime necesita para diagnosticar sus propios problemas (carga de modelo, contexto, cola de inferencia, memoria) y lo que le sirve al usuario para decidir (bajar `num_ctx`, cambiar de modelo, cerrar otra app que usa GPU).

Todo dato que el panel muestra viaja etiquetado con su calidad: `measured` (viene de una fuente que efectivamente midió algo), `estimated` (se calculó con una fórmula o se infirió) o `unavailable` (no hay fuente en esta plataforma/provider). Ninguna estimación se presenta como medición (condición 3). El panel nunca decide nada por sí mismo: cuando detecta un problema, muestra un diagnóstico con una acción sugerida, y el usuario o el flujo de permisos existente confirma el cambio.

## 2. Frontera de responsabilidades (quién expone qué)

Retomando la corrección de la sección 18 de la columna vertebral (que ya fija esta frontera como parte del injerto de mvp-pragmatic), **Telemetry no consulta Ollama por su cuenta ni estima VRAM por sí sola**. El módulo de telemetría es un agregador y un diagnosticador, no un poller adicional:

| Responsable | Qué expone a Telemetry | Qué NO hace |
|---|---|---|
| `ModelManager` | `/api/ps` (modelos cargados, `size`, `size_vram`, `context_length`, `expires_at`); evento `models.loaded` | No calcula agregados por chat/proyecto, eso es de Telemetry |
| `ModelGateway` (+ `InferenceScheduler`) | `status()`: slots en uso, cola (`QueuedJob[]`), motivo de espera; métricas de cada respuesta (`ResponseMetrics`) al cerrar el chunk `done` | No persiste series de tiempo, eso es de Telemetry |
| `SystemSampler` (nuevo, vive en `apps/desktop/src/main/services/system-sampler/`, **no** en `packages/runtime`) | Muestras de CPU/RAM del sistema (`os.*`), CPU/RAM/handles del proceso Electron (`app.getAppMetrics()`), GPU/VRAM/temperatura/potencia (`nvidia-smi` u otra fuente por plataforma) | No decide diagnósticos, solo entrega números con su `quality`; no vive en `packages/runtime` porque ese paquete es Node puro (sin `electron`) y `app.getAppMetrics()` es una API de Electron [DECISIÓN DE DISEÑO, alineado con spine §1.2/§3 y doc 01 §4.17/doc 02] |
| `Telemetry` (nuevo, `packages/runtime/src/telemetry/`: `MetricsAggregator`, `Diagnostics`, `ringBuffer.ts`; orquesta lo anterior) | Agrega, persiste (`metrics_minute`, `runs.metrics_json`, `messages.response_metrics_json`), calcula diagnósticos, sirve `metrics:snapshot` / `metrics:tick` a la UI | No pide `/api/ps` directamente, no hace `nvidia-smi` directamente, no toca configuración de Ollama ni del Scheduler; recibe las muestras del `SystemSampler` ya tomadas, por inyección (`HostAdapter`), nunca importa `electron` |

Esta separación evita que dos componentes pregunten lo mismo por vías distintas (por ejemplo, Telemetry y ModelManager ambos pegándole a `/api/ps`) y mantiene a `ModelManager` como el único poller de `/api/ps` (ya establecido en la sección 9 de la columna vertebral).

## 3. Fuentes de métricas

### 3.1 Respuesta del provider (por cada turno)

Cada `POST /api/chat` con `stream: true` termina con un chunk final que trae los contadores de Ollama [VERIFICADO EN DOC OFICIAL: api.md, investigación research-hardware-metrics.md §sobre `/api/chat`, ejemplo de respuesta real]:

```json
{"total_duration":4883583458,"load_duration":1334875,
 "prompt_eval_count":26,"prompt_eval_duration":342546000,
 "eval_count":282,"eval_duration":4535599000,"done_reason":"stop"}
```

Todas las duraciones vienen en **nanosegundos**. Fórmulas [VERIFICADO EN DOC OFICIAL: api.md da la fórmula de generación; las demás se derivan del mismo esquema de campos]:

- `gen_tps = eval_count / eval_duration × 1e9`
- `prompt_tps = prompt_eval_count / prompt_eval_duration × 1e9`
- `ttft_server ≈ (load_duration + prompt_eval_duration) / 1e6` ms (aproximación del lado servidor)
- `overhead = total_duration − load_duration − prompt_eval_duration − eval_duration`
- `cacheHitRatio = prompt_eval_cached_count / prompt_eval_count` (campo `prompt_eval_cached_count` disponible desde Ollama 0.33.3 [HIPÓTESIS A PROBAR, fuente secundaria]; si no viene en la respuesta, la métrica es `unavailable`, no cero)

Interpretación importante para no malinterpretar los números en el panel: Ollama reutiliza el prefijo de prompt cacheado, así que `prompt_eval_count` puede ser mucho menor que el total de tokens del prompt real en turnos sucesivos del mismo chat [VERIFICADO EN DOC OFICIAL: api.md, nota sobre prompt caching]. Esto es *bueno* para el agente (menos recómputo) pero significa que "tokens de entrada" mostrados turno a turno no son el tamaño real del contexto — para eso está la fila "contexto utilizado" (§3.3).

`ResponseMetrics.quality = 'measured'` para todo esto en `OllamaProvider`. Para `OpenAICompatProvider` (v0.2), el endpoint `/v1/chat/completions` solo trae `usage.prompt_tokens/completion_tokens/total_tokens` (con `stream_options: {include_usage: true}` en streaming) y **no hay duraciones** [VERIFICADO EN DOC OFICIAL: investigación research-hardware-metrics.md §sobre `/v1`]. Ese provider no puede entregar `load_duration`, `prompt_eval_duration` ni `eval_duration`; tok/s y TTFT ahí se calculan solo con el reloj de cliente y quedan marcados `quality: 'estimated'`. `llama-server` nativo (`/completion`) sí trae `timings` propios, pero si los expone también en `/v1` no está verificado [HIPÓTESIS A PROBAR].

### 3.2 TTFT (tiempo al primer token)

No se confía en `ttft_server` como número principal porque no incluye cola de red ni tiempo de cola del Scheduler. El TTFT que se muestra es de reloj de cliente, medido en el `ModelGateway`: marca de tiempo del primer chunk con `content` no vacío menos marca de tiempo de envío de la request. `quality: 'measured'` (incluye cola de espera de slot, que es información útil, no ruido).

### 3.3 `/api/ps` — modelos cargados y memoria real

`GET /api/ps` devuelve, por modelo cargado: `name`, `digest`, `size`, `size_vram`, `context_length`, `expires_at` [VERIFICADO EN DOC OFICIAL: api.md]. Es la única fuente confiable de "cuánto de este modelo entró en VRAM" y de "qué `num_ctx` quedó efectivamente asignado" — de ahí la regla de la condición 12(b): SaurioLLM manda siempre `options.num_ctx` explícito y compara contra `context_length` de `/api/ps` después de cargar, porque el servidor puede haber aplicado otro valor (por ejemplo el contexto de 256K de la app de bandeja si el request no lo hubiera fijado) [COMPROBADO EN EQUIPO: `server.log` del 2026-09-18 muestra `OLLAMA_CONTEXT_LENGTH:262144` como default de la app de bandeja].

`ModelManager` es el único poller de este endpoint (5 s con modelo cargado y panel abierto o run activo; 30 s en reposo, ya fijado en la sección 9). Telemetry recibe el resultado por el evento `models.loaded`, nunca pide `/api/ps` por su cuenta.

"Contexto utilizado" por turno se estima con `TokenEstimator` (ver documento de context management, sección 8 de la columna vertebral) y se corrige contra `prompt_eval_count` real apenas llega la respuesta: `estimated` antes de la respuesta, `measured` después.

### 3.4 Muestreo del sistema (`SystemSampler`)

| Dato | Fuente | Plataforma | Calidad |
|---|---|---|---|
| CPU % del sistema | Delta de `os.cpus()[i].times` (user/nice/sys/idle/irq) entre dos muestras | todas | `measured` |
| RAM total/libre del sistema | `os.totalmem()` / `os.freemem()` | todas | `measured` |
| CPU/RAM del proceso Electron | `process.getCPUUsage()`, `process.getProcessMemoryInfo()`, `app.getAppMetrics()` (`ProcessMetric[]`: `cpu.percentCPUUsage`, `memory.workingSetSize/peakWorkingSetSize/privateBytes`) [VERIFICADO EN DOC OFICIAL: electronjs.org/docs/api/app] | todas | `measured` |
| GPU util / VRAM usada / temperatura / potencia (NVIDIA) | `nvidia-smi --query-gpu=memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits` [VERIFICADO EN DOC OFICIAL: docs.nvidia.com/deploy/nvidia-smi]; binario en `C:\Windows\System32\nvidia-smi.exe` [COMPROBADO EN EQUIPO] | Windows/Linux + NVIDIA | `measured` |
| GPU util / VRAM (Windows, sin NVIDIA) | Contadores `\GPU Adapter Memory(*)\Dedicated Usage`, `\GPU Engine(*)\Utilization Percentage` vía `Get-Counter`, período ≥ 10 s [HIPÓTESIS A PROBAR, relevamiento: coincide con `nvidia-smi` en una prueba puntual pero el costo de invocar PowerShell es alto] | Windows sin NVIDIA (v0.2) | `measured` con advertencia de posible ruido |
| GPU/VRAM (Linux AMD) | `rocm-smi --showmeminfo vram --json` / `amd-smi metric --mem-usage --json` [VERIFICADO EN DOC OFICIAL: rocm.docs.amd.com] | Linux + AMD (v0.2) | `measured` |
| GPU/VRAM (macOS Apple Silicon) | Sin API de sistema para memoria unificada dedicada a GPU; se usa la línea `inference compute … available=` del log/stdout de Ollama, que refleja `recommendedMaxWorkingSetSize` de Metal [VERIFICADO EN DOC OFICIAL: código fuente `discover/gpu_info_darwin.m`, citado en investigación]; alternativa `os.totalmem() × factor` | macOS (v0.2) | `estimated` |
| VRAM por proceso (Windows, NVIDIA, WDDM) | No disponible: `nvidia-smi --query-compute-apps=...used_memory` devuelve `[N/A]` bajo WDDM [COMPROBADO EN EQUIPO: verificado en esta máquina] | Windows | `unavailable` — se usa `/api/ps size_vram` en su lugar |
| Consumo de la propia app | `app.getAppMetrics()` | todas | `measured` |

**Qué NO está disponible con providers OpenAI-compatible:** ninguna de las filas de esta tabla depende del provider (son del sistema operativo), así que el `SystemSampler` funciona igual sea cual sea el provider activo. Lo que sí depende del provider son las métricas de §3.1 (duraciones, cache hit): con `OpenAICompatProvider` esas quedan en `estimated` o `unavailable`, nunca `measured`.

## 4. Modelo de métrica

Toda métrica expuesta a la UI sigue la misma forma, coherente con el patrón ya usado en la sección 17 de la columna vertebral para el inventario de hardware:

```ts
// ===== packages/shared/src/telemetry.ts (nombre nuevo) =====
export interface MetricSample<T = number> {
  value: T;
  unit: 'tokens' | 'tok_s' | 'ms' | 'percent' | 'mib' | 'celsius' | 'watts' | 'count';
  quality: 'measured' | 'estimated' | 'unavailable';
  source: 'ollama_response' | 'api_ps' | 'client_clock' | 'os' | 'nvidia_smi' | 'get_counter'
        | 'rocm_smi' | 'ollama_log' | 'app_metrics' | 'gateway_status';
  sampledAt: number;                 // epoch ms
}
export interface MetricsSnapshot {
  system: { cpuPercent: MetricSample; ramUsedMib: MetricSample; ramFreeMib: MetricSample;
    gpu?: { utilPercent: MetricSample; vramUsedMib: MetricSample; vramFreeMib: MetricSample;
      tempC?: MetricSample; powerW?: MetricSample } };
  app: { cpuPercent: MetricSample; rssMib: MetricSample };
  loadedModels: LoadedModel[];                       // desde ModelManager, ya con quality implícita 'measured'
  scheduler: { slots: SlotStatus[]; queue: QueuedJob[] };  // desde ModelGateway.status()
  activeRuns: { runId: string; chatId: string; state: RunState }[];
}
```

`unavailable` no es un caso de error: es un valor legítimo de `quality` que la UI renderiza como "no disponible en esta plataforma" en vez de ocultar la fila o mostrar un guion ambiguo.

**Nota de consistencia entre documentos [DECISIÓN DE DISEÑO]:** `MetricSample<T>` (con `unit`) y `MetricsSnapshot` tal como quedan definidos en este documento son la forma canónica única de estos dos tipos; cualquier otra definición de un `Metric<T>` sin `unit`, o de un `MetricsSnapshot` con una forma distinta a la de este documento (por ejemplo `{slots, queue, loaded, system}`), queda obsoleta y debe alinearse a la de acá, porque este es el superconjunto que necesita la vista en vivo del panel (sistema + app + modelos cargados + scheduler + runs activos).

## 5. Métricas por nivel de agregación

Cuatro niveles, cada uno con su ubicación de persistencia (nomenclatura de la sección 4 de la columna vertebral):

**Por respuesta (`messages.response_metrics_json`).** Un `ResponseMetrics` completo por cada mensaje `assistant`: `promptTokens`, `cachedPromptTokens`, `evalTokens`, `loadMs`, `promptEvalMs`, `evalMs`, `totalMs`, `ttftClientMs`, `quality`. Se escribe en la misma transacción que la fila de `messages` (paso 4 del flujo de ejecución, sección 6). Es la métrica más granular y la única realmente barata: no agrega nada, solo copia lo que ya vino en el chunk `done`.

**Por run (`runs.metrics_json`).** Al llegar a `completed`/`failed`/`cancelled`: tokens de entrada/salida totales, `tps` medio (promedio ponderado por `eval_count` de cada turno, no promedio simple de tasas — evita que un turno de 3 tokens distorsione el número), `cacheHitRatio` medio, cantidad de iteraciones, tool calls por estado final (`done`/`failed`/`cancelled`), `wall time` (`finished_at − started_at`), `load_ms` (si hubo carga de modelo durante el run), y VRAM: línea base antes del run + pico durante el run (ambas del `SystemSampler`, `quality: 'measured'` si hubo muestreo activo, `unavailable` si el panel estuvo cerrado y no había run activo para disparar el muestreo — ver §8). Se escribe al cerrar el run, no incrementalmente, para no pelear con WAL en cada turno.

**Por chat (`v_chat_stats`).** Vista SQL (JSON1) sobre `messages.response_metrics_json` y `runs.metrics_json` filtrando por `chat_id`, ya prevista en la sección 4 de la columna vertebral. No es una tabla nueva: se calcula al vuelo cuando el usuario abre el historial de un chat o el panel en modo "por chat". Expone: tokens totales del chat, tps mediana, cache hit medio, cantidad de runs, runs fallidos.

**Por modelo (`v_model_stats`).** Misma técnica, agrupando por `(provider_id, model_name)` en vez de `chat_id`. Es la fuente que alimenta "tok/s típico de este modelo en esta máquina" para comparar contra la mediana histórica en el diagnóstico de lentitud (§7). No compite con `model_compat` (eso es del Banco de pruebas, sección 19): `v_model_stats` es uso real acumulado sin condiciones controladas; `model_compat` es una medición controlada y reproducible. El panel muestra ambas cuando existen, con etiquetas distintas ("uso real" vs "banco de pruebas, probado el DD/MM").

**Agregadas / históricas (`metrics_minute`).** Una fila por minuto con `cpu_avg/max`, `ram_used_avg/max`, `gpu_util_avg/max`, `vram_used_avg/max`, `gpu_temp_max`, `power_avg`, `app_rss_max`, `samples` y `quality_json` (qué fracción de las muestras de ese minuto fueron `measured` vs `estimated` vs `unavailable`, para que un gráfico de 30 días no mienta silenciosamente si la GPU no tuvo fuente confiable esa semana). Consistente con la tabla `metrics_minute` ya definida en la sección 4 de la columna vertebral. Retención: 30 días con job diario que borra filas más viejas y corre `PRAGMA optimize` (sección 4).

## 6. Vista en vivo

La vista en vivo se arma en dos capas para no confundir "lo que está pasando ahora en el sistema" con "lo que está pasando ahora en el agente":

**Franja de sistema** (siempre visible con el panel abierto): CPU %, RAM usada/total, GPU %, VRAM usada/total, temperatura, potencia — cada número con su `quality` como badge discreto (un punto de color o un ícono, no texto largo repetido). Actualización 2 s activo / 15 s en reposo para CPU/RAM; 2 s / 10 s para GPU (nvidia-smi bajo demanda en MVP, ver §9).

**Franja de runtime**: modelos cargados con su `size`/`size_vram`/`context_length` (de `/api/ps`, refrescada según el intervalo de `ModelManager`), tareas activas (runs en estado distinto de terminal, con chat y agente), solicitudes en espera (la cola del `InferenceScheduler`: cuántos jobs esperan por modelo, con la prioridad de cada uno — `interactive`/`subagent`/`benchmark`/`warmup`). Esta franja se llena con `ModelGateway.status()` y el evento `models.loaded`, sin poll propio de Telemetry.

**Bajo cada mensaje** (no es un panel separado, vive en el propio chat): tokens de entrada/salida, tok/s de generación, tiempo de carga si hubo, cache hit — la vista más usada en la práctica porque no requiere abrir nada. Esto es parte del MVP explícito de la condición 11.B y de la tabla de alcance (sección 16).

La vista en vivo se sirve por IPC `metrics:tick` (`MetricsSnapshot`, solo mientras el panel está abierto, ya declarado en la sección 5 de la columna vertebral) y el snapshot inicial por `metrics:snapshot`. El renderer nunca calcula nada: solo pinta lo que Telemetry ya agregó.

## 7. Diagnósticos

Reglas deterministas sobre datos ya etiquetados. Cada una entrega: la evidencia (el número y su `quality`), un mensaje comprensible y una acción sugerida que abre Settings, el Centro de modelos, o propone repetir el run con un ajuste — **nunca cambian nada solas**, coherente con la regla de ajustes automáticos visibles y reversibles de la sección 19 y con el principio de "se avisa y se pregunta" del flujo de ejecución (sección 6, paso 2):

1. **Falta de memoria / modelo no entra.** `size_vram < size` en `/api/ps` (offload parcial) o error de carga con `cudaMalloc failed: out of memory` / "too large" → "El modelo está parcialmente en CPU (medido)" o "Sin memoria al cargar este modelo con este contexto". Acción: bajar `num_ctx`, usar KV `q8_0` (solo managed), o elegir un modelo más chico desde el Centro de modelos. Ejemplo real usado como caso de referencia: el intento de cargar `gemma4:31b` con `num_ctx = 262144` el 2026-09-17, que reservó `llama_kv_cache` de 20.480 MiB y falló al pedir 2.405 MiB de compute buffers, devolviendo HTTP 500 tras 1m14s [COMPROBADO EN EQUIPO: `server-1.log` del 17/09]. Este documento, el 08, el 10 y el 13 citan el mismo caso.
2. **Lentitud por offload o por contexto.** `gen_tps` del turno < 40 % de la mediana histórica de `v_model_stats` para ese modelo → "Generación más lenta de lo normal: puede ser offload a CPU, temperatura de GPU alta, o un proceso ajeno usando la GPU". Acción: revisar el Centro de modelos (fit estimado) o el panel de sistema (temperatura, otros procesos).
3. **Poca VRAM libre antes de un run.** VRAM libre (línea base, `SystemSampler`) < 500 MiB → "Poca VRAM libre para cargar el modelo: cerrá aplicaciones que usan GPU". Se evalúa al iniciar un run que requiera cargar un modelo, antes de llamar a `load()`.
4. **Cache de prefijo roto.** `cacheHitRatio` < 0,5 durante varios turnos seguidos del mismo chat → "El contexto se está reevaluando entero en cada turno: el prefijo no se está cacheando (posible incompatibilidad de template)". Enlaza a la sección de context management (documento correspondiente / sección 8 de la columna vertebral).
5. **Desconexión del provider.** `health()` falla durante 20 s seguidos → "Ollama no responde". Acción: "Reintentar" (si es attach) o "Iniciar servidor" (solo disponible en modo managed, v0.3).
6. **Cola larga.** N jobs en espera para el mismo modelo por más de un umbral configurable (por ejemplo 3 jobs o 30 s de espera del primero de la cola) → "Hay varias tareas esperando el mismo modelo: con 1 slot se ejecutan una por una". Esto no es un error, es información: le explica al usuario por qué un chat "no arrancó" cuando en realidad está en cola detrás de otro run o de un subagente (sección 9, agrupación por modelo).
7. **Contexto no coincide.** `/api/ps context_length` distinto del `num_ctx` pedido en el request → "El servidor asignó un contexto distinto al pedido: revisá la variable `OLLAMA_CONTEXT_LENGTH` del servidor". Este diagnóstico existe específicamente por la condición 12(b) y por el hallazgo de que la app de bandeja de Ollama corre con contexto por defecto de 256K [COMPROBADO EN EQUIPO: `db.sqlite` de la app, `context_length = 262144`; `server.log`, `OLLAMA_CONTEXT_LENGTH:262144`].

Además, en modo attach (el único del MVP), el Centro de modelos y este panel muestran una advertencia persistente y no bloqueante: "Ollama expuesto en toda la red (`0.0.0.0:11434`)" y "contexto por defecto 256K en la app de bandeja" [COMPROBADO EN EQUIPO: `server.log`, `OLLAMA_HOST:http://0.0.0.0:11434`], sin ofrecer nunca cambiar esa configuración desde SaurioLLM — solo informar (condición 12c).

## 8. Overhead del muestreo y frecuencia

El muestreo tiene que ser más barato que el problema que mide. Reglas de costo, ya anticipadas en la sección 9 de la columna vertebral y en la investigación de hardware:

- `os.cpus()`, `os.freemem()`, `process.getCPUUsage()`: microsegundos, sin `spawn`, se pueden pedir cada 1–2 s sin costo perceptible [VERIFICADO EN DOC OFICIAL: Node.js `os` docs].
- `app.getAppMetrics()`: algo más costoso, cada 5 s alcanza.
- `nvidia-smi`: cada invocación lanza un proceso nuevo (cientos de ms). MVP: se llama **bajo demanda**, solo cuando el panel está abierto y no como poll continuo, y con un intervalo mínimo de 2 s si el panel queda abierto. v0.2: un único proceso hijo de larga vida `nvidia-smi -lms 2000` que emite una línea CSV por muestra y se mata al cerrar el panel — mucho más barato que relanzar el binario cada vez.
- `Get-Counter` (Windows sin NVIDIA, v0.2): cada llamada levanta PowerShell y tarda del orden de 1 s en resolverse [HIPÓTESIS A PROBAR, relevamiento]; período mínimo recomendado 10 s.
- `/api/ps`: según la sección 9, 5 s activo / 30 s reposo, y ya cubierto por `ModelManager`, no por Telemetry.
- Todo el muestreo corre en `main` o en un `utilityProcess` dedicado, nunca en el renderer; solo se envían deltas al renderer por IPC (`metrics:tick`), y solo mientras el panel está visible.
- El muestreo se pausa cuando la ventana está oculta (minimizada, sin foco en background prolongado) o el sistema entra en suspensión (`powerMonitor.suspend`), para no gastar batería ni CPU sin que nadie mire el panel.
- Frecuencias resumidas: CPU/RAM del sistema y del proceso, 2 s activo / 15 s reposo; GPU, 2 s / 10 s (más cara, intervalo mayor); `/api/ps`, 5 s / 30 s (responsabilidad de `ModelManager`); consumo de la app, 5 s fijo.

## 9. UI (descripción de paneles)

**Bajo cada mensaje del chat (MVP, siempre visible, no es un panel aparte).** Una línea compacta con tokens de entrada → salida, tok/s, tiempo de carga (si hubo) y cache hit, cada uno con su badge de calidad. Es lo que más se usa porque no requiere abrir nada extra.

**Panel de rendimiento (accesible desde la barra lateral o un atajo).** Tres secciones:
1. *Sistema* — CPU, RAM, GPU, VRAM, temperatura, potencia, con gráficos de línea de los últimos 10 minutos (ring buffer en memoria) cuando el panel está abierto.
2. *Runtime* — modelos cargados (con VRAM ocupada y contexto efectivo), tareas activas, cola de espera.
3. *Diagnósticos* — lista de alertas activas (§7) con su evidencia y botón de acción.

**Config efectiva del run (dentro del chat, no un panel aparte).** Ya prevista en la sección 19: muestra `EffectiveConfig` con sus `adjustments[]` y el botón "Usar lo pedido". Este documento no la rediseña, solo confirma que las métricas que la acompañan (tps, VRAM pico del run) salen de `runs.metrics_json`.

**Historial (v0.2, "Previsto para más adelante").** Vista con selector de rango (día/semana/mes) sobre `metrics_minute`, y comparación por chat/modelo usando `v_chat_stats`/`v_model_stats`.

## 10. Responsabilidades (resumen)

- **Model Manager**: único poller de `/api/ps`; expone modelos cargados y su memoria real a Telemetry vía evento; no calcula agregados de uso ni diagnósticos.
- **Scheduler (`InferenceScheduler`, dentro de `ModelGateway`)**: expone `status()` (slots, cola) y entrega `ResponseMetrics` al cerrar cada respuesta; no persiste series de tiempo ni decide diagnósticos.
- **Telemetry**: agrega lo anterior más el muestreo del `SystemSampler`; persiste en `metrics_minute`/`runs.metrics_json`/`messages.response_metrics_json`; calcula `v_chat_stats`/`v_model_stats`; evalúa las reglas de diagnóstico; sirve `metrics:snapshot`/`metrics:tick` a la UI. No pide nada directamente a Ollama ni al sistema operativo por fuera de sus propios `SystemSampler`.

## Imprescindible para el MVP

- Métricas por respuesta tomadas del chunk final de `/api/chat` (tokens, duraciones, tok/s, cache hit si el campo existe) bajo cada mensaje.
- Métricas por run (`runs.metrics_json`) al cerrar el run.
- Estado de modelos cargados vía `ModelManager`/`/api/ps` en el selector y en el panel.
- Cola y tareas activas vía `ModelGateway.status()`.
- CPU/RAM del sistema y de la app mediante `SystemSampler` con `os.*` y `app.getAppMetrics()`.
- GPU/VRAM/temperatura vía `nvidia-smi` bajo demanda al abrir el panel (sin proceso hijo continuo todavía).
- Diagnóstico de offload (`size_vram < size` o error de carga) enlazado al Centro de modelos.
- Diagnóstico de contexto no coincidente (`/api/ps context_length` ≠ pedido) y advertencia de exposición en red / contexto 256K de la app de bandeja, ambos sin tocar la configuración de Ollama.
- Modelo de métrica con `quality` explícita (`measured`/`estimated`/`unavailable`) en todo lo anterior.

## Previsto para más adelante

- `SystemSampler` de GPU como proceso hijo de larga vida (`nvidia-smi -lms 2000`), `Get-Counter` (Windows sin NVIDIA), `rocm-smi`/`amd-smi` (Linux AMD), estimación por log de Ollama (macOS) — todo v0.2.
- Tabla `metrics_minute` con retención de 30 días, ring buffer persistente y vistas de historial por chat/modelo en la UI (v0.2).
- Diagnósticos completos: lentitud por comparación histórica robusta (`v_model_stats`), cola larga con umbral configurable, todos enlazados a acciones más ricas en Settings (v0.2).
- Comparación explícita entre "uso real" (`v_model_stats`) y "banco de pruebas" (`model_compat`) en una misma vista (depende del documento 19 / Banco de pruebas, v0.3).

## Nomenclatura agregada

- `SystemSampler`: componente nuevo, vive en `apps/desktop/src/main/services/system-sampler/` (nunca en `packages/runtime`, que es Node puro y no importa `electron` — spine §1.2/§3, doc 01 §4.17, doc 02), responsable exclusivo del muestreo de sistema (CPU/RAM/GPU/potencia/temperatura) y de la telemetría del propio proceso Electron. No estaba nombrado explícitamente en la columna vertebral (que hablaba de "muestreo del sistema" en general); se deriva del mismo estilo que `ModelManager`/`ToolRegistry`. En `packages/runtime/src/telemetry/` sólo viven `MetricsAggregator`, `Diagnostics` y `ringBuffer.ts`, que reciben las muestras ya tomadas por inyección (`HostAdapter`).
- `MetricSample<T>` y `MetricsSnapshot`: interfaces TypeScript nuevas en `packages/shared/src/telemetry.ts`, siguiendo el patrón `{ value, unit, quality, source, sampledAt }` ya usado informalmente en la sección 17 de la columna vertebral para el inventario de hardware; se formaliza acá porque el panel de rendimiento es el primer consumidor que necesita el tipo compartido.

## Desvíos respecto de la columna vertebral

1. **Qué:** la columna vertebral (sección 18) no nombra un tipo compartido para `{value, unit, quality, source, sampledAt}`; lo usa como prosa y como parte de `settings.hardware_inventory_json` (sección 17). Este documento lo formaliza como `MetricSample<T>` en `packages/shared/src/telemetry.ts`.
   **Por qué:** el panel de rendimiento necesita el mismo contrato para CPU/RAM/GPU en vivo que el Centro de modelos usa para el inventario de hardware; declararlo una sola vez evita que cada consumidor invente su propio envoltorio. No cambia ninguna decisión ya tomada, solo nombra algo que la columna vertebral ya usaba implícitamente.
2. **Qué:** se nombra explícitamente `SystemSampler` como componente separado, ubicado en `apps/desktop/src/main/services/system-sampler/` (spine §3, doc 01 §4.17, doc 02) y no en `packages/runtime`, mientras que la sección 18 de la columna vertebral hablaba de "muestreo del sistema" sin darle nombre de componente propio (a diferencia de `HardwareProbe`, que sí tiene nombre en la sección 17 para el inventario puntual de hardware).
   **Por qué:** el inventario de hardware (una vez, a demanda, para recomendaciones) y el muestreo continuo (cada 2–15 s, para el panel en vivo) son responsabilidades distintas aunque usen las mismas fuentes (`nvidia-smi`, `os.*`); separarlos en `HardwareProbe` (Centro de modelos, sección 17) y `SystemSampler` (Panel de rendimiento, este documento) evita que un mismo componente mezcle "medir una vez para decidir si un modelo entra" con "medir todo el tiempo para mostrar un gráfico".

## Preguntas abiertas

Ninguna que cambie el diseño de este documento. Las preguntas de hardware y de contexto 256K que podrían haber afectado los diagnósticos de esta sección ya están resueltas por la condición 12 (dato [COMPROBADO EN EQUIPO], pregunta abierta 6 de la sección 20 de la columna vertebral dada por respondida).
