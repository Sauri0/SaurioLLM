// HardwareProbe: inventario de CPU/RAM/VRAM con calidad explícita — packages/runtime/src/models/HardwareProbe.ts.
// Define: doc 08 §6 (perfiles de hardware, fuentes measured/no confiables) y doc 04 §11
// (HardwareProbe/HardwareProfile). Implementa la interfaz `HardwareProbe` de ./types.ts (contrato,
// no se modifica). MVP: CPU/RAM siempre measured (os.*), VRAM NVIDIA measured bajo demanda vía
// nvidia-smi, registro `qwMemorySize` measured en Windows como respaldo, WMI AdapterRAM como
// último recurso marcado no confiable (quality 'estimated', nunca 'measured').
import { cpus, totalmem, freemem } from 'node:os';
import { createHash } from 'node:crypto';
import { platform } from 'node:process';
import type { HardwareProfile, HardwareDatum } from './types.js';
import type { HardwareProbe as HardwareProbeContract } from './types.js';
import { type CommandRunner, realCommandRunner, POWERSHELL_EXE } from './CommandRunner.js';

export interface HardwareProbeOptions {
  runner?: CommandRunner;
  now?: () => number;
  platformOverride?: NodeJS.Platform;
}

interface NvidiaSmiRow {
  name: string;
  memoryTotalMiB: number;
  memoryUsedMiB: number;
  utilizationPct: number;
  temperatureC: number;
  powerW: number;
  uuid: string;
}

function datum<T>(value: T, quality: HardwareDatum<T>['quality'], source: string, sampledAt: number, unit?: string): HardwareDatum<T> {
  return { value, quality, source, sampledAt, ...(unit ? { unit } : {}) };
}

/** Parsea la salida CSV de `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`.
 *  Formato verificado en la máquina de referencia (RESULTADOS-ollama.md): una fila por GPU,
 *  separada por ", ". Solo se usa la primera GPU en el MVP (sin multi-GPU, v0.4). */
function parseNvidiaSmiCsv(stdout: string): NvidiaSmiRow | undefined {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return undefined;
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length < 6) return undefined;
  const [name, memTotal, memUsed, util, temp, power, uuid] = parts;
  const toNum = (s: string | undefined): number => {
    const n = Number.parseFloat(s ?? '');
    return Number.isFinite(n) ? n : 0;
  };
  return {
    name: name ?? 'nvidia-gpu',
    memoryTotalMiB: toNum(memTotal),
    memoryUsedMiB: toNum(memUsed),
    utilizationPct: toNum(util),
    temperatureC: toNum(temp),
    powerW: toNum(power),
    uuid: uuid ?? name ?? 'unknown',
  };
}

const MIB = 1024 * 1024;

export class HardwareProbe implements HardwareProbeContract {
  private readonly runner: CommandRunner;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private nvidiaSmiAvailable: boolean | undefined;

  constructor(options: HardwareProbeOptions = {}) {
    this.runner = options.runner ?? realCommandRunner;
    this.now = options.now ?? Date.now;
    this.platform = options.platformOverride ?? platform;
  }

  supportsGpuSampling(): boolean {
    // Se resuelve de forma perezosa (requiere haber intentado nvidia-smi al menos una vez);
    // antes del primer sample() se asume optimista para no bloquear la UI con "no soportado".
    return this.nvidiaSmiAvailable ?? true;
  }

