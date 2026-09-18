// Tests de HardwareProbe con CommandRunner mockeado (sin lanzar nvidia-smi/PowerShell reales).
import { describe, it, expect, vi } from 'vitest';
import { HardwareProbe } from './HardwareProbe.js';
import type { CommandRunner } from './CommandRunner.js';

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

  it('el fingerprint es estable para el mismo hardware', async () => {
    const runner: CommandRunner = vi.fn().mockResolvedValue({ stdout: NVIDIA_SMI_CSV, stderr: '' });
    const probe = new HardwareProbe({ runner, now: () => 1000 });
    const a = await probe.sample();
    const b = await probe.sample();
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toHaveLength(64); // sha256 hex
  });
});
