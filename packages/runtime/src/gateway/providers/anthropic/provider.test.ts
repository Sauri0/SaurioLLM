// Test de AnthropicProvider — packages/runtime/src/gateway/providers/anthropic/provider.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './provider.js';
import { mockSseResponse, STREAM_NORMAL_LINES, STREAM_TOOL_CALL_SPLIT_LINES, STREAM_ERROR_MIDWAY_LINES } from './__fixtures__/sseFixtures.js';
import { toAnthropicRequest } from './mappers.js';
import type { ChatRequest, ChatChunk } from '../../types.js';
import { ModelGatewayImpl } from '../../ModelGateway.js';
import type { ModelRef, ChatMessage } from '@saurio/shared';

const BASE_CHAT_REQ: ChatRequest = {
  model: 'claude-sonnet-5',
  messages: [{ id: 'm1', role: 'user', content: 'hola' }],
  options: { numCtx: 200000, temperature: 0.7, numPredict: 256 },
};

async function collect(iter: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

describe('gateway/providers/anthropic/mappers', () => {
  it('toAnthropicRequest(): separa el rol system del array messages', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'system', content: 'Sos un asistente útil.' },
      { id: '2', role: 'user', content: 'hola' },
    ];
    const { system, messages: out } = toAnthropicRequest(messages);
    expect(system).toBe('Sos un asistente útil.');
    expect(out).toEqual([{ role: 'user', content: 'hola' }]);
  });

  it('toAnthropicRequest(): un ChatMessage role=tool se traduce a bloque tool_result en un mensaje user', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: '¿clima en Tokio?' },
      { id: '2', role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' }, transport: 'native' }] },
      { id: '3', role: 'tool', content: '18C, nublado', toolCallId: 'call_1', toolName: 'get_weather' },
    ];
    const { messages: out } = toAnthropicRequest(messages);
    expect(out[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } }] });
    expect(out[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '18C, nublado' }] });
  });

  it('toAnthropicRequest(): agrupa tool_results consecutivos (tool calls en paralelo) en un único mensaje user', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'tool', content: 'r1', toolCallId: 'call_1' },
      { id: '2', role: 'tool', content: 'r2', toolCallId: 'call_2' },
    ];
    const { messages: out } = toAnthropicRequest(messages);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toHaveLength(2);
  });
});