  async sample(): Promise<HardwareProfile> {
    const sampledAt = this.now();
    const cpuInfo = cpus();
    const cpuName = cpuInfo[0]?.model?.trim() || 'CPU desconocida';
    const threads = cpuInfo.length;

    const ramTotal = totalmem();
    const ramFree = freemem();

    const gpuRow = await this.probeNvidiaSmi();
    const gpu = gpuRow
      ? {
          vendor: 'nvidia' as const,
          vramTotalBytes: datum(gpuRow.memoryTotalMiB * MIB, 'measured' as const, 'nvidia-smi', sampledAt, 'bytes'),
          vramUsedBytes: datum(gpuRow.memoryUsedMiB * MIB, 'measured' as const, 'nvidia-smi', sampledAt, 'bytes'),
          utilizationPct: datum(gpuRow.utilizationPct, 'measured' as const, 'nvidia-smi', sampledAt, '%'),
          temperatureC: datum(gpuRow.temperatureC, 'measured' as const, 'nvidia-smi', sampledAt, 'C'),
          powerW: datum(gpuRow.powerW, 'measured' as const, 'nvidia-smi', sampledAt, 'W'),
        }
      : await this.fallbackGpu(sampledAt);

    const fingerprint = this.fingerprint({
      gpuUuid: gpuRow?.uuid,
      vramTotal: gpu?.vramTotalBytes.value,
      cpuModel: cpuName,
      ramTotal,
    });

    return {
      cpu: {
        name: datum(cpuName, 'measured', 'os.cpus', sampledAt),
        threads: datum(threads, 'measured', 'os.cpus', sampledAt),
      },
      ram: {
        totalBytes: datum(ramTotal, 'measured', 'os.totalmem', sampledAt, 'bytes'),
        freeBytes: datum(ramFree, 'measured', 'os.freemem', sampledAt, 'bytes'),
      },
      ...(gpu ? { gpu } : {}),
      fingerprint,
      sampledAt,
    };
  }

  private async probeNvidiaSmi(): Promise<NvidiaSmiRow | undefined> {
    try {
      const { stdout } = await this.runner('nvidia-smi', [
        '--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw,uuid',
        '--format=csv,noheader,nounits',
      ]);
      const row = parseNvidiaSmiCsv(stdout);
      this.nvidiaSmiAvailable = row !== undefined;
      return row;
    } catch {
      this.nvidiaSmiAvailable = false;
      return undefined;
    }
  }

  /** Sin nvidia-smi (GPU no NVIDIA o ausente): en Windows se intenta el registro
   *  `HKLM\SYSTEM\...\qwMemorySize` vía PowerShell (measured, mismo valor que reporta el panel
   *  de administrador de dispositivos); si eso también falla, WMI `AdapterRAM` queda como último
   *  recurso y se marca explícitamente 'estimated' (no confiable: WMI trunca a 4 GiB — doc 08 §6). */
  private async fallbackGpu(sampledAt: number): Promise<HardwareProfile['gpu']> {
    if (this.platform !== 'win32') return undefined;
    const qwMemorySize = await this.readQwMemorySize();
    if (qwMemorySize !== undefined) {
      return {
        vendor: 'other',
        vramTotalBytes: datum(qwMemorySize, 'measured', 'registry:qwMemorySize', sampledAt, 'bytes'),
      };
    }
    const wmiAdapterRam = await this.readWmiAdapterRam();
    if (wmiAdapterRam !== undefined) {
      return {
        vendor: 'other',
        // WMI AdapterRAM trunca a 4 GiB en muchos drivers: nunca se marca 'measured'.
        vramTotalBytes: datum(wmiAdapterRam, 'estimated', 'wmi:AdapterRAM', sampledAt, 'bytes'),
      };
    }
    return undefined;
  }

  private async readQwMemorySize(): Promise<number | undefined> {
    try {
      const script =
        "Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000' " +
        "-Name 'HardwareInformation.qwMemorySize' -ErrorAction Stop | Select-Object -ExpandProperty 'HardwareInformation.qwMemorySize'";
      const { stdout } = await this.runner(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', script]);
      const n = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  }

  private async readWmiAdapterRam(): Promise<number | undefined> {
    try {
      const script = 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty AdapterRAM';
      const { stdout } = await this.runner(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-Command', script]);
      const n = Number.parseInt(stdout.trim().split(/\r?\n/)[0] ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  }

  private fingerprint(input: { gpuUuid?: string; vramTotal?: number; cpuModel: string; ramTotal: number }): string {
    const raw = `${input.gpuUuid ?? 'no-gpu'}|${input.vramTotal ?? 0}|${input.cpuModel}|${input.ramTotal}`;
    return createHash('sha256').update(raw).digest('hex');
  }
}
