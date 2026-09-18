// Schemas zod espejo de la API pública de Anthropic (Messages) —
// packages/runtime/src/gateway/providers/anthropic/schemas.ts.
// Verificado contra la documentación oficial ANTES de escribir código [VERIFICADO EN DOC OFICIAL:
// platform.claude.com/docs/en/api/messages, .../build-with-claude/streaming y
// .../agents-and-tools/tool-use/overview, consultados el 2026-09-18 — docs.anthropic.com redirige
// 301 a platform.claude.com, mismo contenido]. No se importa nada de @saurio/shared acá (mismo
// criterio que providers/ollama|openai-compat/schemas.ts): son formas de WIRE puro.
import { z } from 'zod';

// ── Content blocks (request) ─────────────────────────────────────────────────
export const AnthropicTextBlockParamSchema = z.object({ type: z.literal('text'), text: z.string() });
export type AnthropicTextBlockParam = z.infer<typeof AnthropicTextBlockParamSchema>;

export const AnthropicToolUseBlockParamSchema = z.object({
  type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()),
});
export type AnthropicToolUseBlockParam = z.infer<typeof AnthropicToolUseBlockParamSchema>;

export const AnthropicToolResultBlockParamSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(AnthropicTextBlockParamSchema)]).optional(),
  is_error: z.boolean().optional(),
});
export type AnthropicToolResultBlockParam = z.infer<typeof AnthropicToolResultBlockParamSchema>;

export const AnthropicRequestContentBlockSchema = z.discriminatedUnion('type', [
  AnthropicTextBlockParamSchema, AnthropicToolUseBlockParamSchema, AnthropicToolResultBlockParamSchema,
]);
export type AnthropicRequestContentBlock = z.infer<typeof AnthropicRequestContentBlockSchema>;

export const AnthropicMessageParamSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(AnthropicRequestContentBlockSchema)]),
});
export type AnthropicMessageParam = z.infer<typeof AnthropicMessageParamSchema>;

export const AnthropicToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
});
export type AnthropicTool = z.infer<typeof AnthropicToolSchema>;

// `max_tokens` es obligatorio [VERIFICADO EN DOC OFICIAL: api/messages, "Required parameters"].
export const AnthropicRequestSchema = z.object({
  model: z.string(),
  max_tokens: z.number(),
  system: z.string().optional(),
  messages: z.array(AnthropicMessageParamSchema),
  tools: z.array(AnthropicToolSchema).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
});
export type AnthropicRequest = z.infer<typeof AnthropicRequestSchema>;

// ── Usage ──────────────────────────────────────────────────────────────────
export const AnthropicUsageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
});
export type AnthropicUsage = z.infer<typeof AnthropicUsageSchema>;

// ── Streaming SSE ─────────────────────────────────────────────────────────────
// [VERIFICADO EN DOC OFICIAL: build-with-claude/streaming, "Event types"] orden de eventos:
// message_start -> (content_block_start -> content_block_delta* -> content_block_stop)* ->
// message_delta+ -> message_stop; `ping` y `error` pueden aparecer en cualquier punto del stream.
export const AnthropicMessageStartEventSchema = z.object({
  type: z.literal('message_start'),
  message: z.looseObject({
    id: z.string(), role: z.string().optional(), model: z.string().optional(),
    usage: AnthropicUsageSchema.optional(),
  }),
});
export type AnthropicMessageStartEvent = z.infer<typeof AnthropicMessageStartEventSchema>;

// Bloques conocidos + un catch-all para bloques server-side (web_search_tool_result,
// server_tool_use, etc.) que este provider no interpreta — política de versionado de Anthropic:
// "your code should handle unknown event types gracefully" [VERIFICADO EN DOC OFICIAL].
export const AnthropicContentBlockUnionSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().optional() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()).optional() }),
  z.looseObject({ type: z.string() }),
]);

