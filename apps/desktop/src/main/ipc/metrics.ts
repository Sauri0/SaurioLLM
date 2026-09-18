// Handlers IPC del dominio "metrics" (doc 02 §1: apps/desktop/src/main/ipc/metrics.ts, doc 01 §4.17).
// metrics:snapshot combina SystemSampler (real, apps/desktop) con ModelGateway.status() y
// ModelManager.listLoaded() — el sistema siempre se muestrea medido; slots/queue/loaded quedan
// vacíos si el runtime real no está armado, para no romper el panel de rendimiento mínimo del MVP.
// metrics:setPanelOpen (v0.2, doc 14 §6/§8) arranca/para el muestreo continuo de `MetricsTicker`.
import { ipc } from '@saurio/shared';
import { Diagnostics } from '@saurio/runtime/telemetry/index';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import type { SystemSampler } from '../services/system-sampler/index.js';
import type { MetricsTicker } from '../services/metrics/MetricsTicker.js';
import { registerHandler } from './registerHandler.js';

export function registerMetricsHandlers(host: RuntimeHost, sampler: SystemSampler, ticker: MetricsTicker): void {
  const diagnostics = new Diagnostics();

  registerHandler('metrics:snapshot', ipc['metrics:snapshot'], async () => {
    const system = await sampler.sample();
    if (!host.hasRuntime()) {
      return { slots: [], queue: [], loaded: [], system, diagnostics: [] };
    }

    const { slots, queue } = host.modelGateway.status();
    // /api/ps puede fallar si Ollama no está corriendo; el panel de rendimiento nunca debe romperse
    // por eso (doc 14 §3: el sistema se muestrea siempre, aunque el provider esté caído).
    let loaded: Awaited<ReturnType<typeof host.modelManager.listLoaded>> = [];
    try {
      loaded = await host.modelManager.listLoaded();
    } catch (error) {
      console.warn('[ipc/metrics] no se pudieron listar los modelos cargados', error);
    }

    const health = await Promise.all(host.providers.map((p) => p.health().then((h) => ({ providerId: p.id, ...h }))));
    const diags = [
      ...diagnostics.evaluate({ slots, queue, loaded, system, diagnostics: [] }, []),
      ...diagnostics.evaluateProviderHealth(health),
      ...diagnostics.evaluateQueueBacklog(queue),
    ];
    return { slots, queue, loaded, system, diagnostics: diags };
  });

  // Doc 14 §6/§8: el muestreo continuo (2 s) solo corre mientras el panel está abierto o hay
  // actividad real en el scheduler — `MetricsTicker.setPanelOpen` decide eso, este handler solo
  // reenvía la intención del renderer.
  registerHandler('metrics:setPanelOpen', ipc['metrics:setPanelOpen'], async (input) => {
    ticker.setPanelOpen(input.open);
  });
}
