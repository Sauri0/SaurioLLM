// Test de Scheduler (InferenceScheduler) — packages/runtime/src/gateway/Scheduler.test.ts.
// Cubre: 1 slot, cola por (providerId, modelName), prioridad, agrupamiento por modelo, abort en cola.
import { describe, expect, it } from 'vitest';
import { Scheduler } from './Scheduler.js';
import type { ModelRef } from '@saurio/shared';

const REF_A: ModelRef = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' };
const REF_B: ModelRef = { providerId: 'ollama', name: 'qwen2.5-coder:7b', locality: 'local' };

describe('gateway/Scheduler', () => {
  it('con 1 slot, otorga la primera acquire() de inmediato', async () => {
    const scheduler = new Scheduler({ slots: 1, groupByModel: true });
    const lease = await scheduler.acquire(REF_A, 8192, 'interactive', new AbortController().signal);
    expect(lease.ref).toEqual(REF_A);
    const status = scheduler.status();
    expect(status.slots).toHaveLength(1);
    expect(status.slots[0]?.state).toBe('loading'); // primera carga de este modelo en el slot
  });

  it('una segunda acquire() con el slot ocupado queda en cola hasta release()', async () => {
    const scheduler = new Scheduler({ slots: 1, groupByModel: true });
    const lease1 = await scheduler.acquire(REF_A, 8192, 'interactive', new AbortController().signal);

    let resolved = false;
    const p2 = scheduler.acquire(REF_A, 8192, 'interactive', new AbortController().signal).then((l) => {
      resolved = true;
      return l;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    expect(scheduler.status().queue).toHaveLength(1);

    scheduler.release(lease1);
    const lease2 = await p2;
    expect(lease2.ref).toEqual(REF_A);
    expect(scheduler.status().queue).toHaveLength(0);
  });

  it('agrupa por modelo: prioriza terminar el lote del modelo cargado antes de rotar (doc 08 §7.3)', async () => {
    const scheduler = new Scheduler({ slots: 1, groupByModel: true });
    const lease1 = await scheduler.acquire(REF_A, 8192, 'interactive', new AbortController().signal);

    // en cola: un job del modelo B (llegó primero) y uno del modelo A (llegó después)
    const order: string[] = [];
    const pB = scheduler.acquire(REF_B, 8192, 'interactive', new AbortController().signal).then((l) => { order.push(l.ref.name); return l; });
    await new Promise((r) => setTimeout(r, 5));
    const pA = scheduler.acquire(REF_A, 8192, 'interactive', new AbortController().signal).then((l) => { order.push(l.ref.name); return l; });
    await new Promise((r) => setTimeout(r, 5));

    scheduler.release(lease1); // libera con currentModel = REF_A -> debe preferir el job de A, no B
    const leaseA = await pA;
    expect(leaseA.ref).toEqual(REF_A);
    expect(order).toEqual(['qwen3:8b']);

    scheduler.release(leaseA);
    await pB;
    expect(order).toEqual(['qwen3:8b', 'qwen2.5-coder:7b']);
  });

  it('prioridad: interactive salta adelante de warmup en la misma cola de modelo', async () => {
    const scheduler = new Scheduler({ slots: 1, groupByModel: true });
    const lease1 = await scheduler.acquire(REF_B, 8192, 'interactive', new AbortController().signal);

    const order: string[] = [];
    const pWarmup = scheduler.acquire(REF_A, 8192, 'warmup', new AbortController().signal).then((l) => { order.push('warmup'); return l; });
    await new Promise((r) => setTimeout(r, 5));
    const pInteractive = scheduler.acquire(REF_A, 8192, 'interactive', new AbortController().signal).then((l) => { order.push('interactive'); return l; });
    await new Promise((r) => setTimeout(r, 5));

    scheduler.release(lease1); // libera con currentModel = REF_B; ninguno de los dos en cola es B -> se usa prioridad global
    const leaseInteractive = await pInteractive; // gana por prioridad aunque haya llegado después
    expect(order).toEqual(['interactive']);

    scheduler.release(leaseInteractive);
    await pWarmup;
    expect(order).toEqual(['interactive', 'warmup']);
  });

  it('abortar el signal mientras está en cola rechaza la promesa y la saca de la cola', async () => {
    const scheduler = new Scheduler({ slots: 1, groupByModel: true });
    await scheduler.acquire(REF_A, 8192, 'interactive', new AbortController().signal);

    const controller = new AbortController();
    const pending = scheduler.acquire(REF_A, 8192, 'interactive', controller.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(scheduler.status().queue).toHaveLength(1);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(scheduler.status().queue).toHaveLength(0);
  });

  it('acquire() con signal ya abortado rechaza de inmediato sin tocar la cola', async () => {
    const scheduler = new Scheduler({ slots: 1, groupByModel: true });
    const controller = new AbortController();
    controller.abort();
    await expect(scheduler.acquire(REF_A, 8192, 'interactive', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(scheduler.status().queue).toHaveLength(0);
  });

  it("'auto' resuelve a 1 slot (doc 08 §7.1)", () => {
    const scheduler = new Scheduler({ slots: 'auto', groupByModel: true });
    expect(scheduler.status().slots).toHaveLength(1);
  });

  it('release() de una segunda generación del mismo modelo ya cargado marca el slot busy, no loading', async () => {
    const scheduler = new Scheduler({ slots: 1, groupByModel: true });
    const lease1 = await scheduler.acquire(REF_A, 8192, 'interactive', new AbortController().signal);
    scheduler.release(lease1);
    const lease2 = await scheduler.acquire(REF_A, 8192, 'interactive', new AbortController().signal);
    expect(scheduler.status().slots[0]?.state).toBe('busy');
    scheduler.release(lease2);
  });
});
