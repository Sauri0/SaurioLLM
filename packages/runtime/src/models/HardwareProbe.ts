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

/** Puerto opcional hacia el texto del log de `ollama serve` (stdout capturado por la app al
 *  lanzarlo, o `%LOCALAPPDATA%\Ollama\server.log`) — lo expone el host (apps/desktop) una vez que el
 *  agente de proceso de Ollama lo tenga andando; hasta entonces `sample()` sigue el camino previo
 *  (nvidia-smi -> registro de Windows) sin romper nada. Es la única fuente que cubre GPUs sin
 *  `nvidia-smi` (Intel/AMD/Apple, doc 13 §7 "v0.2: AMD/Apple vía log de Ollama") — Ollama mismo ya
 *  sondeó el hardware real con su propio backend (Vulkan/Metal/ROCm) y lo vuelca en la línea
 *  `msg="inference compute"` (`[VERIFICADO EN DOC OFICIAL: discover/types.go, LogDetails(), repo
 *  ollama/ollama]`). */
export interface OllamaInferenceComputeSource {
  read(): Promise<string | undefined>;
}

export interface HardwareProbeOptions {
  runner?: CommandRunner;
  now?: () => number;
  platformOverride?: NodeJS.Platform;
  inferenceComputeSource?: OllamaInferenceComputeSource;
  /** RAM total inyectable para tests (por defecto `os.totalmem()`); usada también por el fallback de
   *  memoria unificada de última instancia. */
  totalMemOverride?: () => number;
  /** `false` por defecto a propósito: sin ninguna señal real (ni `nvidia-smi`, ni log de Ollama, ni
   *  registro de Windows) lo más honesto sigue siendo `gpu: undefined` — inventar una GPU de la nada
   *  en, por ejemplo, un servidor headless sin GPU sería peor que no reportar nada. El host
   *  (apps/desktop) lo prende explícitamente solo en plataformas donde tiene sentido asumir memoria
   *  unificada (win32/darwin) — ver comentario de `unifiedMemoryFallback`. */
  assumeUnifiedMemoryFallback?: boolean;
}

export interface OllamaInferenceDevice {
  id: string;
  name: string;
  /** `'iGPU' | 'discrete' | 'cpu' | ''` tal cual lo escribe Ollama (`discover/types.go`); se guarda
   *  crudo porque el valor exacto puede cambiar entre versiones y este parser es tolerante a propósito. */
  type: string;
  totalBytes: number;
  availableBytes: number;
  raw: Record<string, string>;
}

/** Parsea "X.X GiB"/"MiB"/"KiB"/"B" — el formato exacto de `format.HumanBytes2` de Ollama
 *  [VERIFICADO EN DOC OFICIAL: format/bytes.go, repo ollama/ollama]. */
function parseHumanBytes2(text: string): number | undefined {
  const m = /^([\d.]+)\s*(GiB|MiB|KiB|B)$/i.exec(text.trim());
  if (!m) return undefined;
  const value = Number.parseFloat(m[1] ?? '');
  if (!Number.isFinite(value)) return undefined;
  const unit = (m[2] ?? '').toLowerCase();
  const mult = unit === 'gib' ? 1024 ** 3 : unit === 'mib' ? 1024 ** 2 : unit === 'kib' ? 1024 : 1;
  return Math.round(value * mult);
}

/** Extrae pares `clave=valor` de una línea de log de `log/slog` (Go), con o sin comillas
 *  (`name="Intel(R) Arc(TM) 140V GPU"` vs `type=iGPU`) — tolerante a espacios dentro de valores
 *  citados y a campos ausentes. */
function parseSlogFields(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const re = /([A-Za-z_][\w.]*)=("(?:[^"\\]|\\.)*"|\S*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const key = m[1] ?? '';
    let value = m[2] ?? '';
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    fields[key] = value;
  }
  return fields;
}

/** Parsea todas las líneas `msg="inference compute"` del log de `ollama serve` (doc 13 §7 v0.2: única
 *  fuente medida para GPUs sin `nvidia-smi`). Devuelve un dispositivo por línea, en el orden en que
 *  aparecen (Ollama las loggea una vez por dispositivo cada vez que arranca/recarga, así que un log
 *  largo puede repetir el mismo id — el llamador se queda con la ÚLTIMA aparición de cada id). */
export function parseOllamaInferenceComputeLog(text: string): OllamaInferenceDevice[] {
  const byId = new Map<string, OllamaInferenceDevice>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('inference compute')) continue;
    const fields = parseSlogFields(line);
    if (fields['msg'] !== 'inference compute') continue;
    const total = parseHumanBytes2(fields['total'] ?? '');
    if (total === undefined) continue;
    const available = parseHumanBytes2(fields['available'] ?? '') ?? total;
    const id = fields['id'] ?? String(byId.size);
    byId.set(id, { id, name: fields['name'] ?? 'gpu', type: fields['type'] ?? '', totalBytes: total, availableBytes: available, raw: fields });
  }
  return [...byId.values()];
}

/** Heurística de vendor a partir del nombre del dispositivo — Ollama no manda un campo `vendor`
 *  explícito en la línea de log, solo `name`/`driver`/`library` (doc 13 §7: "Ollama ya sondeó el
 *  hardware real"; acá solo se clasifica el texto que ya trajo). */
function guessVendorFromName(name: string): 'nvidia' | 'amd' | 'intel' | 'apple' | 'other' {
  const n = name.toLowerCase();
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/.test(n)) return 'nvidia';
  if (/intel|arc\b|iris/.test(n)) return 'intel';
  if (/amd|radeon|ryzen ai/.test(n)) return 'amd';
  if (/apple|\bm[1-4]\b/.test(n)) return 'apple';
  return 'other';
}

