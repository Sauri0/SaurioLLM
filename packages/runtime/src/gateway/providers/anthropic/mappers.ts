// Traducción entre el wire format de Anthropic y los tipos de dominio de @saurio/shared —
// packages/runtime/src/gateway/providers/anthropic/mappers.ts.
// Mismo criterio que providers/ollama|openai-compat/mappers.ts: ningún tipo de dominio se redefine
// acá. La diferencia estructural más grande frente a los otros dos providers es que Anthropic separa
// el system prompt del array `messages` (doc api/messages) y no tiene un rol `tool` propio: un
// resultado de tool se manda como bloque `tool_result` DENTRO de un mensaje `user`.
import type { ChatMessage, ToolCall, ModelInfo, ModelRef, Locality } from '@saurio/shared';
import type { JsonSchemaTool } from '../../types.js';
import type { AnthropicMessageParam, AnthropicRequestContentBlock, AnthropicTool, AnthropicModel } from './schemas.js';

/** `content_block.type === 'tool_use'` no alcanza para que TS reduzca el tipo: el schema de wire
 *  deja pasar bloques server-side desconocidos con `type: z.string()` (política de versionado de
 *  Anthropic), así que la unión inferida no puede excluir esa rama solo por comparación de string.
 *  Se valida `id`/`name` en runtime en vez de forzar un cast. */
export function isAnthropicToolUseBlock(block: unknown): block is { type: 'tool_use'; id: string; name: string } {
  return typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'tool_use'
    && typeof (block as { id?: unknown }).id === 'string'
    && typeof (block as { name?: unknown }).name === 'string';
}

// ── Dominio → wire (request) ─────────────────────────────────────────────────

/** Anthropic no acepta rol `system` dentro de `messages` (va aparte, campo `system` del request
 *  [VERIFICADO EN DOC OFICIAL: api/messages]) y no tiene rol `tool`: un `ChatMessage` con
 *  `role: 'tool'` se traduce a un bloque `tool_result` dentro de un mensaje `user`, agrupando
 *  tool_results consecutivos en un único mensaje (requerido cuando el turno anterior pidió varios
 *  tool calls en paralelo — Anthropic espera todos los `tool_result` de ese turno juntos). */
export function toAnthropicRequest(messages: ChatMessage[]): { system?: string; messages: AnthropicMessageParam[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (msg.content.length > 0) systemParts.push(msg.content);
      continue;
    }
    if (msg.role === 'tool') {
      const block: AnthropicRequestContentBlock = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId ?? '',
        content: msg.content,
        // ChatMessage (dominio) no lleva un campo `isError` para resultados de tool — solo
        // `ToolResult` (tipo persistido, distinto) lo tiene; no se inventa acá (ver doc 18-proveedores.md,
        // limitación documentada). `is_error` queda sin mandar (Anthropic lo trata como no-error).
      };
      const last = out[out.length - 1];
      if (last !== undefined && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    // user | assistant: si no hay tool_use que agregar, se manda `content` como string plano
    // (forma más simple, la que usa el propio ejemplo básico de la doc oficial: `"content": "Hello,
    // Claude"`); el array de bloques solo se arma cuando hace falta describir un tool_use.
    if (msg.role !== 'assistant' || msg.toolCalls === undefined || msg.toolCalls.length === 0) {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks: AnthropicRequestContentBlock[] = [];
    if (msg.content.length > 0) blocks.push({ type: 'text', text: msg.content });
    for (const call of msg.toolCalls) {
      const input = (call.args !== null && typeof call.args === 'object') ? (call.args as Record<string, unknown>) : {};
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
    }
    out.push({ role: msg.role, content: blocks });
  }

  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: out };
}

export function toAnthropicTools(tools: JsonSchemaTool[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Record<string, unknown>,
  }));
}

// ── Wire → dominio (response) ────────────────────────────────────────────────

/** Acumulador de un `tool_use` cuyo `input` llega fragmentado en varios `input_json_delta` — se
 *  resuelve recién en `content_block_stop` porque `ToolCall.args` del dominio exige el objeto YA
 *  parseado (mismo criterio que providers/openai-compat/mappers.ts, PendingToolCall). */
export interface PendingToolUse { id: string; name: string; args: string }

export function fromAnthropicToolUse(buf: PendingToolUse): ToolCall {
  let args: unknown = {};
  if (buf.args.trim().length > 0) {
    try {
      args = JSON.parse(buf.args);
    } catch {
      args = {}; // JSON parcial corrupto — nunca se inventa un valor parcial
    }
  }
  return { id: buf.id, name: buf.name, args, transport: 'native' };
}

/** doc 08 §8: `capabilities.tools = true` es una asunción documentada (casi todos los modelos
 *  Claude vigentes soportan tool use), no una medición — `/v1/models` no expone un flag `tools`
 *  explícito en `capabilities` [VERIFICADO EN DOC OFICIAL: api/models/list, 2026-09-18: los campos
 *  son batch/citations/code_execution/context_management/effort/image_input/pdf_input/
 *  structured_outputs/thinking — ninguno es "tool_use"]. `thinking`/`vision` SÍ salen de datos
 *  reales (`capabilities.thinking.supported`/`capabilities.image_input.supported`); `embedding`
 *  siempre `false` (Anthropic no ofrece modelos de embedding vía Messages API). `contextMax` sale
 *  de `max_input_tokens`, medido y real. */
export function mapModelInfo(providerId: string, locality: Locality, model: AnthropicModel): ModelInfo {
  const ref: ModelRef = { providerId, name: model.id, locality };
  return {
    ref,
    digest: '',
    sizeBytes: 0,
    family: '',
    parameterSize: '',
    quantization: '',
    capabilities: {
      tools: true,
      thinking: model.capabilities?.thinking?.supported ?? false,
      vision: model.capabilities?.image_input?.supported ?? false,
      embedding: false,
    },
    contextMax: model.max_input_tokens ?? undefined,
  };
}
