// OllamaProvider: implementación de Provider para Ollama — packages/runtime/src/gateway/providers/ollama/provider.ts.
// Define: doc 04 §3 (interfaz Provider), doc 08-model-manager-y-scheduler.md §2 (qué endpoint da
// cada dato), doc 01-arquitectura.md §4.6 (MVP: solo /api/version, tags, show, ps, chat).
import type { Provider } from '../../Provider.js';
import type { ChatChunk, ChatRequest, ProviderErrorCode, PullProgress } from '../../types.js';
import type { ModelInfo, ModelDescription, LoadedModel, Locality, ResponseMetrics } from '@saurio/shared';
import { OllamaClient, OllamaHttpError } from './client.js';
import { isAbortError } from './errors.js';
import {
  toOllamaMessage, toOllamaTools, fromOllamaToolCall, mapModelInfo, mapModelDescription,
  mapLoadedModel, classifyLocality,
} from './mappers.js';
import type { OllamaChatRequest } from './schemas.js';

const nsToMs = (ns: number | undefined): number | undefined => (ns === undefined ? undefined : ns / 1_000_000);

export interface OllamaProviderOptions {
  id: string;
  baseUrl: string; // por defecto http://127.0.0.1:11434 (attach, doc 13 §85)
}

export class OllamaProvider implements Provider {
  readonly id: string;
  readonly kind = 'ollama' as const;
  locality: Locality;
  private client: OllamaClient;
  private baseUrl: string;

