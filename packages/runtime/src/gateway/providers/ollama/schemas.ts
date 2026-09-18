// Schemas zod espejo de la API de Ollama 0.34.1 — packages/runtime/src/gateway/providers/ollama/schemas.ts.
// Define: doc research-ollama.md (API verificada) — formas verbatim de `api/types.go` según ese
// documento. Estos schemas son del WIRE FORMAT de Ollama (nombres snake_case, forma real del JSON
// que viaja por HTTP); son intencionalmente distintos de los tipos de dominio de @saurio/shared
// (ChatMessage, ToolCall, ModelInfo, etc.) — mappers.ts traduce entre ambos mundos. No se importa
// nada de @saurio/shared acá para que este archivo pueda validarse solo contra la documentación de
// la API externa (regla de la tarea: "schemas zod espejo de la API").
import { z } from 'zod';

// ── /api/version ────────────────────────────────────────────────────────────
export const OllamaVersionResponseSchema = z.object({ version: z.string() });
export type OllamaVersionResponse = z.infer<typeof OllamaVersionResponseSchema>;

// ── /api/tags ────────────────────────────────────────────────────────────────
// Enum de capabilities [VERIFICADO: types/model/capability.go, research-ollama.md §1.2].
export const OllamaCapabilitySchema = z.enum([
  'completion', 'tools', 'insert', 'vision', 'embedding', 'thinking', 'image', 'audio',
]);
export type OllamaCapability = z.infer<typeof OllamaCapabilitySchema>;

export const OllamaModelDetailsSchema = z.object({
  parent_model: z.string().optional(),
  format: z.string().optional(),
  family: z.string().optional(),
  families: z.array(z.string()).optional(),
  parameter_size: z.string().optional(),
  quantization_level: z.string().optional(),
  // omitempty en ModelDetails [VERIFICADO: research-ollama.md §1.1]
  context_length: z.number().optional(),
  embedding_length: z.number().optional(),
});
export type OllamaModelDetails = z.infer<typeof OllamaModelDetailsSchema>;

export const OllamaTagModelSchema = z.object({
  name: z.string(),
  model: z.string().optional(),
  modified_at: z.string().optional(),
  size: z.number(),
  digest: z.string(),
  details: OllamaModelDetailsSchema.optional(),
  // `capabilities` existe en el struct Go pero es `omitempty`; puede faltar según versión/modelo
  // (doc research-ollama.md §1.1) — describeModel(/api/show) es la fuente autoritativa.
  capabilities: z.array(OllamaCapabilitySchema).optional(),
  remote_model: z.string().optional(),
  remote_host: z.string().optional(),
});
export type OllamaTagModel = z.infer<typeof OllamaTagModelSchema>;

export const OllamaTagsResponseSchema = z.object({ models: z.array(OllamaTagModelSchema) });
export type OllamaTagsResponse = z.infer<typeof OllamaTagsResponseSchema>;

// ── /api/show ────────────────────────────────────────────────────────────────
export const OllamaShowRequestSchema = z.object({ model: z.string(), verbose: z.boolean().optional() });
export type OllamaShowRequest = z.infer<typeof OllamaShowRequestSchema>;

export const OllamaShowResponseSchema = z.object({
  modelfile: z.string().optional(),
  parameters: z.string().optional(),
  template: z.string().optional(),
  system: z.string().optional(),
  renderer: z.string().optional(),
  parser: z.string().optional(),
  details: OllamaModelDetailsSchema.optional(),
  // model_info es un bag crudo cuyas claves cambian de prefijo según general.architecture
  // (doc 08 §2); se valida como record<string, unknown> y se interpreta en mappers.ts.
  model_info: z.record(z.string(), z.unknown()).optional(),
  projector_info: z.record(z.string(), z.unknown()).optional(),
  capabilities: z.array(OllamaCapabilitySchema).optional(),
  modified_at: z.string().optional(),
  remote_model: z.string().optional(),
  remote_host: z.string().optional(),
});
export type OllamaShowResponse = z.infer<typeof OllamaShowResponseSchema>;

// ── /api/ps ──────────────────────────────────────────────────────────────────
export const OllamaPsModelSchema = z.object({
  name: z.string(),
  model: z.string().optional(),
  size: z.number(),
  digest: z.string(),
  details: OllamaModelDetailsSchema.optional(),
  expires_at: z.string(),
  size_vram: z.number(),
  context_length: z.number(),
});
export type OllamaPsModel = z.infer<typeof OllamaPsModelSchema>;

export const OllamaPsResponseSchema = z.object({ models: z.array(OllamaPsModelSchema) });
export type OllamaPsResponse = z.infer<typeof OllamaPsResponseSchema>;