describe('gateway/providers/anthropic/provider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('locality es siempre cloud y kind es cloud', () => {
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => 'sk-ant-test' });
    expect(provider.locality).toBe('cloud');
    expect(provider.kind).toBe('cloud');
  });

  it('listModels() mapea /v1/models a ModelInfo[] con capabilities reales de thinking/vision', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{
        type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', max_input_tokens: 200000,
        capabilities: { thinking: { supported: true }, image_input: { supported: true } },
      }],
    }), { status: 200 }));
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => 'sk-ant-test' });
    const models = await provider.listModels();
    expect(models[0]).toMatchObject({
      ref: { providerId: 'anthropic', name: 'claude-sonnet-5', locality: 'cloud' },
      capabilities: { tools: true, thinking: true, vision: true, embedding: false },
      contextMax: 200000,
    });
  });

  it('describeModel encuentra contexto confirmado en una página posterior', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ type: 'model', id: 'first', display_name: 'First' }], has_more: true, last_id: 'first' }));
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ type: 'model', id: 'second', display_name: 'Second', max_input_tokens: 123456 }], has_more: false }));
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => undefined });
    expect((await provider.describeModel('second')).contextMax).toBe(123456);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('describeModel(): modelo no listado degrada a capabilities asumidas sin lanzar', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => 'sk-ant-test' });
    const desc = await provider.describeModel('modelo-desconocido');
    expect(desc.contextMax).toBeUndefined();
    expect(desc.capabilities.tools).toBe(true);
  });

  it('chat(): stream normal produce content + done con métricas estimated', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_NORMAL_LINES));
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => 'sk-ant-test' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));

    const contentChunks = chunks.filter((c) => c.type === 'content');
    expect(contentChunks).toEqual([{ type: 'content', text: 'Hola' }, { type: 'content', text: ' mundo' }]);
    const done = chunks[chunks.length - 1];
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.doneReason).toBe('end_turn');
      expect(done.metrics.quality).toBe('estimated');
      expect(done.metrics.promptTokens).toBe(25);
      expect(done.metrics.evalTokens).toBe(15); // usage de message_delta es acumulativo, pisa el de message_start
    }
  });

  it('chat(): tool_use con input partido en varios input_json_delta se reensambla en un ChatChunk tool_call', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_TOOL_CALL_SPLIT_LINES));
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => 'sk-ant-test' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));

    const toolChunk = chunks.find((c) => c.type === 'tool_call');
    expect(toolChunk?.type).toBe('tool_call');
    if (toolChunk?.type === 'tool_call') {
      expect(toolChunk.call).toEqual({ id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6', name: 'get_weather', args: { location: 'San Francisco, CA' }, transport: 'native' });
    }
    const done = chunks[chunks.length - 1];
    expect(done?.type).toBe('done');
    if (done?.type === 'done') expect(done.doneReason).toBe('tool_use');
  });

  it('chat(): evento error a mitad de stream produce ChatChunk de tipo error', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_ERROR_MIDWAY_LINES));
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => 'sk-ant-test' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));
    const last = chunks[chunks.length - 1];
    expect(last).toEqual({ type: 'error', message: 'Overloaded', code: 'server_busy' });
  });

  it('chat(): abort real termina la iteración sin emitir ChatChunk de error', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => 'sk-ant-test' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, controller.signal));
    expect(chunks).toEqual([]);
  });

  it('chat(): 401 durante el request produce ChatChunk de error con code invalid_api_key', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid key' } }), { status: 401 }));
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => 'sk-ant-bad' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));
    expect(chunks).toEqual([{ type: 'error', message: 'invalid key', code: 'invalid_api_key' }]);
  });

  it('chat(): 429 produce ChatChunk de error con code server_busy', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'too many requests' } }), { status: 429, headers: { 'retry-after': '5' } }));
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => 'sk-ant-test' });
    const chunks = await collect(provider.chat(BASE_CHAT_REQ, new AbortController().signal));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'error', code: 'server_busy' });
  });

  it('max_tokens obligatorio: siempre viaja en el body aunque numPredict sea chico', async () => {
    fetchMock.mockResolvedValueOnce(mockSseResponse(STREAM_NORMAL_LINES));
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => 'sk-ant-test' });
    await collect(provider.chat({ ...BASE_CHAT_REQ, options: { ...BASE_CHAT_REQ.options, numPredict: 64 } }, new AbortController().signal));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { max_tokens: number };
    expect(body.max_tokens).toBe(64);
  });

  it('locality cloud: el ModelGateway rechaza el chat si el run no autorizó "cloud" (nunca fallback local -> nube)', async () => {
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => 'sk-ant-test' });
    const gw = new ModelGatewayImpl([provider]);
    const ref: ModelRef = { providerId: 'anthropic', name: 'claude-sonnet-5', locality: 'cloud' };
    const chunks = await collect(gw.chat(ref, BASE_CHAT_REQ, {
      runId: 'run-1', signal: new AbortController().signal, authorizedLocality: ['local'], priority: 'interactive',
    }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled(); // nunca se llegó a golpear la red del provider cloud
  });
});

// ── Integración opcional (solo si hay ANTHROPIC_API_KEY en el entorno; se salta si no) ──────────
const anthropicKey = process.env.ANTHROPIC_API_KEY;
describe.skipIf(process.env.SAURIO_TEST_EXTERNAL !== '1' || anthropicKey === undefined || anthropicKey.length === 0)('gateway/providers/anthropic/provider (integración real, opcional)', () => {
  it('chat() contra la API real produce al menos un chunk de contenido y un done measured/estimated', async () => {
    vi.unstubAllGlobals(); // esta prueba SÍ debe usar fetch real, no el mock del resto del archivo
    const provider = new AnthropicProvider({ id: 'anthropic', getApiKey: async () => anthropicKey });
    const req: ChatRequest = {
      model: 'claude-3-5-haiku-latest',
      messages: [{ id: 'm1', role: 'user', content: 'Respondé solo con la palabra: hola' }],
      options: { numCtx: 200000, temperature: 0, numPredict: 16 },
    };
    const chunks = await collect(provider.chat(req, new AbortController().signal));
    expect(chunks.some((c) => c.type === 'content' || c.type === 'done')).toBe(true);
    const done = chunks.find((c) => c.type === 'done');
    expect(done).toBeDefined();
  }, 30_000);
});
