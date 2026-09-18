// Traducción entre el wire format de Ollama y los tipos de dominio de @saurio/shared —
// packages/runtime/src/gateway/providers/ollama/mappers.ts.
// Define: doc 04 §2/§3 (formas de dominio) y doc research-ollama.md (formas de wire). Ningún tipo de
// dominio se redefine acá: se importa desde @saurio/shared (regla de imports, doc 02 §3) y se llena
// a partir de los schemas de ./schemas.ts.
import type {
  ChatMessage, ToolCall, ModelCapabilities, ModelInfo, ModelDescription, LoadedModel,
  ModelRef, Locality,
} from '@saurio/shared';
import type { JsonSchemaTool } from '../../types.js';
import type {
  OllamaMessage, OllamaToolCall, OllamaJsonSchemaTool, OllamaCapability,
  OllamaTagModel, OllamaShowResponse, OllamaPsModel,
} from './schemas.js';

// ── Dominio → wire (request) ─────────────────────────────────────────────────

export function toOllamaMessage(msg: ChatMessage): OllamaMessage {
  const out: OllamaMessage = { role: msg.role, content: msg.content };
  if (msg.thinking !== undefined) out.thinking = msg.thinking;
  if (msg.images !== undefined) out.images = msg.images;
  if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
    out.tool_calls = msg.toolCalls.map(toOllamaToolCall);
  }
  if (msg.toolName !== undefined) out.tool_name = msg.toolName;
  if (msg.toolCallId !== undefined) out.tool_call_id = msg.toolCallId;
  return out;
}

function toOllamaToolCall(call: ToolCall): OllamaToolCall {
  const args = (call.args !== null && typeof call.args === 'object') ? (call.args as Record<string, unknown>) : {};
  return {
    id: call.id,
    function: { index: call.index, name: call.name, arguments: args },
  };
}

export function toOllamaTools(tools: JsonSchemaTool[]): OllamaJsonSchemaTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters as Record<string, unknown>,
    },
  }));
}

// ── Wire → dominio (response) ────────────────────────────────────────────────

let syntheticToolCallSeq = 0;

/** `id` existe desde v0.12.10; si un provider más viejo no lo manda, se sintetiza uno estable
 *  dentro del proceso para que ToolCall.id nunca quede vacío (ToolCallSchema lo exige). */
export function fromOllamaToolCall(call: OllamaToolCall, transport: ToolCall['transport']): ToolCall {
  const id = call.id ?? `synthetic-${(syntheticToolCallSeq += 1)}`;
  return {
    id,
    name: call.function.name,
    args: call.function.arguments,
    index: call.function.index,
    transport,
  };
}

export function mapCapabilities(caps: OllamaCapability[] | undefined): ModelCapabilities {
  const set = new Set(caps ?? []);
  return {
    tools: set.has('tools'),
    thinking: set.has('thinking'),
    vision: set.has('vision'),
    embedding: set.has('embedding'),
  };
}

/** Doc 13-centro-de-modelos.md §154: proxied-cloud si trae remote_host/remote_model o el tag
 *  contiene "cloud"; lan si el host del provider no es loopback; local en cualquier otro caso. */
export function classifyLocality(
  baseUrl: string,
  tag?: { remote_host?: string; remote_model?: string; name?: string },
): Locality {
  if (tag?.remote_host !== undefined || tag?.remote_model !== undefined || tag?.name?.includes('cloud') === true) {
    return 'proxied-cloud';
  }
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    host = '';
  }
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  return isLoopback ? 'local' : 'lan';
}

/** `<arch>.context_length` de model_info (doc 08 §2); cae a `details.context_length` de /api/tags
 *  si show() todavía no se llamó, y queda undefined si ninguno está disponible. */
export function extractContextMax(modelInfo: Record<string, unknown> | undefined, fallback?: number): number | undefined {
  if (modelInfo !== undefined) {
    const architecture = modelInfo['general.architecture'];
    if (typeof architecture === 'string') {
      const value = modelInfo[`${architecture}.context_length`];
      if (typeof value === 'number') return value;
    }
  }
  return fallback;
}

export function mapModelInfo(providerId: string, baseUrl: string, tag: OllamaTagModel): ModelInfo {
  const ref: ModelRef = { providerId, name: tag.name, locality: classifyLocality(baseUrl, tag) };
  return {
    ref,
    digest: tag.digest,
    sizeBytes: tag.size,
    family: tag.details?.family ?? '',
    parameterSize: tag.details?.parameter_size ?? '',
    quantization: tag.details?.quantization_level ?? '',
    capabilities: mapCapabilities(tag.capabilities),
    contextMax: extractContextMax(undefined, tag.details?.context_length),
    remoteHost: tag.remote_host,
  };
}

export function mapModelDescription(base: ModelInfo, show: OllamaShowResponse): ModelDescription {
  const modelInfo = show.model_info ?? {};
  return {
    ...base,
    capabilities: show.capabilities !== undefined ? mapCapabilities(show.capabilities) : base.capabilities,
    contextMax: extractContextMax(modelInfo, base.contextMax),
    modelInfo,
    template: show.template,
    parameters: show.parameters,
  };
}

export function mapLoadedModel(ps: OllamaPsModel): LoadedModel {
  return {
    name: ps.name,
    digest: ps.digest,
    size: ps.size,
    sizeVram: ps.size_vram,
    contextLength: ps.context_length,
    expiresAt: ps.expires_at,
  };
}