export const AnthropicContentBlockStartEventSchema = z.object({
  type: z.literal('content_block_start'), index: z.number(), content_block: AnthropicContentBlockUnionSchema,
});
export type AnthropicContentBlockStartEvent = z.infer<typeof AnthropicContentBlockStartEventSchema>;

export const AnthropicContentBlockDeltaSchema = z.union([
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
  z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
  z.object({ type: z.literal('signature_delta'), signature: z.string() }),
]);
export type AnthropicContentBlockDelta = z.infer<typeof AnthropicContentBlockDeltaSchema>;

export const AnthropicContentBlockDeltaEventSchema = z.object({
  type: z.literal('content_block_delta'), index: z.number(), delta: AnthropicContentBlockDeltaSchema,
});
export type AnthropicContentBlockDeltaEvent = z.infer<typeof AnthropicContentBlockDeltaEventSchema>;

export const AnthropicContentBlockStopEventSchema = z.object({ type: z.literal('content_block_stop'), index: z.number() });
export type AnthropicContentBlockStopEvent = z.infer<typeof AnthropicContentBlockStopEventSchema>;

/** El `usage` de `message_delta` es ACUMULATIVO, no incremental [VERIFICADO EN DOC OFICIAL:
 *  build-with-claude/streaming, warning explícito]. */
export const AnthropicMessageDeltaEventSchema = z.object({
  type: z.literal('message_delta'),
  delta: z.object({ stop_reason: z.string().nullable().optional(), stop_sequence: z.string().nullable().optional() }),
  usage: AnthropicUsageSchema.optional(),
});
export type AnthropicMessageDeltaEvent = z.infer<typeof AnthropicMessageDeltaEventSchema>;

export const AnthropicMessageStopEventSchema = z.object({ type: z.literal('message_stop') });
export const AnthropicPingEventSchema = z.object({ type: z.literal('ping') });

export const AnthropicErrorEventSchema = z.object({
  type: z.literal('error'),
  error: z.object({ type: z.string().optional(), message: z.string() }),
});
export type AnthropicErrorEvent = z.infer<typeof AnthropicErrorEventSchema>;

export const AnthropicStreamEventSchema = z.discriminatedUnion('type', [
  AnthropicMessageStartEventSchema, AnthropicContentBlockStartEventSchema, AnthropicContentBlockDeltaEventSchema,
  AnthropicContentBlockStopEventSchema, AnthropicMessageDeltaEventSchema, AnthropicMessageStopEventSchema,
  AnthropicPingEventSchema, AnthropicErrorEventSchema,
]);
export type AnthropicStreamEvent = z.infer<typeof AnthropicStreamEventSchema>;

// ── GET /v1/models ────────────────────────────────────────────────────────────
// [VERIFICADO EN DOC OFICIAL: api/models/list, 2026-09-18] — nunca se hardcodean ids de modelos.
export const AnthropicModelSchema = z.looseObject({
  type: z.literal('model').optional(),
  id: z.string(),
  display_name: z.string().optional(),
  created_at: z.string().optional(),
  max_input_tokens: z.number().nullable().optional(),
  max_tokens: z.number().nullable().optional(),
  capabilities: z.looseObject({
    thinking: z.looseObject({ supported: z.boolean() }).optional(),
    image_input: z.looseObject({ supported: z.boolean() }).optional(),
  }).nullable().optional(),
});
export type AnthropicModel = z.infer<typeof AnthropicModelSchema>;

export const AnthropicModelsResponseSchema = z.object({
  data: z.array(AnthropicModelSchema),
  has_more: z.boolean().optional(),
  first_id: z.string().nullable().optional(),
  last_id: z.string().nullable().optional(),
});
export type AnthropicModelsResponse = z.infer<typeof AnthropicModelsResponseSchema>;

// ── Errores (HTTP no-200, antes de empezar el stream) ────────────────────────
export const AnthropicErrorBodySchema = z.object({
  type: z.literal('error').optional(),
  error: z.object({ type: z.string().optional(), message: z.string() }),
});
export type AnthropicErrorBody = z.infer<typeof AnthropicErrorBodySchema>;
