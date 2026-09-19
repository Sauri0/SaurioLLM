// Provider: contrato de un backend de inferencia — packages/runtime/src/gateway/Provider.ts.
// Define: doc 04 §3. Solo interfaz (sin implementación); OllamaProvider vive en ./providers/ollama.
import type { ModelRef, Locality } from '@saurio/shared';
import type { ModelInfo, ModelDescription, LoadedModel, ChatRequest, ChatChunk, PullProgress } from './types.js';

/** Un Provider habla con UN backend de inferencia (Ollama, LM Studio, llama.cpp server, cloud).
 *  El Gateway es el único consumidor directo (regla de imports §2 de la columna); el ModelManager
 *  recibe la lista de providers() DEL GATEWAY, nunca instancia OllamaProvider por su cuenta. */
export interface Provider {
  readonly id: string;
  readonly kind: 'ollama' | 'openai-compat' | 'cloud';     // 'openai-compat' v0.2, 'cloud' v0.4
  readonly locality: Locality;

  health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string; error?: string }>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  describeModel(name: string): Promise<ModelDescription>;
  listLoaded?(signal?: AbortSignal): Promise<LoadedModel[]>; // /api/ps

  /** Streaming con abort real por request (ADR-2: el cliente ollama 0.6.3 no lo permite). */
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;

  load?(name: string, numCtx: number, keepAlive: string | number): Promise<{ loadMs: number }>;
  unload?(name: string): Promise<void>;                     // keep_alive: 0
  pull?(name: string, signal: AbortSignal): AsyncIterable<PullProgress>;   // v0.2
  delete?(name: string): Promise<void>;                     // v0.2
}

// ModelRef se re-exporta desde acá porque los archivos de providers concretos (ollama/openai-compat)
// suelen necesitarlo junto con Provider; evita un import extra a @saurio/shared en cada uno.
export type { ModelRef };
