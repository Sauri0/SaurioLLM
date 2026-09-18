// Cliente HTTP de bajo nivel para la API de Anthropic — packages/runtime/src/gateway/providers/anthropic/client.ts.
// Habla directo con `/v1/models` y `/v1/messages`; no conoce tipos de dominio de @saurio/shared
// (eso es provider.ts vía mappers.ts) — mismo patrón que ../ollama/client.ts y ../openai-compat/client.ts.
// Nunca usa el SDK oficial de Anthropic: solo `fetch` nativo (regla de la tarea, "nada de SDKs").
import { parseSse } from './sse.js';
import { classifyErrorType, classifyFetchError, classifyHttpStatus, isAbortError, redact } from './errors.js';
import {
  AnthropicModelsResponseSchema, AnthropicStreamEventSchema, AnthropicErrorBodySchema,
  type AnthropicRequest, type AnthropicModelsResponse, type AnthropicStreamEvent,
} from './schemas.js';
import type { ProviderErrorCode } from '../../types.js';

export class AnthropicHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ProviderErrorCode,
  ) {
    super(message);
    this.name = 'AnthropicHttpError';
  }
}

export type AnthropicStreamResult =
  | { kind: 'event'; event: AnthropicStreamEvent }
  | { kind: 'error'; message: string; code: ProviderErrorCode };

/** `getApiKey` es un callback inyectado por el host (regla de seguridad de la tarea): la clave
 *  nunca se guarda en este cliente ni en el Provider — se resuelve just-in-time en cada request y
 *  no se retiene en ningún campo de instancia. */
export interface AnthropicClientOptions {
  baseUrl: string;
  getApiKey: () => Promise<string | undefined>;
  /** Por defecto `'2023-06-01'` [VERIFICADO EN DOC OFICIAL: api/messages, header `anthropic-version`]. */
  anthropicVersion?: string;
  headers?: Record<string, string>;
}

export class AnthropicClient {
  private readonly anthropicVersion: string;

  constructor(private readonly opts: AnthropicClientOptions) {
    this.anthropicVersion = opts.anthropicVersion ?? '2023-06-01';
  }

  /** Mismo cuidado que packages/runtime/src/gateway/providers/openai-compat/client.ts: `new
   *  URL(path, base)` con `path` absoluto ("/x") descarta cualquier sub-path de `base`, lo que
   *  rompería un proxy corporativo configurado con `baseUrl: "https://gateway.corp/anthropic"`. */
  private url(path: string): string {
    const base = this.opts.baseUrl.endsWith('/') ? this.opts.baseUrl : `${this.opts.baseUrl}/`;
    const rel = path.startsWith('/') ? path.slice(1) : path;
    return new URL(rel, base).toString();
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const apiKey = await this.opts.getApiKey();
    const headers: Record<string, string> = {
      'anthropic-version': this.anthropicVersion,
      ...this.opts.headers,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (apiKey !== undefined && apiKey.length > 0) headers['x-api-key'] = apiKey;

    let response: Response;
    try {
      response = await fetch(this.url(path), { ...init, headers, signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new AnthropicHttpError(redact(err instanceof Error ? err.message : String(err), apiKey), 0, classifyFetchError(err));
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      let message = bodyText;
      let errorType: string | undefined;
      const parsed = AnthropicErrorBodySchema.safeParse(safeJson(bodyText));
      if (parsed.success) {
        message = parsed.data.error.message;
        errorType = parsed.data.error.type;
      }
      const retryAfter = response.headers.get('retry-after');
      const code = classifyHttpStatus(response.status, errorType);
      const suffix = code === 'server_busy' && retryAfter !== null ? ` (retry-after: ${retryAfter}s)` : '';
      throw new AnthropicHttpError(redact((message || `HTTP ${response.status}`) + suffix, apiKey), response.status, code);
    }
    return response;
  }

  async listModels(signal?: AbortSignal): Promise<AnthropicModelsResponse> {
    const response = await this.request('/v1/models', { method: 'GET' }, signal);
    const json: unknown = await response.json();
    return AnthropicModelsResponseSchema.parse(json);
  }

  /** Streaming de `/v1/messages`. Los errores mid-stream llegan como evento SSE `event: error`
   *  con HTTP ya en 200 (p. ej. `overloaded_error` durante picos de uso) [VERIFICADO EN DOC
   *  OFICIAL: build-with-claude/streaming, "Error events"]. */
  async *messages(req: AnthropicRequest, signal: AbortSignal): AsyncGenerator<AnthropicStreamResult, void, unknown> {
    const apiKey = await this.opts.getApiKey();
    const response = await this.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...req, stream: true }),
    }, signal);
    if (response.body === null) {
      throw new AnthropicHttpError('respuesta de /v1/messages sin body', response.status, 'stream_cut');
    }
    let sawMessageStop = false;
    try {
      for await (const raw of parseSse(response.body, signal)) {
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          continue; // línea no-JSON — se ignora
        }
        const parsed = AnthropicStreamEventSchema.safeParse(json);
        if (!parsed.success) continue; // evento desconocido (política de versionado): se ignora con gracia
        if (parsed.data.type === 'error') {
          yield { kind: 'error', message: redact(parsed.data.error.message, apiKey), code: classifyErrorType(parsed.data.error.type) };
          return;
        }
        if (parsed.data.type === 'message_stop') sawMessageStop = true;
        yield { kind: 'event', event: parsed.data };
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new AnthropicHttpError(redact(err instanceof Error ? err.message : String(err), apiKey), 0, 'stream_cut');
    }
    if (!sawMessageStop) {
      yield { kind: 'error', message: 'el stream se cerró sin message_stop', code: 'stream_cut' };
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
