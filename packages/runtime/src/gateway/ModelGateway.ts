// ModelGateway: única puerta de inferencia — packages/runtime/src/gateway/ModelGateway.ts.
// Define: doc 01-arquitectura.md §4.5 y doc 08-model-manager-y-scheduler.md §7. Resuelve
// ModelRef -> Provider, aplica authorizedLocality (jamás fallback a nube), adquiere/libera un slot
// del InferenceScheduler por generación, mide TTFT de cliente y normaliza ChatChunk. El
// AgentRuntime nunca ve el Scheduler ni el Provider directamente (regla de imports doc 02 §3).
import type { ModelRef } from '@saurio/shared';
import type { Provider } from './Provider.js';
import type { ChatChunk, ChatContext, ChatRequest, ModelGateway as ModelGatewayInterface, SlotStatus, QueuedJob } from './types.js';
import { Scheduler } from './Scheduler.js';
import type { SchedulerConfig } from './types.js';

export class LocalityDeniedError extends Error {
  constructor(readonly ref: ModelRef, readonly authorizedLocality: ModelRef['locality'][]) {
    super(`localidad "${ref.locality}" del modelo "${ref.name}" no está en authorizedLocality [${authorizedLocality.join(', ')}] — nunca se hace fallback a nube`);
    this.name = 'LocalityDeniedError';
  }
}

export class ProviderNotFoundError extends Error {
  constructor(readonly providerId: string) {
    super(`no hay ningún Provider registrado con id "${providerId}"`);
    this.name = 'ProviderNotFoundError';
  }
}

/** Cambio aditivo mínimo (encargo de apps/desktop, punto 2: "cableá ModelGatewayImpl con la lista
 *  real de providers configurados"; packages/runtime no es zona de ese encargo — documentado acá y en
 *  docs/architecture/16-estado-de-implementacion.md). `onNonLocalCall` es el único punto de la app
 *  donde TODA llamada de inferencia no local pasa (independientemente de quién la haya iniciado), así
 *  que es el lugar correcto para que el host registre `audit_log` sin duplicar el chequeo de
 *  `authorizedLocality` que ya hace `chat()`. Ambos campos son opcionales: sin ellos, el
 *  comportamiento es exactamente el previo. */
export interface ModelGatewayHooks {
  onNonLocalCall?: (ref: ModelRef, ctx: { runId: string }) => void;
}

export class ModelGatewayImpl implements ModelGatewayInterface {
  private readonly scheduler: Scheduler;
  private readonly providersById = new Map<string, Provider>();
  private readonly hooks: ModelGatewayHooks;

  constructor(
    providerList: Provider[],
    schedulerConfig: SchedulerConfig = { slots: 'auto', groupByModel: true },
    hooks: ModelGatewayHooks = {},
  ) {
    for (const provider of providerList) this.providersById.set(provider.id, provider);
    this.scheduler = new Scheduler(schedulerConfig);
    this.hooks = hooks;
  }

  providers(): Provider[] {
    return [...this.providersById.values()];
  }

  /** Reemplaza la lista completa de providers registrados (agregar/editar/quitar un provider desde
   *  la UI de Ajustes > Proveedores, en caliente, sin reiniciar la app). No toca el estado del
   *  Scheduler (slots/cola en curso siguen su curso con el Provider que ya tenían resuelto). */
  setProviders(providerList: Provider[]): void {
    this.providersById.clear();
    for (const provider of providerList) this.providersById.set(provider.id, provider);
  }

  resolve(ref: ModelRef): Provider {
    const provider = this.providersById.get(ref.providerId);
    if (provider === undefined) throw new ProviderNotFoundError(ref.providerId);
    return provider;
  }

  async *chat(ref: ModelRef, req: ChatRequest, ctx: ChatContext): AsyncIterable<ChatChunk> {
    // Locality: jamás fallback a nube (doc 01 §4.5, ADR de la columna vertebral). Se rinde como
    // ChatChunk de error en vez de lanzar, para que el AgentRuntime lo trate como cualquier otro
    // fallo de generación (mismo canal que 'error' de Provider).
    if (!ctx.authorizedLocality.includes(ref.locality)) {
      yield {
        type: 'error',
        message: `localidad "${ref.locality}" no autorizada para este run (authorizedLocality: ${ctx.authorizedLocality.join(', ')})`,
        code: 'unknown',
      };
      return;
    }

    const provider = this.resolve(ref);
    if (ref.locality !== 'local') this.hooks.onNonLocalCall?.(ref, { runId: ctx.runId });

    const lease = await this.scheduler.acquire(ref, req.options.numCtx, ctx.priority, ctx.signal);
    const startedAt = performance.now();
    let ttftRecorded = false;
    let ttftClientMs: number | undefined;

    try {
      for await (const chunk of provider.chat(req, ctx.signal)) {
        if (!ttftRecorded && (chunk.type === 'content' || chunk.type === 'thinking' || chunk.type === 'tool_call')) {
          ttftRecorded = true;
          ttftClientMs = performance.now() - startedAt;
        }
        if (chunk.type === 'done') {
          yield { ...chunk, metrics: { ...chunk.metrics, ttftClientMs: chunk.metrics.ttftClientMs ?? ttftClientMs } };
        } else {
          yield chunk;
        }
      }
    } finally {
      this.scheduler.release(lease);
    }
  }

  /** Precalentamiento (doc 08 §7.4): prioridad 'warmup', slot liberado apenas termina la carga
   *  (no retiene el slot para una generación posterior — eso lo hace chat()). */
  async ensureLoaded(ref: ModelRef, numCtx: number): Promise<void> {
    const provider = this.resolve(ref);
    if (provider.load === undefined) return;
    const controller = new AbortController();
    const lease = await this.scheduler.acquire(ref, numCtx, 'warmup', controller.signal);
    try {
      await provider.load(ref.name, numCtx, '30m');
    } finally {
      this.scheduler.release(lease);
    }
  }

  status(): { slots: SlotStatus[]; queue: QueuedJob[] } {
    return this.scheduler.status();
  }
}
