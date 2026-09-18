// Test de AnthropicClient — packages/runtime/src/gateway/providers/anthropic/client.test.ts.
// fetch mockeado con fixtures SSE reales (regla de la tarea); nunca pega a la API real de Anthropic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicClient, AnthropicHttpError } from './client.js';
import { mockSseResponse, STREAM_NORMAL_LINES, STREAM_TOOL_CALL_SPLIT_LINES, STREAM_ERROR_MIDWAY_LINES } from './__fixtures__/sseFixtures.js';
import type { AnthropicRequest } from './schemas.js';

const BASE_REQ: AnthropicRequest = {
  model: 'claude-sonnet-5', max_tokens: 256, messages: [{ role: 'user', content: 'hola' }],
};

describe('gateway/providers/anthropic/client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listModels() parsea /v1/models y manda los headers x-api-key + anthropic-version', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }],
      has_more: false, first_id: 'claude-sonnet-5', last_id: 'claude-sonnet-5',
    }), { status: 200 }));
    const client = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', getApiKey: async () => 'sk-ant-test' });
    const { data } = await client.listModels();
    expect(data[0]?.id).toBe('claude-sonnet-5');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('messages(): stream normal produce eventos en orden hasta message_stop', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_NORMAL_LINES));
    const client = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', getApiKey: async () => 'sk-ant-test' });
    const controller = new AbortController();
    const results = [];
    for await (const r of client.messages(BASE_REQ, controller.signal)) results.push(r);

    expect(results[0]).toMatchObject({ kind: 'event', event: { type: 'message_start' } });
    const last = results[results.length - 1];
    expect(last).toMatchObject({ kind: 'event', event: { type: 'message_stop' } });
  });

  it('messages(): tool_use con input_json_delta partido llega íntegro en los eventos', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_TOOL_CALL_SPLIT_LINES));
    const client = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', getApiKey: async () => 'sk-ant-test' });
    const controller = new AbortController();
    const results = [];
    for await (const r of client.messages(BASE_REQ, controller.signal)) results.push(r);

    const deltas = results.filter((r) => r.kind === 'event' && r.event.type === 'content_block_delta' && r.event.delta.type === 'input_json_delta');
    expect(deltas.length).toBeGreaterThanOrEqual(3);
  });

  it('messages(): evento error a mitad de stream (HTTP 200) produce kind=error clasificado', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_ERROR_MIDWAY_LINES));
    const client = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', getApiKey: async () => 'sk-ant-test' });
    const controller = new AbortController();
    const results = [];
    for await (const r of client.messages(BASE_REQ, controller.signal)) results.push(r);

    const last = results[results.length - 1];
    expect(last).toEqual({ kind: 'error', message: 'Overloaded', code: 'server_busy' });
  });

  it('messages(): abort real propaga AbortError sin emitir evento de error', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const client = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', getApiKey: async () => 'sk-ant-test' });
    const gen = client.messages(BASE_REQ, controller.signal);
    await expect(gen.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('401 -> AnthropicHttpError con code invalid_api_key y la clave redactada del mensaje', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-leak123' } }), { status: 401 }));
    const client = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', getApiKey: async () => 'sk-ant-leak123' });
    try {
      await client.listModels();
      expect.fail('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(AnthropicHttpError);
      expect((err as AnthropicHttpError).code).toBe('invalid_api_key');
      expect((err as AnthropicHttpError).message).not.toContain('sk-ant-leak123');
    }
  });

  it('404 -> code model_not_found', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model not found' } }), { status: 404 }));
    const client = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', getApiKey: async () => 'sk-ant-test' });
    await expect(client.listModels()).rejects.toMatchObject({ code: 'model_not_found', status: 404 });
  });

  it('429 -> code server_busy con retry-after en el mensaje', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }), {
      status: 429, headers: { 'retry-after': '20' },
    }));
    const client = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', getApiKey: async () => 'sk-ant-test' });
    try {
      await client.listModels();
      expect.fail('debía lanzar');
    } catch (err) {
      expect((err as AnthropicHttpError).code).toBe('server_busy');
      expect((err as AnthropicHttpError).message).toContain('retry-after: 20s');
    }
  });

  it('fetch rechaza con ECONNREFUSED -> code connection_refused', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const client = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', getApiKey: async () => 'sk-ant-test' });
    await expect(client.listModels()).rejects.toMatchObject({ code: 'connection_refused' });
  });
});
