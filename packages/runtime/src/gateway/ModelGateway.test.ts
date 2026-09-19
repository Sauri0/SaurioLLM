// Test de ModelGatewayImpl — packages/runtime/src/gateway/ModelGateway.test.ts.
// Usa un FakeProvider (no un OllamaProvider real) para aislar la responsabilidad del Gateway:
// resolver provider, aplicar authorizedLocality, adquirir/liberar slot, medir TTFT de cliente.
import { describe, expect, it, vi } from 'vitest';
import { ModelGatewayImpl, ProviderNotFoundError } from './ModelGateway.js';
import type { Provider } from './Provider.js';
import type { ChatChunk, ChatContext, ChatRequest, ResponseMetrics } from './types.js';
import type { ModelRef } from '@saurio/shared';

class FakeProvider implements Provider {
  readonly kind = 'ollama' as const;
  calls: ChatRequest[] = [];
  constructor(readonly id: string, readonly locality: ModelRef['locality'], private readonly chunks: ChatChunk[], private readonly delayMs = 0) {}

  async health(): Promise<{ ok: boolean }> { return { ok: true }; }
  async listModels() { return []; }
  async describeModel(): Promise<never> { throw new Error('no usado en este test'); }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
    this.calls.push(req);
    for (const chunk of this.chunks) {
      if (signal.aborted) return;
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      yield chunk;
    }
  }
}

const REF: ModelRef = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' };
const REQ: ChatRequest = { model: 'qwen3:8b', messages: [], options: { numCtx: 8192, temperature: 0.7, numPredict: 256 } };

function ctx(overrides: Partial<ChatContext> = {}): ChatContext {
  return { runId: 'run-1', signal: new AbortController().signal, authorizedLocality: ['local'], priority: 'interactive', ...overrides };
}

