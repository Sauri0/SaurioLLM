// AnthropicProvider: implementación de Provider para la API de Anthropic (Claude) —
// packages/runtime/src/gateway/providers/anthropic/provider.ts.
// Contrato verificado contra la documentación oficial antes de escribir (ver schemas.ts, cabecera).
import type { Provider } from '../../Provider.js';
import type { ChatChunk, ChatRequest, ProviderErrorCode } from '../../types.js';
import type { ModelInfo, ModelDescription, Locality, ResponseMetrics, ToolCall } from '@saurio/shared';
import { AnthropicClient, AnthropicHttpError } from './client.js';
import { isAbortError } from './errors.js';
import { toAnthropicRequest, toAnthropicTools, mapModelInfo, fromAnthropicToolUse, isAnthropicToolUseBlock, type PendingToolUse } from './mappers.js';
import type { AnthropicRequest, AnthropicUsage } from './schemas.js';

export interface AnthropicProviderOptions {
  id: string;
  /** Por defecto `https://api.anthropic.com`. */
  baseUrl?: string;
  /** Callback inyectado por el host; nunca se guarda la clave resuelta (regla de seguridad de la
   *  tarea) — el host es responsable del almacén seguro de claves. */
  getApiKey: () => Promise<string | undefined>;
  anthropicVersion?: string;
  headers?: Record<string, string>;
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly kind = 'cloud' as const;
  // La API pública de Anthropic no tiene despliegue local/LAN (a diferencia de OpenAI-compatible,
  // que sirve tanto a OpenAI real como a motores locales) — siempre es 'cloud'; el Gateway nunca
  // hace fallback local -> nube (doc 01 §4.5), así que esta constante es lo que activa esa regla.
  readonly locality: Locality = 'cloud';
  private readonly client: AnthropicClient;

  constructor(opts: AnthropicProviderOptions) {
    this.id = opts.id;
    this.client = new AnthropicClient({
      baseUrl: opts.baseUrl ?? 'https://api.anthropic.com',
      getApiKey: opts.getApiKey,
      anthropicVersion: opts.anthropicVersion,
      headers: opts.headers,
    });
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
    const data = await this.client.listAllModels(signal);
    return data.map((m) => mapModelInfo(this.id, this.locality, m));
  }

  async describeModel(name: string): Promise<ModelDescription> {
    const data = await this.client.listAllModels();
    const model = data.find((m) => m.id === name);
    const base: ModelInfo = model !== undefined
      ? mapModelInfo(this.id, this.locality, model)
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

  // listLoaded/load/unload/pull: no aplican. Anthropic no tiene concepto de modelo cargado/descargado
  // ni `keep_alive` (es un servicio gestionado, no un proceso con VRAM que administrar) — se dejan
  // sin implementar para que el ModelManager/telemetría reciban "no disponible" (mismo criterio que
  // OpenAICompatProvider, doc 08 §8).

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
    const { system, messages } = toAnthropicRequest(req.messages);
    const wire: AnthropicRequest = {
      model: req.model,
      max_tokens: req.options.numPredict,
      messages,
      temperature: req.options.temperature,
    };
    if (system !== undefined) wire.system = system;
    if (req.options.topP !== undefined) wire.top_p = req.options.topP;
    if (req.options.topK !== undefined) wire.top_k = req.options.topK;
    if (req.options.stop !== undefined) wire.stop_sequences = req.options.stop;
    if (req.tools !== undefined) wire.tools = toAnthropicTools(req.tools);

    const toolBuffers = new Map<number, PendingToolUse>();
    let usage: AnthropicUsage = {};
    let stopReason: string | undefined;

    try {
      for await (const result of this.client.messages(wire, signal)) {
        if (result.kind === 'error') {
          yield { type: 'error', message: result.message, code: result.code };
          return;
        }
        const event = result.event;
        switch (event.type) {
          case 'message_start':
            if (event.message.usage !== undefined) usage = { ...usage, ...event.message.usage };
            break;
          case 'content_block_start':
            if (isAnthropicToolUseBlock(event.content_block)) {
              toolBuffers.set(event.index, { id: event.content_block.id, name: event.content_block.name, args: '' });
            }
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { type: 'content', text: event.delta.text };
            } else if (event.delta.type === 'thinking_delta') {
              yield { type: 'thinking', text: event.delta.thinking };
            } else if (event.delta.type === 'input_json_delta') {
              const buf = toolBuffers.get(event.index);
              if (buf !== undefined) buf.args += event.delta.partial_json;
            }
            // signature_delta: sin contraparte en ChatChunk — se ignora a propósito.
            break;
          case 'content_block_stop': {
            const buf = toolBuffers.get(event.index);
            if (buf !== undefined) {
              const call: ToolCall = fromAnthropicToolUse(buf);
              yield { type: 'tool_call', call };
              toolBuffers.delete(event.index);
            }
            break;
          }
          case 'message_delta':
            if (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null) stopReason = event.delta.stop_reason;
            // El usage de message_delta es acumulativo (doc oficial) — se puede sobrescribir tal cual.
            if (event.usage !== undefined) usage = { ...usage, ...event.usage };
            break;
          case 'message_stop':
          case 'ping':
            break;
        }
      }
    } catch (err) {
      if (isAbortError(err)) return; // cancelación limpia: sin ChatChunk de error (mismo criterio que Ollama)
      const code: ProviderErrorCode = err instanceof AnthropicHttpError ? err.code : 'unknown';
      yield { type: 'error', message: err instanceof Error ? err.message : String(err), code };
      return;
    }

    const metrics: ResponseMetrics = {
      promptTokens: usage.input_tokens,
      cachedPromptTokens: usage.cache_read_input_tokens,
      evalTokens: usage.output_tokens,
      // doc 08 §8 (mismo criterio extendido a Anthropic): sin duraciones de carga/prompt/generación
      // — nunca 'measured' aunque input_tokens/output_tokens sean conteos exactos, porque la
      // calidad describe el objeto completo y acá no hay tok/s medible del lado servidor.
      quality: 'estimated',
    };
    // doneReason se pasa tal cual llega de Anthropic (end_turn/max_tokens/tool_use/stop_sequence)
    // sin remapear a vocabulario de Ollama — mismo criterio que OllamaProvider (chunk.done_reason
    // pasa directo): ChatChunk.done.doneReason es `string` abierto, no un enum compartido.
    yield { type: 'done', doneReason: stopReason ?? 'end_turn', metrics };
  }
}
