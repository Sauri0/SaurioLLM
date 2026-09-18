// Muestreo continuo del panel de rendimiento (doc 14 §6/§8, v0.2) — apps/desktop/src/main/services/
// metrics/MetricsTicker.ts. Corre SOLO mientras el panel está abierto o hay actividad real en el
// ModelGateway (slot ocupado/cargando o cola no vacía) — nunca en reposo sin nadie mirando (doc 14
// §8: "el muestreo tiene que ser más barato que el problema que mide"). Agrega diagnósticos (offload,
// health, contexto, poca VRAM, cola larga) y persiste el minuto en curso vía
// `SqlMetricsMinuteRepository`. Vive en apps/desktop (no en packages/runtime) porque orquesta
// `SystemSampler` (Electron) + `RuntimeHost`, igual que el resto de `main/services`.
import type { MetricsSnapshot } from '@saurio/shared';
import { Diagnostics } from '@saurio/runtime/telemetry/index';
import type { RuntimeHost } from '../../host/RuntimeHost.js';
import type { SystemSampler } from '../system-sampler/index.js';
import type { SqlMetricsMinuteRepository } from './SqlMetricsMinuteRepository.js';

const DEFAULT_INTERVAL_MS = 2000; // doc 14 §6: "2 s activo" para CPU/RAM/GPU con el panel abierto
/** Vigía liviano (solo lee `ModelGateway.status()` en memoria, sin spawnear nada) para detectar que
 *  arrancó un run mientras el panel está cerrado, sin que `ipc/run.ts` tenga que conocer a
 *  `MetricsTicker` (evita acoplar el dominio "run" con telemetría). */
const WATCHDOG_INTERVAL_MS = 3000;

export class MetricsTicker {
  private readonly diagnostics = new Diagnostics();
  private timer: NodeJS.Timeout | undefined;
  private readonly watchdog: NodeJS.Timeout;
  private panelOpen = false;
  private vramTotalBytesCache: number | undefined;

  constructor(
    private readonly sampler: SystemSampler,
    private readonly host: RuntimeHost,
    private readonly minuteRepo: SqlMetricsMinuteRepository | undefined,
    private readonly onTick: (snapshot: MetricsSnapshot) => void,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {
    this.watchdog = setInterval(() => this.reconcile(), WATCHDOG_INTERVAL_MS);
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    this.reconcile();
  }

  /** Se llama tras cada cambio de estado del scheduler que pueda arrancar/vaciar la cola (p. ej. al
   *  iniciar/terminar un run); barato (solo lee `status()` en memoria, sin spawnear nada). */
  reconcile(): void {
    const shouldRun = this.panelOpen || this.hasGatewayActivity();
    if (shouldRun && !this.timer) this.start();
    if (!shouldRun && this.timer) this.stop();
  }

  private hasGatewayActivity(): boolean {
    if (!this.host.hasRuntime()) return false;
    const { slots, queue } = this.host.modelGateway.status();
    return queue.length > 0 || slots.some((s) => s.state !== 'idle');
  }

  private start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Corta ambos timers y vuelca el minuto parcial en curso (doc 14 §5: no perder la última
   *  ventana). */
  dispose(): void {
    this.stop();
    clearInterval(this.watchdog);
    this.minuteRepo?.flushCurrent();
  }

  private async vramTotalBytes(): Promise<number | undefined> {
    if (this.vramTotalBytesCache !== undefined) return this.vramTotalBytesCache;
    if (!this.host.hasRuntime()) return undefined;
    try {
      const hw = await this.host.hardwareProbe.sample();
      this.vramTotalBytesCache = hw.gpu?.vramTotalBytes.value;
      return this.vramTotalBytesCache;
    } catch {
      return undefined;
    }
  }

  private async tick(): Promise<void> {
    const system = await this.sampler.sample();
    let slots: MetricsSnapshot['slots'] = [];
    let queue: MetricsSnapshot['queue'] = [];
    let loaded: MetricsSnapshot['loaded'] = [];
    if (this.host.hasRuntime()) {
      const status = this.host.modelGateway.status();
      slots = status.slots;
      queue = status.queue;
      loaded = await this.host.modelManager.listLoaded().catch(() => []);
    }

    const diagnostics = [
      ...this.diagnostics.evaluate({ slots, queue, loaded, system, diagnostics: [] }, []),
      ...this.diagnostics.evaluateQueueBacklog(queue),
      ...this.diagnostics.evaluateLowVram(system, await this.vramTotalBytes()),
    ];

    const snapshot: MetricsSnapshot = { slots, queue, loaded, system, diagnostics };
    this.onTick(snapshot);

    this.minuteRepo?.addSample({
      cpuPct: system.cpuPct.value,
      ramUsedBytes: system.ramUsedBytes.value,
      gpuUtilPct: system.gpuUtilPct?.value,
      vramUsedBytes: system.vramUsedBytes?.value,
      gpuTempC: system.gpuTempC?.value,
      powerW: system.powerW?.value,
      appRssBytes: system.appRssBytes.value,
      quality: {
        cpu: system.cpuPct.quality,
        ram: system.ramUsedBytes.quality,
        gpu: system.gpuUtilPct?.quality ?? 'unavailable',
      },
    });

    // La actividad del gateway puede haber terminado durante este tick (p. ej. un run que cerró);
    // reevaluar acá evita quedarse muestreando de más cuando el panel está cerrado.
    if (!this.panelOpen) this.reconcile();
  }
}
