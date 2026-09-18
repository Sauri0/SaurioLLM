# Documento 18 — Providers OpenAI-compatible y Anthropic

**Propósito.** Documentar, para revisión, los dos providers nuevos implementados detrás de la interfaz `Provider` existente (`packages/runtime/src/gateway/Provider.ts`): `OpenAICompatProvider` (`packages/runtime/src/gateway/providers/openai-compat/`) y `AnthropicProvider` (`packages/runtime/src/gateway/providers/anthropic/`). Extiende la tabla de degradación que ya existía en el doc 08 §8 (que sigue siendo la referencia central para "qué se pierde frente a Ollama") con el detalle específico de cada provider, cómo se configuran y qué necesita construir el host (Electron) para conectarlos de verdad.

**Leyenda:** `[COMPROBADO EN EQUIPO]` `[VERIFICADO EN DOC OFICIAL]` `[DECISIÓN DE DISEÑO]` `[HIPÓTESIS A PROBAR]` — se reutiliza la de los docs 00–17.

---

## 1. OpenAICompatProvider

**Para qué sirve.** Un único provider para todo lo que hable el dialecto `/v1/chat/completions` de OpenAI: OpenAI real, OpenRouter, Groq, y motores locales LM Studio / `llama.cpp server` / vLLM / Jan `[VERIFICADO EN DOC OFICIAL: platform.openai.com/docs/api-reference/chat, contrato usado como referencia por todos los anteriores]`.

**Qué implementa.**
- `GET /v1/models` para `listModels()`/`describeModel()`.
- `POST /v1/chat/completions` con `stream: true` y `stream_options.include_usage: true` (se pide siempre; si el servidor no lo soporta, simplemente lo ignora y no manda `usage` — no rompe el request).
- Tools en formato OpenAI (idéntico al `JsonSchemaTool` que ya usa el Gateway, por eso el mapeo es casi 1:1). Los `tool_calls` que llegan partidos en varios deltas (`delta.tool_calls[].index` identifica la posición dentro del array de tool calls, no el choice) se acumulan en `provider.ts` y se emiten como un único `ChatChunk` de tipo `tool_call` recién cuando el JSON está completo.
- Abort real por request (`AbortSignal` propagado a `fetch` y al parser SSE).
- Mapeo de errores HTTP: 401/403 → `invalid_api_key` (código agregado de forma aditiva a `ProviderErrorCode`, ver §3), 404 → `model_not_found`, 429 → `server_busy` (con el valor de `Retry-After` incluido en el mensaje), 5xx → `unknown` salvo que el body traiga `error.type` reconocible.

**Qué se degrada frente a Ollama** (extiende doc 08 §8, tabla ya existente):

| Dato | Ollama | OpenAICompatProvider |
|---|---|---|
| `capabilities.tools` | medido por `/api/show` | **asumido `true`** — no hay endpoint estandarizado; el ModelManager es quien debe reintentar con `TextToolProtocol` si el primer request con `tools` falla, y recién ahí corregir a `false` para ese modelo. Este Provider no implementa ese reintento (no le corresponde: doc 08 §1, "el ModelManager mide y cataloga") |
| `capabilities.thinking`/`vision` | medido por `/api/show` | siempre `false` — no hay señal alguna en `/v1/models` para inferirlos; afirmarlos sería inventar un dato |
| `contextMax` | medido (`<arch>.context_length`) | best-effort: se intentan los campos no estándar `context_length`/`max_model_len`/`max_context_length` que algunos servidores agregan a `/v1/models`; si ninguno está, queda `undefined` |
| `size_vram`/estado cargado (`listLoaded`) | medido por `/api/ps` | **no implementado** (`listLoaded` queda `undefined` en el Provider) — no hay `/api/ps` equivalente |
| `load`/`unload`/`keep_alive` | explícito | **no implementado** — no hay concepto estándar de `keep_alive` en `/v1`; el Scheduler debe tratar estos providers como "siempre cargados" (ya documentado en doc 08 §8) |
| `ResponseMetrics.quality` | `measured` (duraciones reales de `/api/chat`) | siempre `estimated` — `usage.prompt_tokens`/`completion_tokens` son conteos exactos cuando el servidor los manda, pero no hay duración de carga/prompt/generación por separado, así que la calidad del objeto completo nunca sube a `measured` |
| Visión (`ContentPart` tipo `image`) | soportado en `mappers.ts` de Ollama | **no implementado** en este provider — fuera del alcance pedido para esta tarea; queda como gap documentado, no simulado |

