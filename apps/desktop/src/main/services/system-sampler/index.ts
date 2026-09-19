// SystemSampler: os.cpus()/os.freemem() (MVP) + nvidia-smi bajo demanda (doc 01 §4.17, doc 14 §"…").
// Vive en apps/desktop/src/main (nunca en packages/runtime, que es Node puro y no importa `electron`
// — doc 02, doc 14 §"SystemSampler"). Responsable exclusivo del muestreo de sistema (CPU/RAM/GPU) y
// de la RSS del propio proceso Electron; Telemetry (packages/runtime/src/telemetry/, v0.2/MVP-parcial)
// consume estas muestras por inyección (HostAdapter), nunca llama nvidia-smi ni os.* directamente.
import os from 'node:os';
import type { SystemSample } from '@saurio/shared';
import { execFileHidden, type ExecHiddenResult } from '../process/spawnHidden.js';

export type ExecNvidiaSmiFn = (command: string, args: readonly string[]) => Promise<ExecHiddenResult>;

export interface GpuSample {
  utilPct: number;
  vramUsedBytes: number;
  tempC: number;
  powerW: number;
}

/** Ejecuta `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` bajo demanda (MVP: sin loop
 *  continuo, eso es `-lms` en v0.2 — doc 02 §1). Devuelve null si el binario no está en PATH o si
 *  la GPU no es NVIDIA; nunca lanza, para que metrics:snapshot siga funcionando sin GPU.
 *
 *  BUG REAL v0.2.0 ("ventanas de consola parpadeando al iniciar"): este `exec` usaba antes
 *  `util.promisify(child_process.execFile)` invocado como `exec(file, args)` — SIN un tercer
 *  argumento de opciones, por lo que `windowsHide` nunca se aplicaba. Cada muestra (cada 2s con el
 *  panel de rendimiento abierto, doc 14 §6) abría y cerraba una ventana de consola en Windows. Ahora
 *  usa `execFileHidden`, que fuerza `windowsHide: true` siempre. */
export async function sampleNvidiaSmi(
  exec: ExecNvidiaSmiFn = execFileHidden,
): Promise<GpuSample | null> {
  try {
    const { stdout } = await exec('nvidia-smi', [
      '--query-gpu=utilization.gpu,memory.used,temperature.gpu,power.draw',
      '--format=csv,noheader,nounits',
    ]);
    const firstLine = stdout.trim().split('\n')[0] ?? '';
    const parts = firstLine.split(',').map((s) => Number.parseFloat(s.trim()));
    const [utilPct, vramUsedMib, tempC, powerW] = parts;
    if (parts.some((n) => Number.isNaN(n)) || parts.length < 4) return null;
    return {
      utilPct: utilPct as number,
      vramUsedBytes: (vramUsedMib as number) * 1024 * 1024,
      tempC: tempC as number,
      powerW: powerW as number,
    };
  } catch {
    return null;
  }
}

/** CPU% instantáneo por diferencia entre dos lecturas de os.cpus() separadas por `sampleMs`
 *  (os.cpus() da contadores acumulados, no un %; un único snapshot no alcanza). */
export async function sampleCpuPct(sampleMs = 100, cpus: () => os.CpuInfo[] = os.cpus): Promise<number> {
  const start = cpus();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const end = cpus();

  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < start.length; i++) {
    const a = start[i];
    const b = end[i];
    if (!a || !b) continue;
    const idle = b.times.idle - a.times.idle;
    const total =
      b.times.user - a.times.user +
      (b.times.nice - a.times.nice) +
      (b.times.sys - a.times.sys) +
      (b.times.irq - a.times.irq) +
      idle;
    idleDelta += idle;
    totalDelta += total;
  }
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
}

export interface SystemSamplerDeps {
  cpus?: () => os.CpuInfo[];
  totalmem?: () => number;
  freemem?: () => number;
  execNvidiaSmi?: ExecNvidiaSmiFn;
  /** RSS del proceso Electron (`app.getAppMetrics()`); inyectado porque `electron` no se importa
   *  fuera de apps/desktop y este módulo se testea sin Electron levantado. */
  appRssBytes?: () => number;
}

export class SystemSampler {
  private readonly cpus: () => os.CpuInfo[];
  private readonly totalmem: () => number;
  private readonly freemem: () => number;
  private readonly execNvidiaSmi: ExecNvidiaSmiFn;
  private readonly appRssBytes: () => number;
  private gpuAvailable: boolean | undefined;
  /** Bug real v0.2.0 ("no reintentar en bucle fuentes que no existen"): en un equipo sin NVIDIA
   *  (p. ej. el reportado, Intel Core Ultra 9 288V + iGPU Arc) `sample()` se llama cada 2s mientras el
   *  panel de rendimiento está abierto (doc 14 §6) — sin esta bandera, cada tick volvía a spawnear
   *  `nvidia-smi` sabiendo de antemano que iba a fallar. Una vez que la PRIMERA muestra confirma que
   *  `nvidia-smi` no está disponible, se deja de invocar hasta un refresco manual explícito
   *  (`refreshGpuAvailability()`, p. ej. si el usuario conecta una GPU externa en caliente). */
  private gpuProbeAttempted = false;

  constructor(deps: SystemSamplerDeps = {}) {
    this.cpus = deps.cpus ?? os.cpus;
    this.totalmem = deps.totalmem ?? os.totalmem;
    this.freemem = deps.freemem ?? os.freemem;
    this.execNvidiaSmi = deps.execNvidiaSmi ?? execFileHidden;
    this.appRssBytes = deps.appRssBytes ?? (() => process.memoryUsage().rss);
  }

  /** true si la última muestra de nvidia-smi funcionó; false si nunca se pudo muestrear (ausente
   *  o GPU no NVIDIA). `undefined` antes de la primera muestra (doc 04 §11: "supportsGpuSampling"). */
  supportsGpuSampling(): boolean | undefined {
    return this.gpuAvailable;
  }

  /** Refresco manual (encargo, punto 2: "no reintentar en bucle... backoff"): vuelve a intentar
   *  `nvidia-smi` en el próximo `sample()` aunque ya se haya confirmado ausente antes. */
  refreshGpuAvailability(): void {
    this.gpuProbeAttempted = false;
  }

  async sample(): Promise<SystemSample> {
    const sampledAt = Date.now();
    const cpuPct = await sampleCpuPct(100, this.cpus);
    const ramUsedBytes = this.totalmem() - this.freemem();
    const gpu = this.gpuProbeAttempted && this.gpuAvailable === false
      ? null
      : await sampleNvidiaSmi(this.execNvidiaSmi);
    this.gpuProbeAttempted = true;
    this.gpuAvailable = gpu !== null;

    const result: SystemSample = {
      cpuPct: { value: cpuPct, quality: 'measured', source: 'os.cpus()', sampledAt },
      ramUsedBytes: { value: ramUsedBytes, quality: 'measured', source: 'os.totalmem()-os.freemem()', sampledAt },
      appRssBytes: { value: this.appRssBytes(), quality: 'measured', source: 'process.memoryUsage().rss', sampledAt },
    };
    if (gpu) {
      result.gpuUtilPct = { value: gpu.utilPct, quality: 'measured', source: 'nvidia-smi', sampledAt };
      result.vramUsedBytes = { value: gpu.vramUsedBytes, quality: 'measured', source: 'nvidia-smi', sampledAt };
      result.gpuTempC = { value: gpu.tempC, quality: 'measured', source: 'nvidia-smi', sampledAt };
      result.powerW = { value: gpu.powerW, quality: 'measured', source: 'nvidia-smi', sampledAt };
    }
    return result;
  }
}
