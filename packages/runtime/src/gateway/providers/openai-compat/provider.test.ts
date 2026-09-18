// Test de OpenAICompatProvider — packages/runtime/src/gateway/providers/openai-compat/provider.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatProvider } from './provider.js';
import { mockSseResponse, STREAM_NORMAL_LINES, STREAM_TOOL_CALL_SPLIT_LINES, STREAM_ERROR_MIDWAY_LINES } from './__fixtures__/sseFixtures.js';
import type { ChatRequest, ChatChunk } from '../../types.js';
import { ModelGatewayImpl } from '../../ModelGateway.js';
import type { ModelRef } from '@saurio/shared';

const BASE_CHAT_REQ: ChatRequest = {
  model: 'gpt-4o-mini',
  messages: [{ id: 'm1', role: 'user', content: 'hola' }],
  options: { numCtx: 8192, temperature: 0.7, numPredict: 256 },
};

async function collect(iter: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

describe('gateway/providers/openai-compat/provider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('locality: local para baseUrl loopback', () => {
    const provider = new OpenAICompatProvider({ id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' });
    expect(provider.locality).toBe('local');
    expect(provider.kind).toBe('openai-compat');
  });

  it('locality: lan para una IP de red privada (192.168.x.x)', () => {
    const provider = new OpenAICompatProvider({ id: 'llamacpp-lan', baseUrl: 'http://192.168.1.50:8080' });
    expect(provider.locality).toBe('lan');
  });

  it('locality: cloud para OpenAI/OpenRouter/Groq (host público)', () => {
    expect(new OpenAICompatProvider({ id: 'openai', baseUrl: 'https://api.openai.com' }).locality).toBe('cloud');
    expect(new OpenAICompatProvider({ id: 'openrouter', baseUrl: 'https://openrouter.ai/api' }).locality).toBe('cloud');
    expect(new OpenAICompatProvider({ id: 'groq', baseUrl: 'https://api.groq.com/openai' }).locality).toBe('cloud');
  });

  it('listModels() mapea /v1/models a ModelInfo[] con capabilities.tools asumido true', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'llama-3.1-8b', context_length: 32768 }] }), { status: 200 }));
    const provider = new OpenAICompatProvider({ id: 'vllm', baseUrl: 'http://127.0.0.1:8000' });
    const models = await provider.listModels();
    expect(models[0]).toMatchObject({
      ref: { providerId: 'vllm', name: 'llama-3.1-8b', locality: 'local' },
      capabilities: { tools: true, thinking: false, vision: false, embedding: false },
      contextMax: 32768,
    });
  });

  it('describeModel(): modelo no listado degrada a capabilities asumidas sin lanzar', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const provider = new OpenAICompatProvider({ id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' });
    const desc = await provider.describeModel('modelo-desconocido');
    expect(desc.contextMax).toBeUndefined();
    expect(desc.capabilities.tools).toBe(true);
    expect(desc.modelInfo).toEqual({});
  });

  it('chat(): stream normal produce content + done con métricas estimated', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_NORMAL_LINES));
    const provider = new OpenAICompatProvider({ id: 'openai', baseUrl: 'https://api.openai.com' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));

    const contentChunks = chunks.filter((c) => c.type === 'content');
    expect(contentChunks).toEqual([{ type: 'content', text: 'Hola' }, { type: 'content', text: ' mundo' }]);
    const done = chunks[chunks.length - 1];
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.doneReason).toBe('stop');
      expect(done.metrics.quality).toBe('estimated');
      expect(done.metrics.promptTokens).toBe(12);
      expect(done.metrics.evalTokens).toBe(8);
    }
  });

  it('chat(): tool call partido en varios deltas se reensambla en un único ChatChunk tool_call', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_TOOL_CALL_SPLIT_LINES));
    const provider = new OpenAICompatProvider({ id: 'groq', baseUrl: 'https://api.groq.com/openai' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));

    const toolChunk = chunks.find((c) => c.type === 'tool_call');
    expect(toolChunk?.type).toBe('tool_call');
    if (toolChunk?.type === 'tool_call') {
      expect(toolChunk.call).toEqual({ id: 'call_abc123', name: 'get_weather', args: { location: 'Tokyo' }, index: 0, transport: 'native' });
    }
    const done = chunks[chunks.length - 1];
    expect(done?.type).toBe('done');
    if (done?.type === 'done') expect(done.doneReason).toBe('tool_calls');
  });

  it('chat(): error a mitad de stream produce ChatChunk de tipo error', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_ERROR_MIDWAY_LINES));
    const provider = new OpenAICompatProvider({ id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));
    const last = chunks[chunks.length - 1];
    expect(last).toMatchObject({ type: 'error', message: 'context length exceeded' });
  });

  it('chat(): abort real termina la iteración sin emitir ChatChunk de error', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const provider = new OpenAICompatProvider({ id: 'openai', baseUrl: 'https://api.openai.com' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, controller.signal));
    expect(chunks).toEqual([]);
  });

  it('chat(): 401 durante el request produce ChatChunk de error con code invalid_api_key', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 }));
    const provider = new OpenAICompatProvider({ id: 'openai', baseUrl: 'https://api.openai.com', getApiKey: async () => 'sk-bad' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));
    expect(chunks).toEqual([{ type: 'error', message: 'invalid key', code: 'invalid_api_key' }]);
  });

  it('chat(): 429 produce ChatChunk de error con code server_busy', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'too many requests' } }), { status: 429, headers: { 'retry-after': '5' } }));
    const provider = new OpenAICompatProvider({ id: 'groq', baseUrl: 'https://api.groq.com/openai' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'error', code: 'server_busy' });
  });

  it('locality cloud: el ModelGateway rechaza el chat si el run no autorizó "cloud" (nunca fallback local -> nube)', async () => {
    const provider = new OpenAICompatProvider({ id: 'openrouter', baseUrl: 'https://openrouter.ai/api' });
    expect(provider.locality).toBe('cloud');
    const gw = new ModelGatewayImpl([provider]);
    const ref: ModelRef = { providerId: 'openrouter', name: 'meta-llama/llama-3.1-8b', locality: 'cloud' };
    const chunks = await collect(gw.chat(ref, BASE_CHAT_REQ, {
      runId: 'run-1', signal: new AbortController().signal, authorizedLocality: ['local'], priority: 'interactive',
    }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled(); // nunca se llegó a golpear la red del provider cloud
  });
});