**Configuración** (`OpenAICompatProviderOptions`):
```ts
{
  id: string;                                    // identificador único del provider (p. ej. "openrouter", "lmstudio")
  baseUrl: string;                                // p. ej. "https://api.openai.com", "https://openrouter.ai/api", "http://127.0.0.1:1234"
  getApiKey?: () => Promise<string | undefined>;  // callback del host — ver §3; omitible para motores locales sin auth
  headers?: Record<string, string>;               // extra fijos — p. ej. HTTP-Referer/X-Title de OpenRouter
}
```

**Locality.** Se deriva de `baseUrl` (`classifyLocality`, `mappers.ts`): loopback (`127.0.0.1`/`localhost`/`::1`) → `local`; rango de red privada RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) o link-local → `lan`; cualquier otro host → `cloud`. Es una heurística sobre la URL, no una medición — documentado así en el propio código.

---

## 2. AnthropicProvider

**Para qué sirve.** La API pública de Anthropic (Claude), como provider `cloud` puro — no existe un despliegue local/LAN de esta API, a diferencia de OpenAI-compatible.

**Contrato verificado ANTES de escribir código** (regla de la tarea), vía WebFetch contra `platform.claude.com/docs/en/api/messages`, `.../build-with-claude/streaming`, `.../agents-and-tools/tool-use/overview` y `.../api/models/list` el 2026-09-18 (`docs.anthropic.com` redirige 301 al mismo contenido) `[VERIFICADO EN DOC OFICIAL]`:
- `POST /v1/messages` con headers `x-api-key` + `anthropic-version: 2023-06-01` + `content-type: application/json`; `max_tokens` obligatorio; `system` es un campo del request separado de `messages` (no hay rol `system` dentro del array).
- Streaming SSE: `message_start` → N × (`content_block_start` → `content_block_delta`* → `content_block_stop`) → uno o más `message_delta` → `message_stop`, con `ping`/`error` intercalables en cualquier punto. `text_delta` para texto, `input_json_delta` (`partial_json`, fragmentos de JSON parcial) para el `input` de un `tool_use`, `thinking_delta`/`signature_delta` para bloques de razonamiento (este Provider consume `thinking_delta` como `ChatChunk` de tipo `thinking`; `signature_delta` no tiene contraparte en el dominio y se ignora a propósito). El `usage` de `message_delta` es **acumulativo**, no incremental (advertencia explícita de la doc oficial).
- Tools: `input_schema` (no `parameters`); el resultado se manda como bloque `tool_result` (`tool_use_id`, `content`, `is_error?`) dentro de un mensaje de rol `user`.
- `GET /v1/models` para listar modelos — **nunca se hardcodean ids**; la respuesta trae `capabilities.thinking.supported`/`capabilities.image_input.supported` (datos reales) y `max_input_tokens` (contexto máximo real), pero no expone un flag `tools` explícito.

**Traducción `ChatMessage`/`ToolCall` ↔ bloques de Anthropic** (`mappers.ts`):
- `role: 'system'` → se extrae del array y se concatena en el campo `system` del request.
- `role: 'tool'` → bloque `tool_result` dentro de un mensaje `user`; los `tool_result` consecutivos (turno con varios tool calls en paralelo) se agrupan en un único mensaje `user`, como exige la API.
- `role: 'assistant'` con `toolCalls` → bloques `tool_use` (más un bloque `text` si hay contenido acompañante); sin `toolCalls`, se manda `content` como string plano (forma más simple, la misma que usa el ejemplo básico de la doc oficial).
- Un `tool_use` cuyo `input` llega partido en varios `input_json_delta` se acumula en `provider.ts` y se resuelve (parseo JSON) recién en `content_block_stop`, igual que el caso análogo de OpenAICompatProvider.

**Qué se degrada frente a Ollama** (mismo criterio que doc 08 §8, extendido):

