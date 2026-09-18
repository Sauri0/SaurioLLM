// Cliente HTTP de bajo nivel para Ollama — packages/runtime/src/gateway/providers/ollama/client.ts.
// Define: ADR-2 de la columna vertebral (fetch nativo + NDJSON propio, nunca el cliente npm `ollama`
// porque `ollama.abort()` corta TODOS los streams en curso en vez de uno por request — investigación
// research-ollama.md §5). Habla directo con `/api/version|tags|show|ps|chat`; no conoce tipos de
// dominio de @saurio/shared (eso es provider.ts vía mappers.ts).
import { parseNdjson } from './ndjson.js';
import { classifyErrorMessage, classifyFetchError, isAbortError, refineOomCode } from './errors.js';
import {
  OllamaVersionResponseSchema, OllamaTagsResponseSchema, OllamaShowResponseSchema,
  OllamaPsResponseSchema, OllamaChatResponseChunkSchema, OllamaErrorChunkSchema,
  OllamaPullChunkSchema,
  type OllamaChatRequest, type OllamaVersionResponse, type OllamaTagsResponse,
  type OllamaShowResponse, type OllamaPsResponse, type OllamaChatResponseChunk, type OllamaShowRequest,
  type OllamaPullChunk,
} from './schemas.js';
import type { ProviderErrorCode } from '../../types.js';

export class OllamaHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ProviderErrorCode,
  ) {
    super(message);
    this.name = 'OllamaHttpError';
  }
}

/** Chunk NDJSON de stream de `/api/chat`, ya distinguido entre error y respuesta normal — el
 *  provider.ts normaliza esto a `ChatChunk` (tipo del Gateway). */
export type OllamaStreamEvent =
  | { kind: 'chunk'; chunk: OllamaChatResponseChunk }
  | { kind: 'error'; message: string; code: ProviderErrorCode };

export class OllamaClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.url(path), { ...init, signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new OllamaHttpError(err instanceof Error ? err.message : String(err), 0, classifyFetchError(err));
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      let message = bodyText;
      try {
        const parsed = JSON.parse(bodyText) as { error?: string };
        if (typeof parsed.error === 'string') message = parsed.error;
      } catch {
        // body no era JSON; se usa el texto crudo como mensaje
      }
      const code: ProviderErrorCode = response.status === 404
        ? 'model_not_found'
        : (response.status === 429 || response.status === 503)
          ? 'server_busy'
          : classifyErrorMessage(message);
      throw new OllamaHttpError(message || `HTTP ${response.status}`, response.status, code);
    }
    return response;
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const response = await this.request('/api/version', { method: 'GET' }, signal);
      const json: unknown = await response.json();
      const parsed: OllamaVersionResponse = OllamaVersionResponseSchema.parse(json);
      return { ok: true, version: parsed.version };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async tags(signal?: AbortSignal): Promise<OllamaTagsResponse> {
    const response = await this.request('/api/tags', { method: 'GET' }, signal);
    const json: unknown = await response.json();
    return OllamaTagsResponseSchema.parse(json);
  }

  async show(req: OllamaShowRequest, signal?: AbortSignal): Promise<OllamaShowResponse> {
    const response = await this.request('/api/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    }, signal);
    const json: unknown = await response.json();
    return OllamaShowResponseSchema.parse(json);
  }

  async ps(signal?: AbortSignal): Promise<OllamaPsResponse> {
    const response = await this.request('/api/ps', { method: 'GET' }, signal);
    const json: unknown = await response.json();
    return OllamaPsResponseSchema.parse(json);
  }

  /** Streaming de `/api/chat`. Un chunk NDJSON puede traer `{"error": "..."}` a mitad de stream con
   *  HTTP ya en 200 (doc research-ollama.md §1 "Errores") — se distingue probando el schema de error
   *  antes que el de chunk normal. `hadContent` permite reclasificar OOM de carga vs de generación. */
  async *chat(req: OllamaChatRequest, signal: AbortSignal): AsyncGenerator<OllamaStreamEvent, void, unknown> {
    const response = await this.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...req, stream: true }),
    }, signal);
    if (response.body === null) {
      throw new OllamaHttpError('respuesta de /api/chat sin body', response.status, 'stream_cut');
    }
    let hadContent = false;
    let sawDone = false;
    try {
      for await (const raw of parseNdjson(response.body, signal)) {
        const errorParse = OllamaErrorChunkSchema.safeParse(raw);
        if (errorParse.success) {
          const code = refineOomCode(classifyErrorMessage(errorParse.data.error), hadContent);
          yield { kind: 'error', message: errorParse.data.error, code };
          return;
        }
        const chunk = OllamaChatResponseChunkSchema.parse(raw);
        if ((chunk.message?.content ?? '').length > 0 || (chunk.message?.tool_calls?.length ?? 0) > 0) {
          hadContent = true;
        }
        if (chunk.done) sawDone = true;
        yield { kind: 'chunk', chunk };
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new OllamaHttpError(err instanceof Error ? err.message : String(err), 0, 'stream_cut');
    }
    if (!sawDone) {
      // La conexión se cerró sin un chunk final done:true — corte de stream real, no cancelación
      // (una cancelación real lanza AbortError, ya manejado arriba).
      yield { kind: 'error', message: 'el stream se cerró sin un chunk final done:true', code: 'stream_cut' };
    }
  }

  /** Streaming de `/api/pull` (doc 13 §5.2, v0.2). Mismo patrón NDJSON que `chat()`: una línea de
   *  error a mitad de stream ({"error": "..."}) es posible con HTTP ya en 200. Sin `AbortSignal`
   *  propio no habría cancelación real por request (ADR-2, mismo motivo que `chat()`). */
  async *pull(model: string, signal: AbortSignal): AsyncGenerator<OllamaPullChunk, void, unknown> {
    const response = await this.request('/api/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
    }, signal);
    if (response.body === null) {
      throw new OllamaHttpError('respuesta de /api/pull sin body', response.status, 'stream_cut');
    }
    try {
      for await (const raw of parseNdjson(response.body, signal)) {
        const errorParse = OllamaErrorChunkSchema.safeParse(raw);
        if (errorParse.success) {
          throw new OllamaHttpError(errorParse.data.error, 0, classifyErrorMessage(errorParse.data.error));
        }
        yield OllamaPullChunkSchema.parse(raw);
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (err instanceof OllamaHttpError) throw err;
      throw new OllamaHttpError(err instanceof Error ? err.message : String(err), 0, 'stream_cut');
    }
  }

  /** `DELETE /api/delete` (doc 13 §5.6, v0.2). Sin body de respuesta relevante: éxito = 200 OK. */
  async delete(model: string, signal?: AbortSignal): Promise<void> {
    await this.request('/api/delete', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    }, signal);
  }
}