// ── /api/chat: request ────────────────────────────────────────────────────────
export const OllamaImageDataSchema = z.string(); // base64, sin prefijo data:
export const OllamaToolCallFunctionSchema = z.object({
  index: z.number().optional(),
  name: z.string(),
  // objeto JSON ya parseado, NO string [VERIFICADO: research-ollama.md §1.4]
  arguments: z.record(z.string(), z.unknown()),
});
export type OllamaToolCallFunction = z.infer<typeof OllamaToolCallFunctionSchema>;

export const OllamaToolCallSchema = z.object({
  id: z.string().optional(),
  function: OllamaToolCallFunctionSchema,
});
export type OllamaToolCall = z.infer<typeof OllamaToolCallSchema>;

export const OllamaMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  thinking: z.string().optional(),
  images: z.array(OllamaImageDataSchema).optional(),
  tool_calls: z.array(OllamaToolCallSchema).optional(),
  tool_name: z.string().optional(),
  tool_call_id: z.string().optional(),
});
export type OllamaMessage = z.infer<typeof OllamaMessageSchema>;

export const OllamaJsonSchemaToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }),
});
export type OllamaJsonSchemaTool = z.infer<typeof OllamaJsonSchemaToolSchema>;

export const OllamaThinkValueSchema = z.union([z.boolean(), z.enum(['low', 'medium', 'high', 'max'])]);
export type OllamaThinkValue = z.infer<typeof OllamaThinkValueSchema>;

/** `options` viaja como bag suelto en la API (doc: "map[string]any"); acá se tipan solo los campos
 *  que el runtime realmente manda (numCtx SIEMPRE explícito, ADR-7/condición 12.b) — el resto del
 *  bag de defaults de Ollama (num_batch, num_gpu, etc.) no lo tocamos desde SaurioLLM en el MVP. */
export const OllamaChatOptionsSchema = z.object({
  num_ctx: z.number(),
  temperature: z.number().optional(),
  num_predict: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  seed: z.number().optional(),
  stop: z.array(z.string()).optional(),
});
export type OllamaChatOptions = z.infer<typeof OllamaChatOptionsSchema>;

export const OllamaChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(OllamaMessageSchema),
  stream: z.boolean().optional(),
  format: z.union([z.literal('json'), z.record(z.string(), z.unknown())]).optional(),
  keep_alive: z.union([z.string(), z.number()]).optional(),
  tools: z.array(OllamaJsonSchemaToolSchema).optional(),
  options: OllamaChatOptionsSchema,
  think: OllamaThinkValueSchema.optional(),
  truncate: z.boolean().optional(),
  shift: z.boolean().optional(),
});
export type OllamaChatRequest = z.infer<typeof OllamaChatRequestSchema>;

// ── /api/chat: chunk de respuesta (stream y no-stream) ────────────────────────
// `done_reason` documentado: "stop" | "load" | "unload"; "length" no verificado en /api/chat
// (sólo en /v1) — se tipa como string abierto para no romper el parseo si el server lo agrega.
export const OllamaChatResponseChunkSchema = z.object({
  model: z.string().optional(),
  created_at: z.string().optional(),
  message: OllamaMessageSchema.optional(),
  done: z.boolean(),
  done_reason: z.string().optional(),
  total_duration: z.number().optional(),
  load_duration: z.number().optional(),
  prompt_eval_count: z.number().optional(),
  // nuevo en v0.33.3 ("cached prompt tokens reporting") [VERIFICADO: research-ollama.md §1.4]
  prompt_eval_cached_count: z.number().optional(),
  prompt_eval_duration: z.number().optional(),
  eval_count: z.number().optional(),
  eval_duration: z.number().optional(),
});
export type OllamaChatResponseChunk = z.infer<typeof OllamaChatResponseChunkSchema>;

/** Chunk de error a mitad de stream: HTTP ya en 200, el objeto NDJSON solo trae `error`
 *  [VERIFICADO: research-ollama.md §1 "Errores"]. */
export const OllamaErrorChunkSchema = z.object({ error: z.string() });
export type OllamaErrorChunk = z.infer<typeof OllamaErrorChunkSchema>;

/** Body de error de una respuesta HTTP no-200 (antes de empezar el stream). */
export const OllamaHttpErrorBodySchema = z.object({ error: z.string() });

// ── /api/pull (v0.2, doc 13 §5) ───────────────────────────────────────────────
// Cada línea NDJSON trae `status` ("pulling manifest" | "downloading <digest>" |
// "verifying sha256 digest" | "writing manifest" | "success" | ...), y durante "downloading"
// además `digest`/`total`/`completed` [VERIFICADO EN DOC OFICIAL: api.md, investigación 4 §3.3].
export const OllamaPullChunkSchema = z.object({
  status: z.string(),
  digest: z.string().optional(),
  total: z.number().optional(),
  completed: z.number().optional(),
});
export type OllamaPullChunk = z.infer<typeof OllamaPullChunkSchema>;

export const OllamaDeleteRequestSchema = z.object({ model: z.string() });
export type OllamaDeleteRequest = z.infer<typeof OllamaDeleteRequestSchema>;
