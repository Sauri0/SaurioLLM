// Test de OllamaClient — packages/runtime/src/gateway/providers/ollama/client.test.ts.
// fetch mockeado con fixtures NDJSON (regla de la tarea); nunca pega a un Ollama real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaClient, OllamaHttpError } from './client.js';
import {
  mockStreamResponse, STREAM_NORMAL_LINES, STREAM_TOOL_CALL_LINES, STREAM_ERROR_MIDWAY_LINES,
} from './__fixtures__/ndjsonFixtures.js';
import type { OllamaChatRequest } from './schemas.js';

const BASE_REQ: OllamaChatRequest = {
  model: 'qwen3:8b', messages: [{ role: 'user', content: 'hola' }], options: { num_ctx: 8192 },
};

describe('gateway/providers/ollama/client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('version() parsea /api/version', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.34.1' }), { status: 200 }));
    const client = new OllamaClient('http://127.0.0.1:11434');
    const result = await client.health();
    expect(result).toEqual({ ok: true, version: '0.34.1' });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:11434/api/version', expect.objectContaining({ method: 'GET' }));
  });

  it('tags() parsea /api/tags con capabilities', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      models: [{
        name: 'qwen3:8b', model: 'qwen3:8b', modified_at: '2026-09-10T12:00:00Z', size: 5225000000,
        digest: 'sha256:abc',
        details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' },
        capabilities: ['completion', 'tools', 'thinking'],
      }],
    }), { status: 200 }));
    const client = new OllamaClient('http://127.0.0.1:11434');
    const { models } = await client.tags();
    expect(models).toHaveLength(1);
    expect(models[0]?.capabilities).toEqual(['completion', 'tools', 'thinking']);
  });

  it('ps() parsea /api/ps con size_vram y context_length', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      models: [{
        name: 'gemma4', model: 'gemma4', size: 6591830464, digest: 'c6eb396d',
        expires_at: '2025-10-17T16:47:07.93355-07:00', size_vram: 5333539264, context_length: 4096,
      }],
    }), { status: 200 }));
    const client = new OllamaClient('http://127.0.0.1:11434');
    const { models } = await client.ps();
    expect(models[0]?.size_vram).toBe(5333539264);
  });

  it('chat() en stream normal: agrega content y termina con done + métricas', async () => {
    fetchMock.mockResolvedValueOnce(mockStreamResponse(STREAM_NORMAL_LINES));
    const client = new OllamaClient('http://127.0.0.1:11434');
    const controller = new AbortController();
    const events = [];
    for await (const ev of client.chat(BASE_REQ, controller.signal)) events.push(ev);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: 'chunk', chunk: { message: { content: 'Hola' } } });
    const last = events[2];
    expect(last?.kind).toBe('chunk');
    if (last?.kind === 'chunk') {
      expect(last.chunk.done).toBe(true);
      expect(last.chunk.prompt_eval_cached_count).toBe(10);
      expect(last.chunk.eval_count).toBe(282);
    }
  });

  it('chat() con tool_calls: expone id/index/arguments ya parseados', async () => {
    fetchMock.mockResolvedValueOnce(mockStreamResponse(STREAM_TOOL_CALL_LINES));
    const client = new OllamaClient('http://127.0.0.1:11434');
    const controller = new AbortController();
    const events = [];
    for await (const ev of client.chat(BASE_REQ, controller.signal)) events.push(ev);

    const first = events[0];
    expect(first?.kind).toBe('chunk');
    if (first?.kind === 'chunk') {
      const call = first.chunk.message?.tool_calls?.[0];
      expect(call).toEqual({ id: 'call_abc123', function: { index: 0, name: 'get_weather', arguments: { city: 'Tokyo' } } });
    }
  });

  it('chat() con error a mitad de stream (HTTP 200): produce evento kind=error clasificado', async () => {
    fetchMock.mockResolvedValueOnce(mockStreamResponse(STREAM_ERROR_MIDWAY_LINES));
    const client = new OllamaClient('http://127.0.0.1:11434');
    const controller = new AbortController();
    const events = [];
    for await (const ev of client.chat(BASE_REQ, controller.signal)) events.push(ev);

    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('chunk');
    expect(events[1]).toEqual({ kind: 'error', message: 'cudaMalloc failed: out of memory', code: 'oom_generate' });
  });

  it('chat() con abort real (AbortSignal): propaga AbortError sin emitir chunk de error', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      const err = new DOMException('Aborted', 'AbortError');
      throw err;
    });
    const client = new OllamaClient('http://127.0.0.1:11434');
    const gen = client.chat(BASE_REQ, controller.signal);
    await expect(gen.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('respuesta HTTP 404 -> OllamaHttpError con code model_not_found', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'model "x" not found' }), { status: 404 }));
    const client = new OllamaClient('http://127.0.0.1:11434');
    await expect(client.tags()).rejects.toMatchObject(
      expect.any(OllamaHttpError),
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'model "x" not found' }), { status: 404 }));
    try {
      await client.tags();
      expect.fail('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaHttpError);
      expect((err as OllamaHttpError).code).toBe('model_not_found');
      expect((err as OllamaHttpError).status).toBe(404);
    }
  });

  it('fetch rechaza con ECONNREFUSED -> code connection_refused', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    const client = new OllamaClient('http://127.0.0.1:11434');
    try {
      await client.tags();
      expect.fail('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaHttpError);
      expect((err as OllamaHttpError).code).toBe('connection_refused');
    }
  });
});
