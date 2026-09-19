// OpenAICompatProvider: implementación de Provider para servidores OpenAI-compatible —
// packages/runtime/src/gateway/providers/openai-compat/provider.ts.
// Sirve para OpenAI, OpenRouter, Groq y motores locales LM Studio / llama.cpp server / vLLM / Jan
// (doc 08-model-manager-y-scheduler.md §8, tabla de degradación frente a Ollama).
import type { Provider } from '../../Provider.js';
import type { ChatChunk, ChatRequest, ProviderErrorCode } from '../../types.js';
import type { ModelInfo, ModelDescription, Locality, ResponseMetrics, ToolCall } from '@saurio/shared';
import { OpenAICompatClient, OpenAICompatHttpError } from './client.js';
import { isAbortError } from './errors.js';
import {
  toOpenAIChatRequest, classifyLocality, mapModelInfo, mapOpenRouterModelInfo,
  isOfficialOpenRouterBaseUrl, fromOpenAIToolCallDelta, type PendingToolCall,
} from './mappers.js';
import type { OpenAIUsage } from './schemas.js';

export interface OpenAICompatProviderOptions {
  id: string;
  baseUrl: string;
  /** Callback inyectado por el host; nunca se guarda la clave resuelta (regla de seguridad de la
   *  tarea). Omitible para motores locales sin autenticación. */
  getApiKey?: () => Promise<string | undefined>;
  /** Headers HTTP extra fijos (p. ej. `HTTP-Referer`/`X-Title` de OpenRouter). */
  headers?: Record<string, string>;
}

export class OpenAICompatProvider implements Provider {
  readonly id: string;
  readonly kind = 'openai-compat' as const;
  readonly locality: Locality;
  private readonly client: OpenAICompatClient;
  private readonly isOfficialOpenRouter: boolean;

  constructor(opts: OpenAICompatProviderOptions) {
    this.id = opts.id;
    this.locality = classifyLocality(opts.baseUrl);
    this.isOfficialOpenRouter = isOfficialOpenRouterBaseUrl(opts.baseUrl);
    this.client = new OpenAICompatClient({ baseUrl: opts.baseUrl, getApiKey: opts.getApiKey, headers: opts.headers });
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      await this.client.listModels(signal);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { data } = await this.client.listModels(signal);
    const metadataCheckedAt = Date.now();
    return data.map((model) => this.isOfficialOpenRouter
      ? mapOpenRouterModelInfo(this.id, this.locality, model, metadataCheckedAt)
      : mapModelInfo(this.id, this.locality, model));
  }

  async describeModel(name: string): Promise<ModelDescription> {
    const { data } = await this.client.listModels();
    const model = data.find((m) => m.id === name);
    const base: ModelInfo = model !== undefined
      ? (this.isOfficialOpenRouter
        ? mapOpenRouterModelInfo(this.id, this.locality, model, Date.now())
        : mapModelInfo(this.id, this.locality, model))
      : {
        ref: { providerId: this.id, name, locality: this.locality },
        digest: '',
        sizeBytes: 0,
        family: '',
        parameterSize: '',
        quantization: '',
        capabilities: { tools: true, thinking: false, vision: false, embedding: false },
      };
    return { ...base, modelInfo: model ?? {} };
  }

  // listLoaded/load/unload/pull: no aplican (doc 08 §8, "Providers no-Ollama"). No hay `/api/ps`
  // equivalente ni concepto estándar de `keep_alive` en `/v1` — se dejan sin implementar a
  // propósito para que el ModelManager y la telemetría reciban "no disponible" (mismo patrón que
  // ya usa ModelGateway.ensureLoaded con `provider.load === undefined`), en vez de simular un
  // estado que esta API no puede dar.

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
    const wire = toOpenAIChatRequest(req);
    const pendingToolCalls = new Map<number, PendingToolCall>();
    let usage: OpenAIUsage | undefined;
    let doneReason: string | undefined;

    try {
      for await (const event of this.client.chatCompletions(wire, signal)) {
        if (event.kind === 'error') {
          yield { type: 'error', message: event.message, code: event.code };
          return;
        }
        const { chunk } = event;
        if (chunk.usage !== undefined) usage = chunk.usage;
        for (const choice of chunk.choices) {
          if (choice.delta.content !== undefined && choice.delta.content !== null && choice.delta.content.length > 0) {
            yield { type: 'content', text: choice.delta.content };
          }
          for (const delta of choice.delta.tool_calls ?? []) {
            const entry = pendingToolCalls.get(delta.index) ?? { args: '' };
            if (delta.id !== undefined) entry.id = delta.id;
            if (delta.function?.name !== undefined) entry.name = delta.function.name;
            if (delta.function?.arguments !== undefined) entry.args += delta.function.arguments;
            pendingToolCalls.set(delta.index, entry);
          }
          if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
            doneReason = choice.finish_reason;
          }
        }
      }
    } catch (err) {
      if (isAbortError(err)) return; // cancelación limpia: sin ChatChunk de error (mismo criterio que Ollama)
      const code: ProviderErrorCode = err instanceof OpenAICompatHttpError ? err.code : 'unknown';
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message, code };
      return;
    }

    // Los tool calls se emiten recién acá, ya reensamblados: `ToolCall.args` del dominio exige el
    // objeto YA parseado (nunca un fragmento de JSON parcial de un `input_json_delta`-equivalente).
    for (const [index, entry] of pendingToolCalls) {
      const call: ToolCall = fromOpenAIToolCallDelta(index, entry);
      yield { type: 'tool_call', call };
    }

    const metrics: ResponseMetrics = {
      promptTokens: usage?.prompt_tokens,
      cachedPromptTokens: usage?.prompt_tokens_details?.cached_tokens,
      evalTokens: usage?.completion_tokens,
      // doc 08 §8: sin duraciones separadas de carga/prompt/generación en `/v1` — nunca se etiqueta
      // `measured` aunque los conteos de tokens de `usage` sean exactos, porque la calidad describe
      // el objeto completo (tok/s solo puede salir del reloj de cliente, mezclando TTFT y generación).
      quality: 'estimated',
    };
    if (this.isOfficialOpenRouter && usage?.cost !== undefined) {
      // Cero es un costo válido (p. ej. modelo gratuito): por eso se chequea contra undefined.
      metrics.costUsd = usage.cost;
      metrics.costSource = 'reported';
    } else {
      metrics.costSource = 'unavailable';
    }
    yield { type: 'done', doneReason: doneReason ?? 'stop', metrics };
  }
}