  constructor(opts: OllamaProviderOptions) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl;
    this.client = new OllamaClient(opts.baseUrl);
    this.locality = classifyLocality(opts.baseUrl);
  }

  /** El host cambia entre motor administrado y existente solamente cuando no hay trabajo activo. */
  setBaseUrl(baseUrl: string): void {
    if (baseUrl === this.baseUrl) return;
    this.baseUrl = baseUrl;
    this.client = new OllamaClient(baseUrl);
    this.locality = classifyLocality(baseUrl);
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string; error?: string }> {
    return this.client.health(signal);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const { models } = await this.client.tags(signal);
    return models.map((tag) => mapModelInfo(this.id, this.baseUrl, tag));
  }

  async describeModel(name: string): Promise<ModelDescription> {
    const [{ models }, show] = await Promise.all([
      this.client.tags(),
      this.client.show({ model: name, verbose: false }),
    ]);
    const tag = models.find((m) => m.name === name);
    const base: ModelInfo = tag !== undefined
      ? mapModelInfo(this.id, this.baseUrl, tag)
      : {
        ref: { providerId: this.id, name, locality: this.locality },
        digest: '',
        sizeBytes: 0,
        family: show.details?.family ?? '',
        parameterSize: show.details?.parameter_size ?? '',
        quantization: show.details?.quantization_level ?? '',
        capabilities: { tools: false, thinking: false, vision: false, embedding: false },
      };
    return mapModelDescription(base, show);
  }

  async listLoaded(signal?: AbortSignal): Promise<LoadedModel[]> {
    const { models } = await this.client.ps(signal);
    return models.map(mapLoadedModel);
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
    const wire: OllamaChatRequest = {
      model: req.model,
      messages: req.messages.map(toOllamaMessage),
      options: {
        num_ctx: req.options.numCtx,
        temperature: req.options.temperature,
        num_predict: req.options.numPredict,
        top_p: req.options.topP,
        top_k: req.options.topK,
        seed: req.options.seed,
        stop: req.options.stop,
        num_gpu: req.options.numGpu,
        num_thread: req.options.numThreads,
      },
    };
    if (req.tools !== undefined) wire.tools = toOllamaTools(req.tools);
    if (req.think !== undefined) wire.think = req.think;
    if (req.format !== undefined) wire.format = req.format === 'json' ? 'json' : (req.format as Record<string, unknown>);
    if (req.keepAlive !== undefined) wire.keep_alive = req.keepAlive;

    try {
      for await (const event of this.client.chat(wire, signal)) {
        if (event.kind === 'error') {
          yield { type: 'error', message: event.message, code: event.code };
          return;
        }
        const { chunk } = event;
        if (chunk.message?.thinking !== undefined && chunk.message.thinking.length > 0) {
          yield { type: 'thinking', text: chunk.message.thinking };
        }
        if (chunk.message?.content !== undefined && chunk.message.content.length > 0) {
          yield { type: 'content', text: chunk.message.content };
        }
        for (const call of chunk.message?.tool_calls ?? []) {
          yield { type: 'tool_call', call: fromOllamaToolCall(call, 'native') };
        }
        if (chunk.done) {
          const metrics: ResponseMetrics = {
            promptTokens: chunk.prompt_eval_count,
            cachedPromptTokens: chunk.prompt_eval_cached_count,
            evalTokens: chunk.eval_count,
            loadMs: nsToMs(chunk.load_duration),
            promptEvalMs: nsToMs(chunk.prompt_eval_duration),
            evalMs: nsToMs(chunk.eval_duration),
            totalMs: nsToMs(chunk.total_duration),
            quality: 'measured',
          };
          yield { type: 'done', doneReason: chunk.done_reason ?? 'stop', metrics };
        }
      }
    } catch (err) {
      if (isAbortError(err)) return; // cancelación limpia (doc 08 §7.5): sin ChatChunk de error
      const code: ProviderErrorCode = err instanceof OllamaHttpError ? err.code : 'unknown';
      const message = err instanceof Error ? err.message : String(err);
      yield { type: 'error', message, code };
    }
  }

  /** Precarga: `POST /api/chat` con `messages: []` (doc 08 §2, "Carga/descarga explícita").
   *  `load_duration` puede venir null al precargar con `messages: []` [COMPROBADO EN EQUIPO,
   *  ver notas de la tarea] — se usa wall time (`performance.now()`) como fallback siempre medido
   *  por SaurioLLM, nunca por el servidor. */
  async load(name: string, numCtx: number, keepAlive: string | number): Promise<{ loadMs: number }> {
    const startedAt = performance.now();
    const controller = new AbortController();
    let loadDurationMs: number | undefined;
    for await (const event of this.client.chat({
      model: name,
      messages: [],
      keep_alive: keepAlive,
      options: { num_ctx: numCtx },
    }, controller.signal)) {
      if (event.kind === 'error') {
        throw new OllamaHttpError(event.message, 0, event.code);
      }
      if (event.chunk.load_duration !== undefined) loadDurationMs = nsToMs(event.chunk.load_duration);
    }
    return { loadMs: loadDurationMs ?? (performance.now() - startedAt) };
  }

  /** Descarga forzada: `keep_alive: 0` (doc 08 §2, "Descarga forzada"). */
  async unload(name: string): Promise<void> {
    const controller = new AbortController();
    for await (const event of this.client.chat({
      model: name,
      messages: [],
      keep_alive: 0,
      options: { num_ctx: 2048 },
    }, controller.signal)) {
      if (event.kind === 'error') throw new OllamaHttpError(event.message, 0, event.code);
    }
  }

  /** `POST /api/pull` en streaming (doc 13 §5.2, v0.2): traduce el vocabulario propio de Ollama
   *  (`status: 'pulling manifest' | 'downloading' | 'verifying sha256 digest' | 'writing manifest' |
   *  'success'`) al `PullProgress` del Gateway (doc 04 §3). `DownloadManager` (packages/runtime/src/
   *  models/DownloadManager.ts) es quien agrega esto por capa/global; este método solo reexpone el
   *  stream normalizado. */
  async *pull(name: string, signal: AbortSignal): AsyncIterable<PullProgress> {
    for await (const chunk of this.client.pull(name, signal)) {
      yield { status: chunk.status, digest: chunk.digest, total: chunk.total, completed: chunk.completed };
    }
  }

  /** `DELETE /api/delete` (doc 13 §5.6, v0.2). */
  async delete(name: string): Promise<void> {
    await this.client.delete(name);
  }
}
