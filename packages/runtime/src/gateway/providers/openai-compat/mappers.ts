// Traducción entre el wire format OpenAI-compatible y los tipos de dominio de @saurio/shared —
// packages/runtime/src/gateway/providers/openai-compat/mappers.ts.
// Mismo criterio que providers/ollama/mappers.ts: ningún tipo de dominio se redefine acá.
import type { ChatMessage, ToolCall, ModelInfo, ModelRef, Locality } from '@saurio/shared';
import type { JsonSchemaTool, ChatRequest } from '../../types.js';
import type { OpenAIMessage, OpenAIMessageToolCall, OpenAIJsonSchemaTool, OpenAIModel, OpenAIChatRequest } from './schemas.js';

// ── Dominio → wire (request) ─────────────────────────────────────────────────

export function toOpenAIMessage(msg: ChatMessage): OpenAIMessage {
  if (msg.role === 'tool') {
    return { role: 'tool', tool_call_id: msg.toolCallId ?? '', content: msg.content, name: msg.toolName };
  }
  const out: OpenAIMessage = { role: msg.role, content: msg.content };
  if (msg.role === 'assistant' && msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
    out.tool_calls = msg.toolCalls.map(toOpenAIMessageToolCall);
    // Varios servidores (y el propio SDK de OpenAI) esperan `content: null` en vez de `""` cuando
    // el mensaje del asistente es puramente un tool call sin texto acompañante.
    if (msg.content.length === 0) out.content = null;
  }
  return out;
}

function toOpenAIMessageToolCall(call: ToolCall): OpenAIMessageToolCall {
  const args = (call.args !== null && typeof call.args === 'object') ? (call.args as Record<string, unknown>) : {};
  return { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(args) } };
}

export function toOpenAITools(tools: JsonSchemaTool[]): OpenAIJsonSchemaTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters as Record<string, unknown>,
    },
  }));
}

export function toOpenAIChatRequest(req: ChatRequest): OpenAIChatRequest {
  const wire: OpenAIChatRequest = {
    model: req.model,
    messages: req.messages.map(toOpenAIMessage),
    stream: true,
    // Se pide siempre; si el servidor no lo soporta simplemente lo ignora y no manda `usage` en el
    // chunk final (doc 08 §8: entonces las métricas quedan `estimated` sin conteo de tokens).
    stream_options: { include_usage: true },
    temperature: req.options.temperature,
    max_tokens: req.options.numPredict,
  };
  if (req.options.topP !== undefined) wire.top_p = req.options.topP;
  if (req.options.topK !== undefined) wire.top_k = req.options.topK;
  if (req.options.seed !== undefined) wire.seed = req.options.seed;
  if (req.options.stop !== undefined) wire.stop = req.options.stop;
  if (req.tools !== undefined) wire.tools = toOpenAITools(req.tools);
  return wire;
}

// ── Wire → dominio (response) ────────────────────────────────────────────────

/** Acumulador de un tool call partido en varios `content_block_delta`/tool_calls delta — se llena
 *  incrementalmente en provider.ts y se resuelve acá recién al final (`content_block_stop`/
 *  `finish_reason`), porque `ToolCall.args` del dominio exige el objeto YA parseado, nunca un
 *  fragmento de JSON parcial. */
export interface PendingToolCall { id?: string; name?: string; args: string }

export function fromOpenAIToolCallDelta(index: number, entry: PendingToolCall): ToolCall {
  let args: unknown = {};
  if (entry.args.trim().length > 0) {
    try {
      args = JSON.parse(entry.args);
    } catch {
      args = {}; // JSON parcial corrupto (servidor mal formado) — nunca se inventa un valor parcial
    }
  }
  return {
    id: entry.id ?? `synthetic-${index}`,
    name: entry.name ?? '',
    args,
    index,
    transport: 'native',
  };
}

/** Doc 08 §8: no hay `/api/ps` equivalente ni concepto de host loopback/LAN documentado por la API
 *  pública; se deriva de la URL igual que Ollama (`classifyLocality`), extendido a rangos de red
 *  privada RFC1918 para servidores locales tipo LM Studio/vLLM corriendo en otra máquina de la LAN. */
export function classifyLocality(baseUrl: string): Locality {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    host = '';
  }
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1') return 'local';
  if (isPrivateIPv4(bare) || isPrivateIPv6(bare)) return 'lan';
  return 'cloud';
}

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

function isPrivateIPv6(host: string): boolean {
  return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
}

/** doc 08 §8: sin endpoint de capabilities estandarizado en `/v1`. `tools: true` es una asunción
 *  documentada (no una medición): el ModelManager es quien la corrige a `false` si el primer
 *  request con `tools` falla y reintenta con TextToolProtocol — este Provider no implementa ese
 *  reintento porque no le corresponde (regla del doc 08 §1: "el ModelManager mide y cataloga").
 *  `thinking`/`vision`/`embedding` nunca se afirman en `true` sin señal real: afirmarlo sería
 *  inventar un dato. `contextMax` sale de los campos no estándar que algunos servidores agregan. */
export function mapModelInfo(providerId: string, locality: Locality, model: OpenAIModel): ModelInfo {
  const ref: ModelRef = { providerId, name: model.id, locality };
  return {
    ref,
    digest: '',
    sizeBytes: 0,
    family: '',
    parameterSize: '',
    quantization: '',
    capabilities: { tools: true, thinking: false, vision: false, embedding: false },
    contextMax: extractContextLength(model),
  };
}

/** Sólo el hostname público documentado. Un preset llamado OpenRouter con otra URL, un proxy o
 * `openrouter.ai.ejemplo` no habilitan metadatos/costo atribuidos a OpenRouter. */
export function isOfficialOpenRouterBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'openrouter.ai';
  } catch {
    return false;
  }
}

function nonNegativeNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Los detalles de pricing/capabilities no son parte del contrato OpenAI-compatible. Sólo se
 * consumen de la respuesta de OpenRouter tras validar el host oficial; los demás proveedores
 * conservan el mapper genérico y no reciben valores adivinados. */
export function mapOpenRouterModelInfo(
  providerId: string,
  locality: Locality,
  model: OpenAIModel,
  metadataCheckedAt: number,
): ModelInfo {
  const pricingValues = {
    promptUsdPerToken: nonNegativeNumber(model.pricing?.prompt),
    completionUsdPerToken: nonNegativeNumber(model.pricing?.completion),
    requestUsd: nonNegativeNumber(model.pricing?.request),
    imageUsd: nonNegativeNumber(model.pricing?.image),
  };
  const pricing = Object.values(pricingValues).some((value) => value !== undefined)
    ? pricingValues
    : undefined;
  const supported = new Set(model.supported_parameters ?? []);
  const inputModalities = new Set(model.architecture?.input_modalities ?? []);
  const outputModalities = new Set(model.architecture?.output_modalities ?? []);

  return {
    ref: { providerId, name: model.id, locality },
    digest: '',
    sizeBytes: 0,
    family: '',
    parameterSize: '',
    quantization: '',
    capabilities: {
      tools: supported.has('tools'),
      thinking: supported.has('reasoning'),
      vision: inputModalities.has('image'),
      embedding: outputModalities.has('embeddings'),
    },
    contextMax: extractContextLength(model),
    pricing,
    metadataSource: 'openrouter',
    metadataCheckedAt,
  };
}

function extractContextLength(model: OpenAIModel): number | undefined {
  return model.context_length ?? model.max_model_len ?? model.max_context_length;
}