async function collect(iter: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe('gateway/ModelGatewayImpl', () => {
  it('resolve() encuentra el provider por providerId', () => {
    const provider = new FakeProvider('ollama', 'local', []);
    const gw = new ModelGatewayImpl([provider]);
    expect(gw.resolve(REF)).toBe(provider);
  });

  it('resolve() lanza ProviderNotFoundError si no hay provider registrado', () => {
    const gw = new ModelGatewayImpl([]);
    expect(() => gw.resolve(REF)).toThrow(ProviderNotFoundError);
  });

  it('chat(): locality no autorizada nunca cae a nube — emite ChatChunk de error y no llama al provider', async () => {
    const provider = new FakeProvider('ollama', 'local', [{ type: 'content', text: 'no debería llegar' }]);
    const gw = new ModelGatewayImpl([provider]);
    const chunks = await collect(gw.chat(REF, REQ, ctx({ authorizedLocality: ['cloud'] })));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe('error');
    expect(provider.calls).toHaveLength(0);
  });

  it('chat(): Solo local bloquea antes del provider usando su locality configurada, no la del ModelRef', async () => {
    const provider = new FakeProvider('cloud-configured', 'cloud', [
      { type: 'content', text: 'no debería salir' },
    ]);
    const staleRef: ModelRef = { providerId: provider.id, name: 'modelo', locality: 'local' };
    const gw = new ModelGatewayImpl([provider], { slots: 1, groupByModel: true }, {
      isLocalOnlyEnabled: async () => true,
    });

    const chunks = await collect(gw.chat(staleRef, REQ, ctx({ authorizedLocality: ['local', 'cloud'] })));

    expect(chunks).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('Solo modelos locales') })]);
    expect(provider.calls).toHaveLength(0);
    expect(gw.status().queue).toHaveLength(0);
  });

  it('chat(): Solo local conserva generación con un provider local', async () => {
    const provider = new FakeProvider('ollama', 'local', [
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ]);
    const gw = new ModelGatewayImpl([provider], { slots: 1, groupByModel: true }, {
      isLocalOnlyEnabled: () => true,
    });

    const chunks = await collect(gw.chat(REF, REQ, ctx()));

    expect(chunks.at(-1)?.type).toBe('done');
    expect(provider.calls).toHaveLength(1);
  });

  it('chat(): sin preferencia Solo local conserva compatibilidad con providers no locales', async () => {
    const provider = new FakeProvider('cloud', 'cloud', [
      { type: 'done', doneReason: 'stop', metrics: { quality: 'estimated' } },
    ]);
    const cloudRef: ModelRef = { providerId: provider.id, name: 'modelo', locality: 'cloud' };
    const gw = new ModelGatewayImpl([provider]);

    const chunks = await collect(gw.chat(cloudRef, REQ, ctx({ authorizedLocality: ['cloud'] })));

    expect(chunks.at(-1)?.type).toBe('done');
    expect(provider.calls).toHaveLength(1);
  });

  it('chat(): revalida Solo local al salir de la cola, libera el lease y no llama al provider', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let localOnly = false;
    class BlockingCloudProvider extends FakeProvider {
      started = 0;
      override async *chat(): AsyncIterable<ChatChunk> {
        this.started += 1;
        if (this.started === 1) await gate;
        yield { type: 'done', doneReason: 'stop', metrics: { quality: 'estimated' } };
      }
    }
    const provider = new BlockingCloudProvider('cloud-queued', 'cloud', []);
    const cloudRef: ModelRef = { providerId: provider.id, name: 'modelo', locality: 'cloud' };
    const gw = new ModelGatewayImpl([provider], { slots: 1, groupByModel: true }, {
      isLocalOnlyEnabled: () => localOnly,
    });

    const first = collect(gw.chat(cloudRef, REQ, ctx({ authorizedLocality: ['cloud'], runId: 'run-first' })));
    await vi.waitFor(() => expect(provider.started).toBe(1));
    const queued = collect(gw.chat(cloudRef, REQ, ctx({ authorizedLocality: ['cloud'], runId: 'run-queued' })));
    await vi.waitFor(() => expect(gw.status().queue).toHaveLength(1));

    localOnly = true;
    releaseFirst();
    await first;
    const queuedChunks = await queued;

    expect(queuedChunks).toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringContaining('se activó mientras') }),
    ]);
    expect(provider.started).toBe(1);
    expect(gw.status().queue).toHaveLength(0);
    expect(gw.status().slots[0]?.state).toBe('idle');
  });

  it('chat(): pasa los chunks del provider y agrega ttftClientMs en done', async () => {
    const provider = new FakeProvider('ollama', 'local', [
      { type: 'content', text: 'hola' },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ], 5);
    const gw = new ModelGatewayImpl([provider]);
    const chunks = await collect(gw.chat(REF, REQ, ctx()));
    expect(chunks[0]).toEqual({ type: 'content', text: 'hola' });
    const done = chunks[1];
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.metrics.ttftClientMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('chat(): aplica recursos sólo a Ollama local y conserva numGpu explícito de retry OOM', async () => {
    const provider = new FakeProvider('ollama', 'local', [{ type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } }]);
    const gw = new ModelGatewayImpl([provider], { slots: 'auto', groupByModel: true }, {
      resolveLocalChatOptions: async () => ({ numThreads: 6, numGpu: 0 }),
    });
    await collect(gw.chat(REF, REQ, ctx()));
    expect(provider.calls[0]?.options).toMatchObject({ numThreads: 6, numGpu: 0 });

    await collect(gw.chat(REF, { ...REQ, options: { ...REQ.options, numGpu: 18 } }, ctx()));
    expect(provider.calls[1]?.options).toMatchObject({ numThreads: 6, numGpu: 18 });
  });

  it('chat(): no consulta preferencias de recursos para una API o un Ollama LAN', async () => {
    const provider = new FakeProvider('ollama-lan', 'lan', [{ type: 'done', doneReason: 'stop', metrics: { quality: 'estimated' } }]);
    const lanRef: ModelRef = { providerId: 'ollama-lan', name: 'qwen', locality: 'lan' };
    let resolved = false;
    const gw = new ModelGatewayImpl([provider], { slots: 'auto', groupByModel: true }, {
      resolveLocalChatOptions: () => { resolved = true; return { numThreads: 1, numGpu: 0 }; },
    });
    await collect(gw.chat(lanRef, REQ, ctx({ authorizedLocality: ['lan'] })));
    expect(resolved).toBe(false);
    expect(provider.calls[0]?.options.numThreads).toBeUndefined();
  });

  it('chat(): libera el slot en done (una segunda generación no queda en cola indefinida)', async () => {
    const provider = new FakeProvider('ollama', 'local', [
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ]);
    const gw = new ModelGatewayImpl([provider], { slots: 1, groupByModel: true });
    await collect(gw.chat(REF, REQ, ctx()));
    const second = await collect(gw.chat(REF, REQ, ctx()));
    expect(second).toHaveLength(1);
    expect(gw.status().slots[0]?.state).toBe('idle');
  });

  it('chat(): libera el slot también si el provider lanza (finally)', async () => {
    class ThrowingProvider extends FakeProvider {
      // eslint-disable-next-line require-yield
      override async *chat(): AsyncIterable<ChatChunk> {
        throw new Error('boom');
      }
    }
    const provider = new ThrowingProvider('ollama', 'local', []);
    const gw = new ModelGatewayImpl([provider], { slots: 1, groupByModel: true });
    await expect(collect(gw.chat(REF, REQ, ctx()))).rejects.toThrow('boom');
    expect(gw.status().slots[0]?.state).toBe('idle');
  });

  it('chat(): libera el slot en abort (AbortSignal del caller)', async () => {
    const controller = new AbortController();
    const provider = new FakeProvider('ollama', 'local', [
      { type: 'content', text: 'x' },
      { type: 'content', text: 'y' },
    ], 20);
    const gw = new ModelGatewayImpl([provider], { slots: 1, groupByModel: true });
    const iter = collect(gw.chat(REF, REQ, ctx({ signal: controller.signal })));
    setTimeout(() => controller.abort(), 5);
    await iter;
    expect(gw.status().slots[0]?.state).toBe('idle');
  });

  it('status() refleja slots y cola del scheduler interno', () => {
    const provider = new FakeProvider('ollama', 'local', []);
    const gw = new ModelGatewayImpl([provider], { slots: 2, groupByModel: true });
    const status = gw.status();
    expect(status.slots).toHaveLength(2);
    expect(status.queue).toEqual([]);
  });

  it('setProviders(): reemplaza la lista completa en caliente (encargo apps/desktop, punto 2)', async () => {
    const oldProvider = new FakeProvider('ollama', 'local', []);
    const gw = new ModelGatewayImpl([oldProvider]);
    expect(gw.resolve(REF)).toBe(oldProvider);

    const newProvider = new FakeProvider('ollama', 'local', [{ type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } }]);
    gw.setProviders([newProvider]);
    expect(gw.resolve(REF)).toBe(newProvider);
    expect(gw.providers()).toEqual([newProvider]);

    // Un provider que ya no está en la lista nueva deja de resolverse.
    gw.setProviders([]);
    expect(() => gw.resolve(REF)).toThrow(ProviderNotFoundError);
  });

  it('onNonLocalCall: se invoca para locality no local, nunca para local (encargo apps/desktop, punto 4: audit_log)', async () => {
    const cloudRef: ModelRef = { providerId: 'anthropic', name: 'claude', locality: 'cloud' };
    const cloudProvider = new FakeProvider('anthropic', 'cloud', [{ type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } }]);
    const calls: { ref: ModelRef; runId: string }[] = [];
    const gw = new ModelGatewayImpl([cloudProvider], { slots: 'auto', groupByModel: true }, {
      onNonLocalCall: (ref, callCtx) => calls.push({ ref, runId: callCtx.runId }),
    });
    await collect(gw.chat(cloudRef, REQ, ctx({ authorizedLocality: ['cloud'], runId: 'run-audit' })));
    expect(calls).toEqual([{ ref: cloudRef, runId: 'run-audit' }]);

    const localProvider = new FakeProvider('ollama', 'local', [{ type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } }]);
    const gw2 = new ModelGatewayImpl([localProvider], { slots: 'auto', groupByModel: true }, {
      onNonLocalCall: () => calls.push({ ref: REF, runId: 'no-debería-pasar' }),
    });
    await collect(gw2.chat(REF, REQ, ctx()));
    expect(calls).toHaveLength(1); // sigue en 1: la llamada local no dispara el hook
  });

  it('onNonLocalResult correlaciona callId/runId y entrega métricas finales sólo para no-local', async () => {
    const cloudRef: ModelRef = { providerId: 'openrouter', name: 'modelo:free', locality: 'cloud' };
    const metrics: ResponseMetrics = {
      quality: 'estimated', promptTokens: 12, evalTokens: 4, costUsd: 0, costSource: 'reported',
    };
    const cloudProvider = new FakeProvider('openrouter', 'cloud', [
      { type: 'done', doneReason: 'stop', metrics },
    ]);
    const results: Array<{ ref: ModelRef; result: {
      callId: string; runId: string; metrics?: ResponseMetrics; error: boolean; interrupted: boolean;
    } }> = [];
    const gw = new ModelGatewayImpl([cloudProvider], { slots: 1, groupByModel: true }, {
      onNonLocalResult: (ref, result) => results.push({ ref, result }),
    });

    await collect(gw.chat(cloudRef, REQ, ctx({ authorizedLocality: ['cloud'], runId: 'run-cost' })));

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ref: cloudRef,
      result: { runId: 'run-cost', metrics, error: false, interrupted: false },
    });
    expect(results[0]?.result.callId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('registra por separado todas las invocaciones del gateway del mismo run, incluida una compactación', async () => {
    const cloudRef: ModelRef = { providerId: 'cloud', name: 'modelo', locality: 'cloud' };
    const provider = new FakeProvider('cloud', 'cloud', [
      { type: 'done', doneReason: 'stop', metrics: { quality: 'estimated', costSource: 'unavailable' } },
    ]);
    const calls: Array<{ callId: string; runId: string }> = [];
    const gw = new ModelGatewayImpl([provider], { slots: 1, groupByModel: true }, {
      onNonLocalResult: (_ref, result) => calls.push({ callId: result.callId, runId: result.runId }),
    });
    const callContext = ctx({ authorizedLocality: ['cloud'], runId: 'run-with-compaction' });

    await collect(gw.chat(cloudRef, REQ, callContext)); // generación principal
    await collect(gw.chat(cloudRef, { ...REQ, messages: [] }, callContext)); // resumen de compactación

    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.callId)).size).toBe(2);
    expect(calls.map((call) => call.runId)).toEqual(['run-with-compaction', 'run-with-compaction']);
  });

  it('considera completa una llamada si el consumidor retorna al recibir done, como RunController', async () => {
    const cloudRef: ModelRef = { providerId: 'cloud', name: 'modelo', locality: 'cloud' };
    const provider = new FakeProvider('cloud', 'cloud', [
      { type: 'done', doneReason: 'stop', metrics: { quality: 'estimated', costUsd: 0.03, costSource: 'reported' } },
    ]);
    const results: Array<{ metrics?: ResponseMetrics; error: boolean; interrupted: boolean }> = [];
    const gw = new ModelGatewayImpl([provider], { slots: 1, groupByModel: true }, {
      onNonLocalResult: (_ref, result) => results.push(result),
    });
    const iterator = gw.chat(cloudRef, REQ, ctx({ authorizedLocality: ['cloud'] }))[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.type).toBe('done');
    await iterator.return?.();

    expect(results).toEqual([{
      callId: expect.any(String), runId: 'run-1',
      metrics: expect.objectContaining({ costUsd: 0.03, costSource: 'reported' }),
      error: false, interrupted: false,
    }]);
  });

  it('onNonLocalResult marca costo desconocido ante error de stream o interrupción', async () => {
    const cloudRef: ModelRef = { providerId: 'anthropic', name: 'claude', locality: 'cloud' };
    const results: Array<{ metrics?: ResponseMetrics; error: boolean; interrupted: boolean }> = [];
    const errorProvider = new FakeProvider('anthropic', 'cloud', [
      { type: 'error', message: 'stream cortado', code: 'stream_cut' },
    ]);
    const errorGateway = new ModelGatewayImpl([errorProvider], { slots: 1, groupByModel: true }, {
      onNonLocalResult: (_ref, result) => results.push(result),
    });
    await collect(errorGateway.chat(cloudRef, REQ, ctx({ authorizedLocality: ['cloud'] })));

    const interruptedProvider = new FakeProvider('anthropic', 'cloud', [
      { type: 'content', text: 'parcial' },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'estimated', costUsd: 1, costSource: 'reported' } },
    ]);
    const interruptedGateway = new ModelGatewayImpl([interruptedProvider], { slots: 1, groupByModel: true }, {
      onNonLocalResult: (_ref, result) => results.push(result),
    });
    const iterator = interruptedGateway.chat(cloudRef, REQ, ctx({ authorizedLocality: ['cloud'] }))[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    expect(results).toEqual([
      { callId: expect.any(String), runId: 'run-1', metrics: undefined, error: true, interrupted: false },
      { callId: expect.any(String), runId: 'run-1', metrics: undefined, error: false, interrupted: true },
    ]);
  });

  it('una llamada no local cancelada mientras espera slot no genera resultado ni auditoría de inicio', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    class BlockingProvider extends FakeProvider {
      started = 0;
      override async *chat(): AsyncIterable<ChatChunk> {
        this.started += 1;
        if (this.started === 1) await gate;
        yield { type: 'done', doneReason: 'stop', metrics: { quality: 'estimated' } };
      }
    }
    const cloudRef: ModelRef = { providerId: 'cloud', name: 'modelo', locality: 'cloud' };
    const provider = new BlockingProvider('cloud', 'cloud', []);
    const starts: string[] = [];
    const results: string[] = [];
    const gw = new ModelGatewayImpl([provider], { slots: 1, groupByModel: true }, {
      onNonLocalCall: (_ref, callCtx) => starts.push(callCtx.runId),
      onNonLocalResult: (_ref, result) => results.push(result.runId),
    });
    const first = collect(gw.chat(cloudRef, REQ, ctx({ authorizedLocality: ['cloud'], runId: 'run-first' })));
    await vi.waitFor(() => expect(provider.started).toBe(1));

    const queuedController = new AbortController();
    const queued = collect(gw.chat(cloudRef, REQ, ctx({
      authorizedLocality: ['cloud'], runId: 'run-queued', signal: queuedController.signal,
    })));
    await vi.waitFor(() => expect(gw.status().queue).toHaveLength(1));
    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });

    expect(starts).toEqual(['run-first']);
    expect(results).toEqual([]);
    releaseFirst();
    await first;
    expect(results).toEqual(['run-first']);
  });

  it('ensureLoaded(): usa prioridad warmup y libera el slot apenas termina la carga', async () => {
    let loadCalledWith: [string, number, string | number] | undefined;
    class LoadableProvider extends FakeProvider {
      async load(name: string, numCtx: number, keepAlive: string | number): Promise<{ loadMs: number }> {
        loadCalledWith = [name, numCtx, keepAlive];
        return { loadMs: 42 };
      }
    }
    const provider = new LoadableProvider('ollama', 'local', []);
    const gw = new ModelGatewayImpl([provider], { slots: 1, groupByModel: true });
    await gw.ensureLoaded(REF, 8192);
    expect(loadCalledWith).toEqual(['qwen3:8b', 8192, '30m']);
    expect(gw.status().slots[0]?.state).toBe('idle');
  });
});
