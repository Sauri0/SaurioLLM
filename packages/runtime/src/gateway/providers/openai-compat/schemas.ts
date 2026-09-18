// Schemas zod espejo de la API OpenAI-compatible (chat completions) — packages/runtime/src/gateway/providers/openai-compat/schemas.ts.
// Sirve para OpenAI, OpenRouter, Groq y motores locales LM Studio / llama.cpp server / vLLM / Jan,
// que implementan (con variaciones menores) el mismo shape público documentado en
// platform.openai.com/docs/api-reference/chat. No se importa nada de @saurio/shared acá (mismo
// criterio que providers/ollama/schemas.ts): son formas de WIRE puro, snake_case; mappers.ts traduce
// hacia/desde los tipos de dominio.
import { z } from 'zod';

// ── GET /v1/models ────────────────────────────────────────────────────────────
// El shape exacto varía por servidor (vLLM/LM Studio agregan campos propios de contexto máximo con
// nombres distintos); se valida lo que todos los servidores conocidos devuelven y se deja pasar el
// resto sin interpretarlo campo por campo (`.loose()`).
export const OpenAIModelSchema = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  created: z.number().optional(),
  owned_by: z.string().optional(),
  // nombres alternativos de contexto máximo observados en distintos servidores /v1 — ninguno es
  // parte del estándar OpenAI (que no expone contextMax en absoluto); mappers.ts intenta los tres.
  context_length: z.number().optional(),
  max_model_len: z.number().optional(),
  max_context_length: z.number().optional(),
});
export type OpenAIModel = z.infer<typeof OpenAIModelSchema>;

export const OpenAIModelsResponseSchema = z.object({
  object: z.string().optional(),
  data: z.array(OpenAIModelSchema),
});
export type OpenAIModelsResponse = z.infer<typeof OpenAIModelsResponseSchema>;

// ── /v1/chat/completions: request ────────────────────────────────────────────
export const OpenAIContentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }) }),
]);
export type OpenAIContentPart = z.infer<typeof OpenAIContentPartSchema>;

export const OpenAIMessageToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
export type OpenAIMessageToolCall = z.infer<typeof OpenAIMessageToolCallSchema>;

export const OpenAIMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(OpenAIContentPartSchema), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(OpenAIMessageToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});
export type OpenAIMessage = z.infer<typeof OpenAIMessageSchema>;

export const OpenAIJsonSchemaToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }),
});
export type OpenAIJsonSchemaTool = z.infer<typeof OpenAIJsonSchemaToolSchema>;

export const OpenAIChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(OpenAIMessageSchema),
  tools: z.array(OpenAIJsonSchemaToolSchema).optional(),
  stream: z.boolean().optional(),
  // include_usage: pedido siempre por este provider; si el servidor no lo soporta, ignora el campo
  // (no rompe el request) y simplemente no manda `usage` — degradación documentada en doc 08 §8.
  stream_options: z.object({ include_usage: z.boolean() }).optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  max_tokens: z.number().optional(),
  seed: z.number().optional(),
  stop: z.array(z.string()).optional(),
});
export type OpenAIChatRequest = z.infer<typeof OpenAIChatRequestSchema>;

// ── /v1/chat/completions: chunk de stream (SSE `data: {...}`) ────────────────
export const OpenAIUsageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
  prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
});
export type OpenAIUsage = z.infer<typeof OpenAIUsageSchema>;

/** Delta de un tool_call dentro de un chunk de stream; `index` identifica la posición del tool call
 *  DENTRO del array de tool_calls del mensaje (no el índice del choice) — es la clave para acumular
 *  fragmentos partidos entre varios eventos SSE [VERIFICADO EN DOC OFICIAL: platform.openai.com,
 *  "Function calling" streaming]. */
export const OpenAIToolCallDeltaSchema = z.object({
  index: z.number(),
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().optional(),
    arguments: z.string().optional(),
  }).optional(),
});
export type OpenAIToolCallDelta = z.infer<typeof OpenAIToolCallDeltaSchema>;

export const OpenAIChatChunkDeltaSchema = z.object({
  role: z.string().optional(),
  content: z.string().nullable().optional(),
  tool_calls: z.array(OpenAIToolCallDeltaSchema).optional(),
});
export type OpenAIChatChunkDelta = z.infer<typeof OpenAIChatChunkDeltaSchema>;

export const OpenAIChatChunkChoiceSchema = z.object({
  index: z.number(),
  delta: OpenAIChatChunkDeltaSchema,
  finish_reason: z.string().nullable().optional(),
});
export type OpenAIChatChunkChoice = z.infer<typeof OpenAIChatChunkChoiceSchema>;

/** El último chunk cuando se pidió `stream_options.include_usage` trae `choices: []` y solo
 *  `usage` [VERIFICADO EN DOC OFICIAL: platform.openai.com/docs/api-reference/chat-streaming]. */
export const OpenAIChatChunkSchema = z.object({
  id: z.string().optional(),
  object: z.string().optional(),
  created: z.number().optional(),
  model: z.string().optional(),
  choices: z.array(OpenAIChatChunkChoiceSchema),
  usage: OpenAIUsageSchema.optional(),
});
export type OpenAIChatChunk = z.infer<typeof OpenAIChatChunkSchema>;

// ── Errores ────────────────────────────────────────────────────────────────
export const OpenAIErrorBodySchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(),
  }).optional(),
});
export type OpenAIErrorBody = z.infer<typeof OpenAIErrorBodySchema>;
