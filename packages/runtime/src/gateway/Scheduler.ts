// InferenceScheduler: slots de inferencia y cola por modelo — packages/runtime/src/gateway/Scheduler.ts.
// Define: doc 08-model-manager-y-scheduler.md §7 (Scheduler: slots, ModelQueue, agrupamiento,
// keep_alive) y doc 04 §3 (interfaz InferenceScheduler/SlotLease). Vive DENTRO de ModelGateway
// (ADR-5); nadie más lo instancia.
import type { ModelRef } from '@saurio/shared';
import type { ChatContext, InferenceScheduler, SchedulerConfig, SlotLease, SlotStatus, QueuedJob } from './types.js';

const PRIORITY_ORDER: Record<ChatContext['priority'], number> = {
  interactive: 0, subagent: 1, benchmark: 2, warmup: 3,
};

interface SlotState {
  readonly id: string;
  state: 'idle' | 'loading' | 'busy';
  providerId: string;
  currentModel?: ModelRef;
  leaseHolderJobId?: string;
}

interface QueueEntry {
  readonly id: string;
  readonly ref: ModelRef;
  readonly numCtx: number;
  readonly priority: ChatContext['priority'];
  readonly enqueuedAt: number;
  readonly resolve: (lease: SlotLease) => void;
  readonly reject: (err: unknown) => void;
  readonly onAbort: () => void;
  readonly signal: AbortSignal;
}

/** `'auto'` resuelve a 1 (doc 08 §7.1: local con VRAM < 24 GiB, el caso medido en este equipo —
 *  8192 MiB). El cálculo de perfil de hardware para N slots reales (24 GiB+, v0.4) vive fuera de
 *  este módulo (HardwareProbe, packages/runtime/src/models/) y no se referencia acá: el Scheduler
 *  solo consume el número ya resuelto que le pasa quien lo instancia. */
function resolveSlotCount(config: SchedulerConfig): number {
  return config.slots === 'auto' ? 1 : config.slots;
}

export class Scheduler implements InferenceScheduler {
  private readonly slots: SlotState[];
  private readonly queue: QueueEntry[] = [];
  private seq = 0;

  constructor(config: SchedulerConfig) {
    const count = resolveSlotCount(config);
    this.slots = Array.from({ length: count }, (_, i) => ({
      id: `slot-${i}`, state: 'idle', providerId: '',
    }));
  }

  acquire(ref: ModelRef, numCtx: number, priority: ChatContext['priority'], signal: AbortSignal): Promise<SlotLease> {
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise<SlotLease>((resolve, reject) => {
      const freeSlot = this.slots.find((s) => s.state === 'idle');
      if (freeSlot !== undefined) {
        this.assign(freeSlot, { ref, numCtx, priority, id: `job-${(this.seq += 1)}` });
        resolve({ slotId: freeSlot.id, ref, acquiredAt: Date.now() });
        return;
      }
      const id = `job-${(this.seq += 1)}`;
      const onAbort = (): void => {
        const idx = this.queue.findIndex((e) => e.id === id);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        }
      };
      const entry: QueueEntry = { id, ref, numCtx, priority, enqueuedAt: Date.now(), resolve: (lease) => {
        signal.removeEventListener('abort', onAbort);
        resolve(lease);
      }, reject: (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }, onAbort, signal };
      signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  release(lease: SlotLease): void {
    const slot = this.slots.find((s) => s.id === lease.slotId);
    if (slot === undefined) return;
    slot.state = 'idle';
    slot.leaseHolderJobId = undefined;
    this.pump(slot);
  }

  status(): { slots: SlotStatus[]; queue: QueuedJob[] } {
    return {
      slots: this.slots.map((s) => ({
        slotId: s.id, providerId: s.providerId, state: s.state,
        currentModel: s.currentModel, leaseHolderRunId: s.leaseHolderJobId,
      })),
      // `runId` acá es el id interno del job en cola: la interfaz InferenceScheduler.acquire()
      // (doc 04 §3) no recibe ChatContext.runId como parámetro, así que el Scheduler no puede
      // conocer el runId real del caller sin cambiar esa interfaz de contrato — ver deviations.
      queue: this.queue.map((e) => ({ runId: e.id, ref: e.ref, priority: e.priority, enqueuedAt: e.enqueuedAt })),
    };
  }

  /** Doc 08 §7.3: mientras haya trabajo encolado para el modelo ya cargado, no se cambia de
   *  modelo — se prioriza el mismo modelo del slot que se acaba de liberar; si no hay trabajo para
   *  ese modelo, se toma el de mayor prioridad (interactive > subagent > benchmark > warmup) y,
   *  dentro de la misma prioridad, el más antiguo en cola (FIFO). */
  private pump(slot: SlotState): void {
    if (this.queue.length === 0) return;
    const sameModel = this.queue.filter((e) => (
      slot.currentModel !== undefined
      && e.ref.providerId === slot.currentModel.providerId
      && e.ref.name === slot.currentModel.name
    ));
    const pool = sameModel.length > 0 ? sameModel : this.queue;
    const next = [...pool].sort((a, b) => (
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.enqueuedAt - b.enqueuedAt
    ))[0];
    if (next === undefined) return;
    const idx = this.queue.findIndex((e) => e.id === next.id);
    if (idx !== -1) this.queue.splice(idx, 1);
    this.assign(slot, next);
    next.resolve({ slotId: slot.id, ref: next.ref, acquiredAt: Date.now() });
  }

  private assign(slot: SlotState, job: { id: string; ref: ModelRef; numCtx: number; priority: ChatContext['priority'] }): void {
    const isSameModel = slot.currentModel !== undefined
      && slot.currentModel.providerId === job.ref.providerId
      && slot.currentModel.name === job.ref.name;
    slot.state = isSameModel ? 'busy' : 'loading';
    slot.providerId = job.ref.providerId;
    slot.currentModel = job.ref;
    slot.leaseHolderJobId = job.id;
  }
}