| Dato | Ollama | AnthropicProvider |
|---|---|---|
| `capabilities.tools` | medido | **asumido `true`** — casi todos los modelos Claude vigentes lo soportan, pero `/v1/models` no expone un flag `tools` explícito en `capabilities` (los campos reales son `batch/citations/code_execution/context_management/effort/image_input/pdf_input/structured_outputs/thinking`) |
| `capabilities.thinking`/`vision` | medido | **reales**, no asumidos — salen de `capabilities.thinking.supported`/`capabilities.image_input.supported` |
| `contextMax` | medido | **real**, sale de `max_input_tokens` |
| `size_vram`/estado cargado/`load`/`unload` | medido/explícito | **no aplica en absoluto** — es un servicio gestionado, no un proceso con VRAM propia; no implementado |
| `ResponseMetrics.quality` | `measured` | siempre `estimated` — `usage.input_tokens`/`output_tokens` son conteos exactos, pero no hay duración de carga/prompt/generación separada |
| `is_error` en `tool_result` | — (no aplica a Ollama) | **no se manda** — `ChatMessage` (tipo de dominio que llega al Provider) no lleva un campo de error para resultados de tool, solo `ToolResult` (tipo persistido, distinto, de una capa anterior del pipeline) lo tiene; afirmar `is_error` sin esa señal sería inventar un dato. Si se quiere que Claude vea el resultado de una tool como fallido, el host/agent layer necesitaría propagar ese booleano hasta `ChatMessage` — pendiente, no implementado en esta tarea |
| Visión (`ContentPart` tipo `image`) | soportado en Ollama | **no implementado** en este provider — mismo gap documentado que OpenAICompatProvider |

**Configuración** (`AnthropicProviderOptions`):
```ts
{
  id: string;
  baseUrl?: string;                          // default "https://api.anthropic.com"
  getApiKey: () => Promise<string | undefined>;  // callback del host — obligatorio, ver §3
  anthropicVersion?: string;                 // default "2023-06-01"
  headers?: Record<string, string>;
}
```

**Locality.** Siempre `'cloud'` (constante, no derivada de `baseUrl`) — no existe un despliegue local/LAN real de esta API que justifique la heurística de red privada que sí tiene sentido para OpenAI-compatible.

---

## 3. Seguridad de claves — qué necesita el host

Ninguno de los dos providers guarda una clave en memoria más allá de la vida de un único request: reciben un callback `getApiKey(): Promise<string | undefined>` inyectado por el host y lo invocan just-in-time en cada llamada HTTP (`client.ts` de cada provider). Ningún mensaje de error propaga la clave real: `redact()` (`errors.ts` de cada provider) la reemplaza por `[REDACTED]` si por algún motivo apareciera literal en un cuerpo de respuesta (por ejemplo, un servidor mal configurado que hace eco del header). Ningún log de este código imprime el valor de la clave.

**Lo que el host (Electron, `apps/desktop`) todavía necesita construir para que esto sea usable de punta a punta** — fuera de la zona de esta tarea, se deja explícito acá:
1. **Almacén seguro de claves.** Este Provider no persiste nada; el host necesita guardar la clave del usuario en algo como `safeStorage` de Electron (o el keychain del SO) y exponer el `getApiKey` que cada Provider recibe en su constructor.
2. **Pantalla/flujo de "Proveedores".** Un lugar en la UI donde el usuario agregue un provider (elige tipo: OpenAI-compatible o Anthropic, pega `baseUrl` + clave, prueba `health()`), lo vea listado junto a Ollama, y pueda editarlo/borrarlo. Hoy `ModelGateway` recibe su lista de `Provider` por constructor (`ModelGatewayImpl(providerList)`); alguien necesita armar esa lista a partir de lo que el usuario configuró y pasarla ahí — no existe ese cableado todavía.
3. **`authorizedLocality` por proyecto/chat.** El invariante "nunca fallback local → nube" ya lo aplica `ModelGateway.chat()` (probado, ver §4) — pero necesita que el host decida y pase `ctx.authorizedLocality` con `'cloud'` incluido cuando el usuario explícitamente elige un modelo de OpenAI/Anthropic para ese chat. Sin esa UI, el invariante existe pero nadie puede autorizar `'cloud'` legítimamente todavía.
4. **Badge "NUBE"** en el selector de modelo para estos providers (ya previsto conceptualmente en doc 13, "frontera local/nube") — no implementado en esta tarea porque es UI, fuera de la zona exclusiva del encargo.

