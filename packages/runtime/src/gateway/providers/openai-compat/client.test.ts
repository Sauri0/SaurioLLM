// Test de OpenAICompatClient — packages/runtime/src/gateway/providers/openai-compat/client.test.ts.
// fetch mockeado con fixtures SSE reales (regla de la tarea); nunca pega a un servidor real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatClient, OpenAICompatHttpError } from './client.js';
import { mockSseResponse, STREAM_NORMAL_LINES, STREAM_TOOL_CALL_SPLIT_LINES, STREAM_ERROR_MIDWAY_LINES } from './__fixtures__/sseFixtures.js';
import type { OpenAIChatRequest } from './schemas.js';

const BASE_REQ: OpenAIChatRequest = {
  model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hola' }],
};

describe('gateway/providers/openai-compat/client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listModels() parsea /v1/models', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' }],
    }), { status: 200 }));
    const client = new OpenAICompatClient({ baseUrl: 'http://127.0.0.1:1234' });
    const { data } = await client.listModels();
    expect(data).toHaveLength(1);
    expect(data[0]?.id).toBe('gpt-4o-mini');
  });

  it('listModels() manda Authorization: Bearer <key> cuando getApiKey resuelve una clave', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const client = new OpenAICompatClient({ baseUrl: 'https://api.openai.com', getApiKey: async () => 'sk-test-123' });
    await client.listModels();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-123');
  });

  it('chatCompletions(): stream normal produce chunks de contenido y un chunk final con usage', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_NORMAL_LINES));
    const client = new OpenAICompatClient({ baseUrl: 'http://127.0.0.1:1234' });
    const controller = new AbortController();
    const events = [];
    for await (const ev of client.chatCompletions(BASE_REQ, controller.signal)) events.push(ev);

    const contentEvents = events.filter((e) => {
      if (e.kind !== 'chunk') return false;
      const content = e.chunk.choices[0]?.delta.content;
      return (content?.length ?? 0) > 0;
    });
    expect(contentEvents).toHaveLength(2);
    const last = events[events.length - 1];
    expect(last?.kind).toBe('chunk');
    if (last?.kind === 'chunk') {
      expect(last.chunk.usage?.completion_tokens).toBe(8);
    }
  });

  it('chatCompletions(): tool_calls partido en varios deltas llega íntegro en los eventos', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_TOOL_CALL_SPLIT_LINES));
    const client = new OpenAICompatClient({ baseUrl: 'http://127.0.0.1:1234' });
    const controller = new AbortController();
    const events = [];
    for await (const ev of client.chatCompletions(BASE_REQ, controller.signal)) events.push(ev);

    const toolDeltas = events.filter((e) => e.kind === 'chunk' && (e.chunk.choices[0]?.delta.tool_calls?.length ?? 0) > 0);
    expect(toolDeltas.length).toBeGreaterThanOrEqual(4);
  });

  it('chatCompletions(): error a mitad de stream (HTTP 200) produce evento kind=error', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_ERROR_MIDWAY_LINES));
    const client = new OpenAICompatClient({ baseUrl: 'http://127.0.0.1:1234' });
    const controller = new AbortController();
    const events = [];
    for await (const ev of client.chatCompletions(BASE_REQ, controller.signal)) events.push(ev);

    const last = events[events.length - 1];
    expect(last).toEqual({ kind: 'error', message: 'context length exceeded', code: 'unknown' });
  });

  it('chatCompletions(): abort real propaga AbortError sin emitir evento de error', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const client = new OpenAICompatClient({ baseUrl: 'http://127.0.0.1:1234' });
    const gen = client.chatCompletions(BASE_REQ, controller.signal);
    await expect(gen.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('401 -> OpenAICompatHttpError con code invalid_api_key y la clave redactada del mensaje', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-secret999' } }), { status: 401 }));
    const client = new OpenAICompatClient({ baseUrl: 'https://api.openai.com', getApiKey: async () => 'sk-secret999' });
    try {
      await client.listModels();
      expect.fail('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenAICompatHttpError);
      expect((err as OpenAICompatHttpError).code).toBe('invalid_api_key');
      expect((err as OpenAICompatHttpError).message).not.toContain('sk-secret999');
    }
  });

  it('404 -> code model_not_found', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }));
    const client = new OpenAICompatClient({ baseUrl: 'http://127.0.0.1:1234' });
    await expect(client.listModels()).rejects.toMatchObject({ code: 'model_not_found', status: 404 });
  });

  it('429 -> code server_busy con retry-after en el mensaje', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), {
      status: 429, headers: { 'retry-after': '30' },
    }));
    const client = new OpenAICompatClient({ baseUrl: 'https://openrouter.ai/api' });
    try {
      await client.listModels();
      expect.fail('debía lanzar');
    } catch (err) {
      expect((err as OpenAICompatHttpError).code).toBe('server_busy');
      expect((err as OpenAICompatHttpError).message).toContain('retry-after: 30s');
    }
  });

  it('fetch rechaza con ECONNREFUSED -> code connection_refused', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:1234'));
    const client = new OpenAICompatClient({ baseUrl: 'http://127.0.0.1:1234' });
    await expect(client.listModels()).rejects.toMatchObject({ code: 'connection_refused' });
  });
});
