// Test de OllamaProvider — packages/runtime/src/gateway/providers/ollama/provider.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from './provider.js';
import {
  mockStreamResponse, STREAM_NORMAL_LINES, STREAM_TOOL_CALL_LINES, STREAM_ERROR_MIDWAY_LINES,
  STREAM_THINKING_LINES, PULL_STREAM_LINES, PULL_STREAM_ERROR_LINES,
} from './__fixtures__/ndjsonFixtures.js';
import type { ChatRequest, ChatChunk } from '../../types.js';

const BASE_CHAT_REQ: ChatRequest = {
  model: 'qwen3:8b',
  messages: [{ id: 'm1', role: 'user', content: 'hola' }],
  options: { numCtx: 8192, temperature: 0.7, numPredict: 256 },
};

async function collect(iter: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

describe('gateway/providers/ollama/provider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('locality: local para baseUrl loopback', () => {
    const provider = new OllamaProvider({ id: 'ollama-local', baseUrl: 'http://127.0.0.1:11434' });
    expect(provider.locality).toBe('local');
    expect(provider.kind).toBe('ollama');
  });

  it('locality: lan para baseUrl no-loopback', () => {
    const provider = new OllamaProvider({ id: 'ollama-lan', baseUrl: 'http://192.168.1.20:11434' });
    expect(provider.locality).toBe('lan');
  });

  it('listModels() mapea /api/tags a ModelInfo[] con capabilities', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      models: [{
        name: 'qwen3:8b', size: 5225000000, digest: 'sha256:abc',
        details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' },
        capabilities: ['completion', 'tools', 'thinking'],
      }],
    }), { status: 200 }));
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const models = await provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      ref: { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' },
      capabilities: { tools: true, thinking: true, vision: false, embedding: false },
      sizeBytes: 5225000000,
    });
  });

  it('describeModel() combina /api/tags + /api/show y calcula contextMax desde model_info', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      models: [{ name: 'qwen3:8b', size: 5225000000, digest: 'sha256:abc', details: { family: 'qwen3' }, capabilities: ['tools'] }],
    }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      template: '{{ .Prompt }}',
      parameters: 'num_keep 24',
      model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960, 'qwen3.block_count': 36 },
      capabilities: ['completion', 'tools', 'thinking'],
    }), { status: 200 }));
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const desc = await provider.describeModel('qwen3:8b');
    expect(desc.contextMax).toBe(40960);
    expect(desc.modelInfo['qwen3.block_count']).toBe(36);
    expect(desc.template).toBe('{{ .Prompt }}');
  });

  it('listLoaded() mapea /api/ps a LoadedModel[]', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      models: [{ name: 'gemma4', size: 6591830464, digest: 'c6eb396d', expires_at: '2025-10-17T16:47:07Z', size_vram: 5333539264, context_length: 4096 }],
    }), { status: 200 }));
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const loaded = await provider.listLoaded();
    expect(loaded[0]).toEqual({ name: 'gemma4', digest: 'c6eb396d', size: 6591830464, sizeVram: 5333539264, contextLength: 4096, expiresAt: '2025-10-17T16:47:07Z' });
  });

  it('chat(): stream normal produce content + done con métricas measured', async () => {
    fetchMock.mockResolvedValueOnce(mockStreamResponse(STREAM_NORMAL_LINES));
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));

    expect(chunks[0]).toEqual({ type: 'content', text: 'Hola' });
    expect(chunks[1]).toEqual({ type: 'content', text: ' mundo' });
    const done = chunks[2];
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.doneReason).toBe('stop');
      expect(done.metrics.quality).toBe('measured');
      expect(done.metrics.promptTokens).toBe(26);
      expect(done.metrics.cachedPromptTokens).toBe(10);
      expect(done.metrics.evalTokens).toBe(282);
      expect(done.metrics.loadMs).toBeCloseTo(1.334875, 5);
    }
  });

  it('chat(): thinking y content se emiten como ChatChunk separados', async () => {
    fetchMock.mockResolvedValueOnce(mockStreamResponse(STREAM_THINKING_LINES));
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));
    expect(chunks[0]).toEqual({ type: 'thinking', text: 'pensando...' });
    expect(chunks[1]).toEqual({ type: 'content', text: 'listo' });
  });

  it('chat(): tool_call trae id/args/transport nativo', async () => {
    fetchMock.mockResolvedValueOnce(mockStreamResponse(STREAM_TOOL_CALL_LINES));
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));
    const toolChunk = chunks[0];
    expect(toolChunk?.type).toBe('tool_call');
    if (toolChunk?.type === 'tool_call') {
      expect(toolChunk.call).toEqual({ id: 'call_abc123', name: 'get_weather', args: { city: 'Tokyo' }, index: 0, transport: 'native' });
    }
  });

  it('chat(): error a mitad de stream produce ChatChunk de tipo error clasificado', async () => {
    fetchMock.mockResolvedValueOnce(mockStreamResponse(STREAM_ERROR_MIDWAY_LINES));
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));
    const last = chunks[chunks.length - 1];
    expect(last).toEqual({ type: 'error', message: 'cudaMalloc failed: out of memory', code: 'oom_generate' });
  });

  it('chat(): abort real termina la iteración sin emitir ChatChunk de error', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, controller.signal));
    expect(chunks).toEqual([]);
  });

  it('load(): usa wall time cuando load_duration falta', async () => {
    fetchMock.mockResolvedValueOnce(mockStreamResponse([
      JSON.stringify({ model: 'qwen3:8b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'load' }),
    ]));
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const result = await provider.load('qwen3:8b', 8192, '30m');
    expect(result.loadMs).toBeGreaterThanOrEqual(0);
  });

  it('load(): usa load_duration medido cuando está presente', async () => {
    fetchMock.mockResolvedValueOnce(mockStreamResponse([
      JSON.stringify({ model: 'qwen3:8b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'load', load_duration: 4000000 }),
    ]));
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const result = await provider.load('qwen3:8b', 8192, '30m');
    expect(result.loadMs).toBe(4);
  });

  it('unload(): manda keep_alive 0', async () => {
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { keep_alive: number };
      expect(body.keep_alive).toBe(0);
      return mockStreamResponse([JSON.stringify({ model: 'qwen3:8b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'unload' })]);
    });
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    await expect(provider.unload('qwen3:8b')).resolves.toBeUndefined();
  });

  it('health(): 404 en /api/version reporta ok:false con el mensaje de OllamaHttpError', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no encontrado' }), { status: 404 }));
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const health = await provider.health();
    expect(health.ok).toBe(false);
  });

  it('pull(): reexpone el stream de /api/pull como PullProgress (doc 13 §5.2, v0.2)', async () => {
    fetchMock.mockResolvedValueOnce(mockStreamResponse(PULL_STREAM_LINES));
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const controller = new AbortController();
    const events: { status: string; digest?: string; total?: number; completed?: number }[] = [];
    for await (const event of provider.pull!('all-minilm:latest', controller.signal)) events.push(event);
    expect(events.map((e) => e.status)).toEqual([
      'pulling manifest', 'downloading', 'downloading', 'verifying sha256 digest', 'writing manifest', 'success',
    ]);
    expect(events[2]).toEqual({ status: 'downloading', digest: 'sha256:layer1', total: 1000, completed: 1000 });
  });

  it('pull(): un error a mitad de stream (manifest 404) se propaga como excepción', async () => {
    fetchMock.mockResolvedValueOnce(mockStreamResponse(PULL_STREAM_ERROR_LINES));
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    const controller = new AbortController();
    await expect(async () => {
      for await (const _event of provider.pull!('no-existe:latest', controller.signal)) {
        // consumir el iterable hasta que lance
      }
    }).rejects.toThrow(/not found/);
  });

  it('delete(): manda DELETE /api/delete con { model }', async () => {
    fetchMock.mockImplementationOnce(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('DELETE');
      expect(JSON.parse(init.body as string)).toEqual({ model: 'all-minilm:latest' });
      expect(url).toContain('/api/delete');
      return new Response(null, { status: 200 });
    });
    const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    await expect(provider.delete!('all-minilm:latest')).resolves.toBeUndefined();
  });
});
