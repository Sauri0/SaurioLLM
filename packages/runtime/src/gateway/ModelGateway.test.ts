// Test de ModelGatewayImpl — packages/runtime/src/gateway/ModelGateway.test.ts.
// Usa un FakeProvider (no un OllamaProvider real) para aislar la responsabilidad del Gateway:
// resolver provider, aplicar authorizedLocality, adquirir/liberar slot, medir TTFT de cliente.
import { describe, expect, it } from 'vitest';
import { ModelGatewayImpl, ProviderNotFoundError } from './ModelGateway.js';
import type { Provider } from './Provider.js';
import type { ChatChunk, ChatContext, ChatRequest } from './types.js';
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