// ── Integración opcional (solo si hay OPENAI_API_KEY/OPENROUTER_API_KEY en el entorno) ──────────
const openaiKey = process.env.OPENAI_API_KEY;
describe.skipIf(openaiKey === undefined || openaiKey.length === 0)('gateway/providers/openai-compat/provider (integración real con OpenAI, opcional)', () => {
  it('chat() contra la API real de OpenAI produce al menos un chunk de contenido y un done', async () => {
    vi.unstubAllGlobals(); // esta prueba SÍ debe usar fetch real, no el mock del resto del archivo
    const provider = new OpenAICompatProvider({ id: 'openai', baseUrl: 'https://api.openai.com', getApiKey: async () => openaiKey });
    const req: ChatRequest = {
      model: 'gpt-4o-mini',
      messages: [{ id: 'm1', role: 'user', content: 'Respondé solo con la palabra: hola' }],
      options: { numCtx: 128000, temperature: 0, numPredict: 16 },
    };
    const chunks = await collect(provider.chat(req, new AbortController().signal));
    expect(chunks.some((c) => c.type === 'content' || c.type === 'done')).toBe(true);
    expect(chunks.find((c) => c.type === 'done')).toBeDefined();
  }, 30_000);
});

const openrouterKey = process.env.OPENROUTER_API_KEY;
describe.skipIf(openrouterKey === undefined || openrouterKey.length === 0)('gateway/providers/openai-compat/provider (integración real con OpenRouter, opcional)', () => {
  it('chat() contra la API real de OpenRouter produce al menos un chunk de contenido y un done', async () => {
    vi.unstubAllGlobals();
    const provider = new OpenAICompatProvider({
      id: 'openrouter', baseUrl: 'https://openrouter.ai/api', getApiKey: async () => openrouterKey,
      headers: { 'HTTP-Referer': 'https://saurio.local', 'X-Title': 'SaurioLLM' },
    });
    const req: ChatRequest = {
      model: 'meta-llama/llama-3.1-8b-instruct',
      messages: [{ id: 'm1', role: 'user', content: 'Respondé solo con la palabra: hola' }],
      options: { numCtx: 8192, temperature: 0, numPredict: 16 },
    };
    const chunks = await collect(provider.chat(req, new AbortController().signal));
    expect(chunks.some((c) => c.type === 'content' || c.type === 'done')).toBe(true);
    expect(chunks.find((c) => c.type === 'done')).toBeDefined();
  }, 30_000);
});
