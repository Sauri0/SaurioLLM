// Model Gateway: tipos de chat/scheduler — packages/runtime/src/gateway/types.ts.
// Define: doc 04 §3. Solo interfaces/tipos (sin implementación); `Provider` vive en ./Provider.ts.
// ModelCapabilities/ModelInfo/ModelDescription/LoadedModel/MemoryEstimate/SlotStatus/QueuedJob
// tienen su schema zod en @saurio/shared (domain.ts) porque cruzan IPC (doc 02 §3, "dónde van los
// schemas zod compartidos"); acá se reexporta el tipo, no se redefine la forma.
import type {
  ModelRef, ModelCapabilities, ModelInfo, ModelDescription, LoadedModel, MemoryEstimate,
  ChatMessage, ToolCall, SlotStatus, QueuedJob, ResponseMetrics,
} from '@saurio/shared';

export type { ModelCapabilities, ModelInfo, ModelDescription, LoadedModel, MemoryEstimate, SlotStatus, QueuedJob, ResponseMetrics };

// ── Chat (request/response) ───────────────────────────────────────────────
export interface JsonSchemaTool { type: 'function'; function: { name: string; description: string; parameters: object } }

export interface ChatRequest {                // puro y serializable; se graba tal cual para eval/
  model: string; messages: ChatMessage[]; tools?: JsonSchemaTool[];
  options: {
    numCtx: number;                            // SIEMPRE explícito (condición 12.b); nunca se confía en el default del server
    temperature: number; numPredict: number; topP?: number; topK?: number; seed?: number; stop?: string[];
    /** Cambio aditivo (tarea "carga de modelo/oom_load"): capas del modelo a offloadear a GPU.
     *  `undefined` deja que Ollama decida solo (comportamiento previo); `RunController` lo baja
     *  automáticamente (~75% -> ~50% -> 0 = solo CPU) cuando el provider devuelve `oom_load`, doc
     *  16 "Cerrá lo que falta" punto 1. Mapeado a `num_gpu` en OllamaProvider. */
    numGpu?: number;
  };
  think?: boolean | 'low' | 'medium' | 'high' | 'max';
  format?: 'json' | object;                    // rescate de formato tras 2 fallos de parseo (columna §6.5)
  keepAlive?: string | number;
}

export interface ChatContext {
  runId: string; signal: AbortSignal; authorizedLocality: ModelRef['locality'][];
  priority: 'interactive' | 'subagent' | 'benchmark' | 'warmup';
}

export type ProviderErrorCode =
  | 'connection_refused' | 'stream_cut' | 'oom_load' | 'oom_generate' | 'model_not_found'
  | 'no_tools_support' | 'server_busy' | 'context_too_large' | 'timeout' | 'unknown'
  // Agregado de forma aditiva por providers/{openai-compat,anthropic}: 401/403 de una API con
  // clave — Ollama no tenía este caso (attach local sin auth) así que ningún código existente lo
  // cubría bien; degradarlo a 'unknown' le haría perder al host la distinción "revisá tu clave" vs.
  // "el modelo no existe" vs. "el server está caído".
  | 'invalid_api_key';

export type ChatChunk =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'error'; message: string; code?: ProviderErrorCode }
  | { type: 'done'; doneReason: string; metrics: ResponseMetrics };

export interface PullProgress { status: string; digest?: string; total?: number; completed?: number }   // v0.2

// ── ModelGateway y Scheduler ────────────────────────────────────────────────
/** Única puerta de inferencia (ADR-5): adquiere un slot al empezar chat() y lo libera en
 *  'done' | 'error' | abort. El AgentRuntime nunca ve el Scheduler ni el Provider directamente. */
export interface ModelGateway {
  chat(ref: ModelRef, req: ChatRequest, ctx: ChatContext): AsyncIterable<ChatChunk>;
  providers(): import('./Provider.js').Provider[];
  resolve(ref: ModelRef): import('./Provider.js').Provider;
  ensureLoaded(ref: ModelRef, numCtx: number): Promise<void>;   // precalentamiento, priority 'warmup'
  status(): { slots: SlotStatus[]; queue: QueuedJob[] };
}

/** Un lease de slot; el que lo obtiene es responsable de liberarlo (release) o dejar que
 *  el signal lo corte. Nombrado InferenceSlot en el brief de este documento — ver doc 04,
 *  Nomenclatura agregada. */
export interface SlotLease { readonly slotId: string; readonly ref: ModelRef; readonly acquiredAt: number }

/** Interno al Gateway; el AgentRuntime no lo importa directamente (regla de imports). */
export interface InferenceScheduler {
  acquire(ref: ModelRef, numCtx: number, priority: ChatContext['priority'], signal: AbortSignal): Promise<SlotLease>;
  release(lease: SlotLease): void;
  status(): { slots: SlotStatus[]; queue: QueuedJob[] };
}

/** settings.inference.slots por provider; 'auto' = 1 para local con VRAM < 24 GB [DECISIÓN DE DISEÑO]. */
export interface SchedulerConfig { slots: 'auto' | number; groupByModel: true }
