// ModelGateway: única puerta de inferencia — packages/runtime/src/gateway/ModelGateway.ts.
// Define: doc 01-arquitectura.md §4.5 y doc 08-model-manager-y-scheduler.md §7. Resuelve
// ModelRef -> Provider, aplica authorizedLocality (jamás fallback a nube), adquiere/libera un slot
// del InferenceScheduler por generación, mide TTFT de cliente y normaliza ChatChunk. El
// AgentRuntime nunca ve el Scheduler ni el Provider directamente (regla de imports doc 02 §3).
import type { ModelRef } from '@saurio/shared';
import { randomUUID } from 'node:crypto';
import type { Provider } from './Provider.js';
import type { ChatChunk, ChatContext, ChatRequest, LocalChatOptions, ModelGateway as ModelGatewayInterface, ResponseMetrics, SlotStatus, QueuedJob } from './types.js';
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
  /** Compatibilidad con integraciones anteriores. Se dispara recién cuando la llamada obtuvo un
   *  slot y va a entrar al provider; una petición cancelada mientras espera no cuenta como llamada. */
  onNonLocalCall?: (ref: ModelRef, ctx: { runId: string }) => void;
  /** Resultado único por llamada no local realmente iniciada. `metrics` sólo existe cuando el
   *  provider entregó un chunk `done`; error/interrupción quedan explícitos y jamás implican costo
   *  cero. `callId` permite correlacionar el registro sin depender del orden de finalización. */
  onNonLocalResult?: (ref: ModelRef, result: {
    callId: string;
    runId: string;
    metrics?: ResponseMetrics;
    error: boolean;
    interrupted: boolean;
  }) => void;
  /** Lee la preferencia persistida en el host. Sólo se consulta para requests a Ollama local; puede
   *  ser async porque SettingsRepository es async. El `numGpu` de un retry OOM en `ChatRequest`
   *  tiene precedencia para que RunController pueda bajar offload sin pelear con la preferencia. */
  resolveLocalChatOptions?: (ref: ModelRef) => LocalChatOptions | undefined | Promise<LocalChatOptions | undefined>;
  /** Política global del host. Se consulta en cada generación para que activar "Solo local" también
   *  bloquee chats/runs ya creados y caminos internos (reintentos, delegación y compactación). */
  isLocalOnlyEnabled?: () => boolean | Promise<boolean>;
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
    const provider = this.resolve(ref);
    // `ModelRef.locality` puede venir de un chat viejo o de un cliente; la configuración viva del
    // provider es la fuente autoritativa para autorización, auditoría y scheduling.
    const effectiveRef: ModelRef = provider.locality === ref.locality
      ? ref
      : { ...ref, locality: provider.locality };
    // Locality: jamás fallback a nube (doc 01 §4.5, ADR de la columna vertebral). Se rinde como
    // ChatChunk de error en vez de lanzar, para que el AgentRuntime lo trate como cualquier otro
    // fallo de generación (mismo canal que 'error' de Provider).
    if (!ctx.authorizedLocality.includes(effectiveRef.locality)) {
      yield {
        type: 'error',
        message: `localidad "${effectiveRef.locality}" no autorizada para este run (authorizedLocality: ${ctx.authorizedLocality.join(', ')})`,
        code: 'unknown',
      };
      return;
    }

    if (effectiveRef.locality !== 'local' && await this.hooks.isLocalOnlyEnabled?.() === true) {
      yield {
        type: 'error',
        message: `"Solo modelos locales" está activado: se bloqueó la generación con el provider ${effectiveRef.providerId} (${effectiveRef.locality}).`,
        code: 'unknown',
      };
      return;
    }

    const effectiveRequest = await this.applyLocalChatOptions(effectiveRef, provider, req);
    const lease = await this.scheduler.acquire(effectiveRef, effectiveRequest.options.numCtx, ctx.priority, ctx.signal);
    // La preferencia pudo cambiar mientras esta request esperaba un slot. Revalidar con el lease ya
    // adquirido cierra esa ventana; se libera antes de emitir el error y nunca se toca el provider.
    let localOnlyAfterAcquire: boolean;
    try {
      localOnlyAfterAcquire = effectiveRef.locality !== 'local'
        && await this.hooks.isLocalOnlyEnabled?.() === true;
    } catch (error) {
      this.scheduler.release(lease);
      throw error;
    }
    if (localOnlyAfterAcquire) {
      this.scheduler.release(lease);
      yield {
        type: 'error',
        message: `"Solo modelos locales" se activó mientras la generación esperaba turno: se bloqueó el provider ${effectiveRef.providerId} (${effectiveRef.locality}).`,
        code: 'unknown',
      };
      return;
    }
    const startedAt = performance.now();
    let ttftRecorded = false;
    let ttftClientMs: number | undefined;
    const isNonLocal = effectiveRef.locality !== 'local';
    const callId = isNonLocal ? randomUUID() : undefined;
    let resultMetrics: ResponseMetrics | undefined;
    let providerError = false;
    let completed = false;
    let providerStreamEnded = false;

    if (isNonLocal) {
      try {
        this.hooks.onNonLocalCall?.(effectiveRef, { runId: ctx.runId });
      } catch (error) {
        console.warn('[ModelGateway] falló el hook legacy de inicio no local', error);
      }
    }

    try {
      for await (const chunk of provider.chat(effectiveRequest, ctx.signal)) {
        if (!ttftRecorded && (chunk.type === 'content' || chunk.type === 'thinking' || chunk.type === 'tool_call')) {
          ttftRecorded = true;
          ttftClientMs = performance.now() - startedAt;
        }
        if (chunk.type === 'done') {
          const metrics = { ...chunk.metrics, ttftClientMs: chunk.metrics.ttftClientMs ?? ttftClientMs };
          resultMetrics = metrics;
          completed = true;
          yield { ...chunk, metrics };
        } else {
          if (chunk.type === 'error') providerError = true;
          yield chunk;
        }
      }
      providerStreamEnded = true;
    } catch (error) {
      providerError = !ctx.signal.aborted;
      throw error;
    } finally {
      if (isNonLocal && callId) {
        try {
          // RunController retorna apenas recibe `done`, lo que cierra este generador antes de que
          // el `for await` avance una vez más. Haber recibido `done` ya es finalización válida.
          const interrupted = !completed && (ctx.signal.aborted || (!providerError && !providerStreamEnded));
          this.hooks.onNonLocalResult?.(effectiveRef, {
            callId,
            runId: ctx.runId,
            metrics: resultMetrics,
            error: !completed && !interrupted && (providerError || providerStreamEnded),
            interrupted,
          });
        } catch (error) {
          // La auditoría no debe convertir una respuesta válida del modelo en una falla del run.
          console.warn('[ModelGateway] no se pudo registrar el resultado no local', error);
        }
      }
      this.scheduler.release(lease);
    }
  }

  private async applyLocalChatOptions(ref: ModelRef, provider: Provider, req: ChatRequest): Promise<ChatRequest> {
    if (ref.locality !== 'local' || provider.kind !== 'ollama' || !this.hooks.resolveLocalChatOptions) return req;
    const configured = await this.hooks.resolveLocalChatOptions(ref);
    if (!configured) return req;

    const numThreads = isPositiveInteger(configured.numThreads) ? configured.numThreads : undefined;
    const configuredNumGpu = isNonNegativeInteger(configured.numGpu) ? configured.numGpu : undefined;
    // RunController agrega numGpu en reintentos OOM: esa degradación puntual debe ganar sobre la
    // preferencia de recursos guardada. Para la primera petición, el ajuste del usuario se aplica.
    const numGpu = req.options.numGpu ?? configuredNumGpu;
    if (numThreads === undefined && numGpu === undefined) return req;
    return { ...req, options: { ...req.options, numThreads: numThreads ?? req.options.numThreads, numGpu } };
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

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}