/** Proporción de la RAM total que un iGPU/memoria unificada puede reclamar en la práctica cuando no
 *  hay ninguna fuente medida (ni `nvidia-smi`, ni log de Ollama, ni registro de Windows) — último
 *  recurso, siempre `quality: 'estimated'`. `[HIPÓTESIS A PROBAR]`: el dato real medido en el equipo
 *  #2 (Intel Core Ultra 9 288V, 32 GB RAM, Ollama reporta 18.0 GiB para el iGPU) da ~56%, dentro del
 *  rango 50-60% que reportó el relevamiento de esa máquina — se usa 0.55 como punto medio. */
const UNIFIED_MEMORY_CEILING_RATIO = 0.55;

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
  private readonly options: HardwareProbeOptions;
  private nvidiaSmiAvailable: boolean | undefined;

  constructor(options: HardwareProbeOptions = {}) {
    this.options = options;
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
    let gpu: HardwareProfile['gpu'] = gpuRow
      ? {
          vendor: 'nvidia' as const,
          vramTotalBytes: datum(gpuRow.memoryTotalMiB * MIB, 'measured' as const, 'nvidia-smi', sampledAt, 'bytes'),
          vramUsedBytes: datum(gpuRow.memoryUsedMiB * MIB, 'measured' as const, 'nvidia-smi', sampledAt, 'bytes'),
          utilizationPct: datum(gpuRow.utilizationPct, 'measured' as const, 'nvidia-smi', sampledAt, '%'),
          temperatureC: datum(gpuRow.temperatureC, 'measured' as const, 'nvidia-smi', sampledAt, 'C'),
          powerW: datum(gpuRow.powerW, 'measured' as const, 'nvidia-smi', sampledAt, 'W'),
        }
      : undefined;

    // Doc 13 §7 v0.2 / hardware real del equipo #2 (Intel Core Ultra 9 288V + Arc 140V iGPU, sin
    // nvidia-smi): el log de `ollama serve` ya sondeó el hardware con su propio backend (Vulkan en
    // Windows/Intel, Metal en Apple, ROCm en AMD) — se usa como segunda fuente antes de caer al
    // registro de Windows (menos preciso: no distingue uso actual, solo el total instalado).
    if (!gpu) gpu = await this.probeOllamaInferenceCompute(sampledAt);
    if (!gpu) gpu = await this.fallbackGpu(sampledAt);
    if (!gpu && this.options.assumeUnifiedMemoryFallback && (this.platform === 'win32' || this.platform === 'darwin')) {
      gpu = this.unifiedMemoryFallback(sampledAt);
    }

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

  /** Segunda fuente (doc 13 §7 v0.2): línea `msg="inference compute"` del log de `ollama serve`, la
   *  única que cubre iGPU Intel/AMD y Apple Silicon sin depender de `nvidia-smi`. Se queda con el
   *  dispositivo de mayor `totalBytes` que no sea la fila de CPU (`id === 'cpu'`) — Ollama loggea una
   *  fila por dispositivo elegible, ordenadas por preferencia de scheduling. Sin `inferenceComputeSource`
   *  inyectado (todavía no cableado en `apps/desktop`, ver comentario del puerto) devuelve `undefined`
   *  de inmediato, sin romper nada. */
  private async probeOllamaInferenceCompute(sampledAt: number): Promise<HardwareProfile['gpu']> {
    const source = this.options.inferenceComputeSource;
    if (!source) return undefined;
    let text: string | undefined;
    try {
      text = await source.read();
    } catch {
      return undefined;
    }
    if (!text) return undefined;
    const devices = parseOllamaInferenceComputeLog(text).filter((d) => d.id !== 'cpu' && d.type !== '');
    if (devices.length === 0) return undefined;
    const best = devices.reduce((a, b) => (b.totalBytes > a.totalBytes ? b : a));
    const integrated = /igpu/i.test(best.type);
    return {
      vendor: guessVendorFromName(best.name),
      integrated,
      vramTotalBytes: datum(best.totalBytes, 'measured', 'ollama:inference-compute', sampledAt, 'bytes'),
      vramUsedBytes: datum(Math.max(best.totalBytes - best.availableBytes, 0), 'measured', 'ollama:inference-compute', sampledAt, 'bytes'),
    };
  }

  /** Último recurso, y solo si el host lo pidió explícitamente (`assumeUnifiedMemoryFallback`, doc 13
   *  §7, hardware real equipo #2): sin `nvidia-smi`, sin log de Ollama todavía cableado y sin dato de
   *  registro de Windows, se asume que una fracción de la RAM total podría ser memoria unificada
   *  utilizable por una iGPU, SIEMPRE marcado `'estimated'`. Apagado por defecto (ver comentario de la
   *  opción): sin ninguna señal real, `gpu: undefined` sigue siendo más honesto que inventar una cifra
   *  en una máquina que a lo mejor ni tiene GPU. */
  private unifiedMemoryFallback(sampledAt: number): HardwareProfile['gpu'] {
    const totalMem = (this.options.totalMemOverride ?? totalmem)();
    const estimatedCeiling = Math.round(totalMem * UNIFIED_MEMORY_CEILING_RATIO);
    return {
      vendor: 'other',
      integrated: true,
      vramTotalBytes: datum(estimatedCeiling, 'estimated', 'heuristic:unified-memory-55pct', sampledAt, 'bytes'),
    };
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
