// Tests de HardwareProbe con CommandRunner mockeado (sin lanzar nvidia-smi/PowerShell reales).
import { describe, it, expect, vi } from 'vitest';
import { HardwareProbe, parseOllamaInferenceComputeLog } from './HardwareProbe.js';
import type { CommandRunner } from './CommandRunner.js';
import type { OllamaInferenceComputeSource } from './HardwareProbe.js';

const NVIDIA_SMI_CSV = 'NVIDIA GeForce RTX 3060 Ti, 8192, 890, 30, 46, 22.10, GPU-abc123\n';

describe('HardwareProbe', () => {
  it('measured: CPU y RAM siempre vienen de os.* con quality measured', async () => {
    const runner: CommandRunner = vi.fn().mockResolvedValue({ stdout: NVIDIA_SMI_CSV, stderr: '' });
    const probe = new HardwareProbe({ runner, now: () => 1000 });
    const profile = await probe.sample();
    expect(profile.cpu.name.quality).toBe('measured');
    expect(profile.cpu.threads.quality).toBe('measured');
    expect(profile.ram.totalBytes.quality).toBe('measured');
    expect(profile.ram.freeBytes.quality).toBe('measured');
  });

  it('parsea nvidia-smi CSV a bytes y marca measured', async () => {
    const runner: CommandRunner = vi.fn().mockResolvedValue({ stdout: NVIDIA_SMI_CSV, stderr: '' });
    const probe = new HardwareProbe({ runner, now: () => 1000 });
    const profile = await probe.sample();
    expect(profile.gpu?.vendor).toBe('nvidia');
    expect(profile.gpu?.vramTotalBytes.value).toBe(8192 * 1024 * 1024);
    expect(profile.gpu?.vramTotalBytes.quality).toBe('measured');
    expect(profile.gpu?.vramUsedBytes?.value).toBe(890 * 1024 * 1024);
    expect(probe.supportsGpuSampling()).toBe(true);
  });

  it('sin nvidia-smi, en Windows cae a qwMemorySize (measured) antes que WMI', async () => {
    const runner: CommandRunner = vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'nvidia-smi') throw new Error('not found');
      if (args.some((a) => a.includes('qwMemorySize'))) return { stdout: '8589934592\n', stderr: '' };
      throw new Error('unexpected command');
    });
    const probe = new HardwareProbe({ runner, now: () => 1000, platformOverride: 'win32' });
    const profile = await probe.sample();
    expect(profile.gpu?.vramTotalBytes.quality).toBe('measured');
    expect(profile.gpu?.vramTotalBytes.source).toBe('registry:qwMemorySize');
    expect(probe.supportsGpuSampling()).toBe(false);
  });

  it('WMI AdapterRAM es el último recurso y nunca se marca measured', async () => {
    const runner: CommandRunner = vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'nvidia-smi') throw new Error('not found');
      if (args.some((a) => a.includes('qwMemorySize'))) throw new Error('registry read failed');
      if (args.some((a) => a.includes('AdapterRAM'))) return { stdout: '4294967295\n', stderr: '' };
      throw new Error('unexpected command');
    });
    const probe = new HardwareProbe({ runner, now: () => 1000, platformOverride: 'win32' });
    const profile = await probe.sample();
    expect(profile.gpu?.vramTotalBytes.quality).toBe('estimated');
    expect(profile.gpu?.vramTotalBytes.source).toBe('wmi:AdapterRAM');
  });

  it('sin GPU detectable en plataforma no-Windows: gpu queda undefined', async () => {
    const runner: CommandRunner = vi.fn().mockRejectedValue(new Error('not found'));
    const probe = new HardwareProbe({ runner, now: () => 1000, platformOverride: 'linux' });
    const profile = await probe.sample();
    expect(profile.gpu).toBeUndefined();
  });

  // Hardware real relevado en equipo #2 (Intel Core Ultra 9 288V + Arc 140V iGPU, sin nvidia-smi):
  // Ollama reporta `type=iGPU`, total 18.0 GiB, available 17.2 GiB — línea real tal como la emite
  // `discover.LogDetails` (repo ollama/ollama, `log/slog` con `HumanBytes2`).
  const REAL_INFERENCE_COMPUTE_LINE =
    'time=2026-09-18T10:00:00.000-03:00 level=INFO source=types.go:36 msg="inference compute" ' +
    'id=0 filter_id= library=vulkan compute="" name="Intel(R) Arc(TM) 140V GPU" description="Intel iGPU" ' +
    'libdirs=ollama driver="" pci_id="" type=iGPU total="18.0 GiB" available="17.2 GiB"';

  it('parseOllamaInferenceComputeLog: parsea la línea real de Ollama (iGPU Intel, formato slog)', () => {
    const devices = parseOllamaInferenceComputeLog(REAL_INFERENCE_COMPUTE_LINE);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: '0', name: 'Intel(R) Arc(TM) 140V GPU', type: 'iGPU',
      totalBytes: Math.round(18.0 * 1024 ** 3), availableBytes: Math.round(17.2 * 1024 ** 3),
    });
  });

  it('parseOllamaInferenceComputeLog: ignora líneas que no son "inference compute" y texto vacío', () => {
    expect(parseOllamaInferenceComputeLog('')).toEqual([]);
    expect(parseOllamaInferenceComputeLog('level=INFO msg="server started"\n')).toEqual([]);
  });

  it('sin nvidia-smi, usa el log de inference compute de Ollama (iGPU Intel) antes que el registro de Windows', async () => {
    const runner: CommandRunner = vi.fn().mockRejectedValue(new Error('not found'));
    const inferenceComputeSource: OllamaInferenceComputeSource = { read: async () => REAL_INFERENCE_COMPUTE_LINE };
    const probe = new HardwareProbe({ runner, now: () => 1000, platformOverride: 'win32', inferenceComputeSource });
    const profile = await probe.sample();
    expect(profile.gpu?.vendor).toBe('intel');
    expect(profile.gpu?.integrated).toBe(true);
    expect(profile.gpu?.vramTotalBytes.quality).toBe('measured');
    expect(profile.gpu?.vramTotalBytes.source).toBe('ollama:inference-compute');
    expect(profile.gpu?.vramTotalBytes.value).toBe(Math.round(18.0 * 1024 ** 3));
    expect(profile.gpu?.vramUsedBytes?.value).toBe(Math.round(0.8 * 1024 ** 3));
  });

  it('sin ninguna fuente y assumeUnifiedMemoryFallback=false (default): gpu sigue undefined incluso en Windows', async () => {
    const runner: CommandRunner = vi.fn().mockRejectedValue(new Error('not found'));
    const probe = new HardwareProbe({ runner, now: () => 1000, platformOverride: 'win32' });
    const profile = await probe.sample();
    expect(profile.gpu).toBeUndefined();
  });

  it('con assumeUnifiedMemoryFallback=true: última instancia, estimated, ~55% de la RAM total', async () => {
    const runner: CommandRunner = vi.fn().mockRejectedValue(new Error('not found'));
    const probe = new HardwareProbe({
      runner, now: () => 1000, platformOverride: 'win32', assumeUnifiedMemoryFallback: true,
      totalMemOverride: () => 32 * 1024 ** 3,
    });
    const profile = await probe.sample();
    expect(profile.gpu?.integrated).toBe(true);
    expect(profile.gpu?.vramTotalBytes.quality).toBe('estimated');
    expect(profile.gpu?.vramTotalBytes.source).toBe('heuristic:unified-memory-55pct');
    expect(profile.gpu?.vramTotalBytes.value).toBe(Math.round(32 * 1024 ** 3 * 0.55));
  });

  it('el fingerprint es estable para el mismo hardware', async () => {
    const runner: CommandRunner = vi.fn().mockResolvedValue({ stdout: NVIDIA_SMI_CSV, stderr: '' });
    const probe = new HardwareProbe({ runner, now: () => 1000 });
    const a = await probe.sample();
    const b = await probe.sample();
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toHaveLength(64); // sha256 hex
  });

  // Bug real v0.2.0 ("cachear la detección de hardware... no reintentar en bucle fuentes que no
  // existen"): en un equipo sin NVIDIA, cada canal IPC que llama sample() (models:catalog,
  // libraryCatalog, resolveByName, tierForSize, recommend) NO debería volver a spawnear nvidia-smi/
  // PowerShell — la detección de GPU se cachea una vez por arranque.
  it('sample() cachea la detección de GPU: llamarlo varias veces no vuelve a invocar el runner', async () => {
    const runner: CommandRunner = vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'nvidia-smi') throw new Error('not found');
      if (args.some((a) => a.includes('qwMemorySize'))) return { stdout: '8589934592\n', stderr: '' };
      throw new Error('unexpected command');
    });
    const probe = new HardwareProbe({ runner, now: () => 1000, platformOverride: 'win32' });

    await probe.sample();
    await probe.sample();
    await probe.sample();

    // nvidia-smi + registro qwMemorySize: 2 invocaciones en la PRIMERA sample() y ninguna más.
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('refreshGpu() fuerza a volver a sondear todas las fuentes de GPU', async () => {
    const runner: CommandRunner = vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'nvidia-smi') throw new Error('not found');
      if (args.some((a) => a.includes('qwMemorySize'))) return { stdout: '8589934592\n', stderr: '' };
      throw new Error('unexpected command');
    });
    const probe = new HardwareProbe({ runner, now: () => 1000, platformOverride: 'win32' });

    await probe.sample();
    probe.refreshGpu();
    await probe.sample();

    expect(runner).toHaveBeenCalledTimes(4);
  });
});
