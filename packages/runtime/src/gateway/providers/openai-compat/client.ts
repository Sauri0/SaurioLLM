// Cliente HTTP de bajo nivel OpenAI-compatible — packages/runtime/src/gateway/providers/openai-compat/client.ts.
// Habla directo con `/v1/models` y `/v1/chat/completions`; no conoce tipos de dominio de
// @saurio/shared (eso es provider.ts vía mappers.ts) — mismo patrón que ../ollama/client.ts.
// Nunca usa un SDK: solo `fetch` nativo (regla de la tarea, "nada de SDKs").
import { parseSse } from './sse.js';
import { classifyErrorType, classifyFetchError, classifyHttpStatus, isAbortError, redact } from './errors.js';
import {
  OpenAIModelsResponseSchema, OpenAIChatChunkSchema, OpenAIErrorBodySchema,
  type OpenAIChatRequest, type OpenAIModelsResponse, type OpenAIChatChunk,
} from './schemas.js';
import type { ProviderErrorCode } from '../../types.js';

export class OpenAICompatHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ProviderErrorCode,
  ) {
    super(message);
    this.name = 'OpenAICompatHttpError';
  }
}

export type OpenAICompatStreamEvent =
  | { kind: 'chunk'; chunk: OpenAIChatChunk }
  | { kind: 'error'; message: string; code: ProviderErrorCode };

/** `getApiKey` es un callback inyectado por el host (regla de seguridad de la tarea): la clave
 *  nunca se guarda en este cliente ni en el Provider — se resuelve just-in-time en cada request y
 *  no se retiene en ningún campo de instancia. Es opcional porque motores locales (LM Studio,
 *  llama.cpp server, Jan) normalmente no requieren autenticación. */
export interface OpenAICompatClientOptions {
  baseUrl: string;
  getApiKey?: () => Promise<string | undefined>;
  /** Headers HTTP extra fijos — p. ej. `HTTP-Referer`/`X-Title` que OpenRouter recomienda para
   *  identificar la app en su dashboard [VERIFICADO EN DOC OFICIAL: openrouter.ai/docs]. */
  headers?: Record<string, string>;
}

export class OpenAICompatClient {
  constructor(private readonly opts: OpenAICompatClientOptions) {}

  /** `new URL(path, base)` con un `path` que empieza con "/" resuelve como ruta ABSOLUTA (descarta
   *  cualquier sub-path de `base`) — rompe baseUrl como `https://openrouter.ai/api`, donde perder el
   *  "/api" manda el request a la home page en vez de la API [COMPROBADO: request real contra
   *  OpenRouter devolvía el HTML del sitio, no JSON]. Se fuerza siempre una unión relativa. */
  private url(path: string): string {
    const base = this.opts.baseUrl.endsWith('/') ? this.opts.baseUrl : `${this.opts.baseUrl}/`;
    const rel = path.startsWith('/') ? path.slice(1) : path;
    return new URL(rel, base).toString();
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const apiKey = await this.opts.getApiKey?.();
    const authHeaders: Record<string, string> = { ...this.opts.headers };
    if (apiKey !== undefined && apiKey.length > 0) authHeaders.authorization = `Bearer ${apiKey}`;

    let response: Response;
    try {
      response = await fetch(this.url(path), {
        ...init,
        headers: { ...authHeaders, ...(init.headers as Record<string, string> | undefined) },
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new OpenAICompatHttpError(
        redact(err instanceof Error ? err.message : String(err), apiKey), 0, classifyFetchError(err),
      );
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      let message = bodyText;
      let errorType: string | undefined;
      const parsed = OpenAIErrorBodySchema.safeParse(safeJson(bodyText));
      if (parsed.success && parsed.data.error !== undefined) {
        message = parsed.data.error.message;
        errorType = parsed.data.error.type;
      }
      const retryAfter = response.headers.get('retry-after');
      let code = classifyHttpStatus(response.status);
      if (code === 'unknown' && errorType !== undefined) code = classifyErrorType(errorType);
      const suffix = code === 'server_busy' && retryAfter !== null ? ` (retry-after: ${retryAfter}s)` : '';
      throw new OpenAICompatHttpError(redact((message || `HTTP ${response.status}`) + suffix, apiKey), response.status, code);
    }
    return response;
  }

  async listModels(signal?: AbortSignal): Promise<OpenAIModelsResponse> {
    const response = await this.request('/v1/models', { method: 'GET' }, signal);
    const json: unknown = await response.json();
    return OpenAIModelsResponseSchema.parse(json);
  }

  /** Streaming de `/v1/chat/completions`. Un error puede llegar (a) como HTTP no-200 antes de
   *  empezar (manejado en `request()`) o (b) como un objeto `{"error": {...}}` a mitad de SSE en
   *  algunos proxies (LM Studio) que ya respondieron 200 — se distingue igual que en Ollama. */
  async *chatCompletions(req: OpenAIChatRequest, signal: AbortSignal): AsyncGenerator<OpenAICompatStreamEvent, void, unknown> {
    const apiKey = await this.opts.getApiKey?.();
    const response = await this.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...req, stream: true }),
    }, signal);
    if (response.body === null) {
      throw new OpenAICompatHttpError('respuesta de /v1/chat/completions sin body', response.status, 'stream_cut');
    }
    let sawDone = false;
    try {
      for await (const raw of parseSse(response.body, signal)) {
        if (raw === '[DONE]') {
          sawDone = true;
          break;
        }
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          continue; // línea no-JSON (comentario/keep-alive de algún proxy) — se ignora
        }
        const errorParse = OpenAIErrorBodySchema.safeParse(json);
        if (errorParse.success && errorParse.data.error !== undefined) {
          yield { kind: 'error', message: redact(errorParse.data.error.message, apiKey), code: classifyErrorType(errorParse.data.error.type) };
          return;
        }
        const chunk = OpenAIChatChunkSchema.parse(json);
        yield { kind: 'chunk', chunk };
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new OpenAICompatHttpError(redact(err instanceof Error ? err.message : String(err), apiKey), 0, 'stream_cut');
    }
    if (!sawDone) {
      yield { kind: 'error', message: 'el stream se cerró sin el centinela [DONE]', code: 'stream_cut' };
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