---

## 4. `ProviderErrorCode`: código agregado

`invalid_api_key` se agregó de forma aditiva a `packages/runtime/src/gateway/types.ts` (`ProviderErrorCode`). Ningún código existente cambió de significado. Es el único cambio de tipos compartido que estos dos providers necesitaron — el resto de la integración (registro en `packages/runtime/src/gateway/index.ts`) son solo dos líneas de export nuevas, sin tocar `Provider.ts` (su `kind: 'ollama' | 'openai-compat' | 'cloud'` ya alcanzaba para ambos providers nuevos sin cambios).

## 5. Locality: nunca fallback local → nube (verificado con test)

`ModelGatewayImpl.chat()` ya rechazaba cualquier locality no autorizada antes de esta tarea (`ModelGateway.test.ts`, con un `FakeProvider`). Esta tarea agrega la misma prueba usando los providers **reales** nuevos, para demostrar que el invariante se sostiene con implementaciones concretas de `kind: 'cloud'`/`'openai-compat'` y no solo con un doble de test:
- `packages/runtime/src/gateway/providers/openai-compat/provider.test.ts` — `OpenAICompatProvider` apuntando a un host público (`openrouter.ai`, `locality: 'cloud'`), `authorizedLocality: ['local']` → `ChatChunk` de error, `fetch` nunca se llama.
- `packages/runtime/src/gateway/providers/anthropic/provider.test.ts` — mismo caso con `AnthropicProvider`.

## 6. Bug encontrado y corregido durante la verificación

Al probar `OpenAICompatProvider` contra OpenRouter real (con `OPENROUTER_API_KEY` ya presente en el entorno de esta sesión), el primer intento devolvía el HTML de la home page de OpenRouter en vez de JSON: `new URL(path, baseUrl)` con un `path` que empieza con `/` resuelve como ruta **absoluta**, descartando cualquier sub-path de `baseUrl` (`https://openrouter.ai/api` perdía el `/api`). Se corrigió en `client.ts` de ambos providers forzando una unión relativa (`base` con `/` final, `path` sin `/` inicial). Confirmado contra la API real de OpenRouter tras el fix (`{"type":"content","text":"h"}...{"type":"done",...}`), y cubierto por el test de integración opcional del propio `provider.test.ts`.

---

## Nomenclatura agregada

Ninguna nueva. `Provider`, `ModelGateway`, `ChatChunk`, `ProviderErrorCode`, `ResponseMetrics`, `ModelInfo`, `ModelDescription`, `Locality` ya existen (doc 04) y se reutilizan sin variantes.

## Desvíos respecto de la columna vertebral / doc 08

Ninguno que contradiga lo ya decidido. Este documento desarrolla doc 08 §8 (que seguía describiendo `OpenAICompatProvider` como "fuera del MVP") con el detalle de una implementación real, y agrega `AnthropicProvider` como una variante nueva del mismo patrón de degradación (`kind: 'cloud'`) que doc 08 §9 ya dejaba prevista para v0.4 ("providers cloud con `authorizedLocality` habilitado explícitamente por proyecto") — se adelantó la implementación del Provider en sí sin adelantar el cableado de host (almacén de claves, UI, `authorizedLocality` real por proyecto), que sigue siendo trabajo pendiente y se nombra en §3.

## Preguntas abiertas

- ¿`is_error` en `tool_result` de Anthropic necesita propagarse desde `ToolResult` hasta `ChatMessage`? Hoy el dominio no lo permite (§2, tabla de degradación) — a definir si vale la pena el cambio de contrato para que Claude sepa distinguir un resultado de error de uno exitoso al leer el tool_result.
- ¿El reintento "tools:true asumido, corregir a false con TextToolProtocol tras el primer 400" (doc 08 §8) se implementa en `ModelManager` o en una capa nueva? Ninguno de los dos providers de esta tarea lo implementa porque no les corresponde (doc 08 §1) — queda para quien construya esa pieza.
