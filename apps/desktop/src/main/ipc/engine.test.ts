import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
const frame = {} as never;
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (event: unknown, input: unknown) => unknown) => handlers.set(channel, fn) } }));
const { allowFrame } = await import('./registerHandler.js');
const { registerEngineHandlers } = await import('./engine.js');
type Arguments = Parameters<typeof registerEngineHandlers>;
function fixture() {
  const values = new Map<string, unknown>();
  const installer = { status: () => ({ phase: 'installed', completedBytes: 0 }), executablePath: vi.fn((): string | undefined => 'C:\\managed\\ollama.exe'),
    modelsDir: 'C:\\managed\\models', start: vi.fn(), cancel: vi.fn() };
  const manager = { configure: vi.fn(async () => undefined), configuration: () => ({ baseUrl: 'http://127.0.0.1:11434', attachOnly: false }),
    checkHealth: vi.fn(async () => true), ensureRunning: vi.fn(async (): Promise<{ running: boolean; startedByApp: boolean; error?: string }> => ({ running: true, startedByApp: true })) };
  const settings = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value) };
  const runtime = { persistence: { repositories: { runs: { listActive: vi.fn(async (): Promise<unknown[]> => []) } } },
    downloadManager: { listAll: vi.fn((): { status: string }[] => []) }, providersRepository: { update: vi.fn(), get: () => ({ baseUrl: 'http://127.0.0.1:11434', label: 'Ollama', enabled: true }) },
    modelManager: { setManagedModelsFolder: vi.fn() }, refreshProviders: vi.fn() };
  registerEngineHandlers(installer as unknown as Arguments[0], manager as unknown as Arguments[1], settings as unknown as Arguments[2], runtime as unknown as Arguments[3]);
  return { installer, manager, settings, runtime };
}
const invoke = (channel: string, input?: unknown) => handlers.get(channel)!({ senderFrame: frame }, input);
beforeEach(() => { handlers.clear(); allowFrame(frame); });
describe('engine IPC', () => {
  it('switches the provider, models folder and process environment together', async () => {
    const { installer, manager, settings, runtime } = fixture();
    await invoke('engine:select', { mode: 'managed' });
    expect(manager.configure).toHaveBeenCalledWith('http://127.0.0.1:11435', expect.any(Function), expect.objectContaining({ OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_MODELS: installer.modelsDir }), false);
    expect(settings.get('engine.mode')).toBe('managed');
    expect(runtime.providersRepository.update).toHaveBeenCalledWith('ollama', expect.objectContaining({ baseUrl: 'http://127.0.0.1:11435' }));
    expect(runtime.modelManager.setManagedModelsFolder).toHaveBeenCalledWith(installer.modelsDir);
    expect(runtime.refreshProviders).toHaveBeenCalledOnce();
  });
  it.each(['queued', 'running', 'paused'])('blocks changing engines during a %s download', async (status) => {
    const { manager, runtime } = fixture();
    runtime.downloadManager.listAll.mockReturnValue([{ status }]);
    await expect(invoke('engine:select', { mode: 'managed' })).rejects.toThrow(/tareas y descargas/);
    expect(manager.configure).not.toHaveBeenCalled();
  });
  it('blocks active runs and missing managed engines before mutations', async () => {
    const { installer, manager, runtime } = fixture();
    runtime.persistence.repositories.runs.listActive.mockResolvedValueOnce([{}]);
    await expect(invoke('engine:select', { mode: 'managed' })).rejects.toThrow(/tareas y descargas/);
    installer.executablePath.mockReturnValue(undefined);
    await expect(invoke('engine:select', { mode: 'managed' })).rejects.toThrow(/Primero/);
    expect(manager.configure).not.toHaveBeenCalled();
  });
  it('does not persist a mode when stopping the old engine fails', async () => {
    const { manager, settings, runtime } = fixture();
    manager.configure.mockRejectedValueOnce(new Error('still closing'));
    await expect(invoke('engine:select', { mode: 'managed' })).rejects.toThrow('still closing');
    expect(settings.get('engine.mode')).toBeUndefined();
    expect(runtime.providersRepository.update).not.toHaveBeenCalled();
  });
  it('restores the previous engine when the new one fails to start', async () => {
    const { manager, settings, runtime } = fixture();
    manager.ensureRunning.mockResolvedValueOnce({ running: false, startedByApp: true, error: 'timeout_starting' });
    await expect(invoke('engine:select', { mode: 'managed' })).rejects.toThrow('timeout_starting');
    expect(settings.get('engine.mode')).toBeUndefined();
    expect(manager.configure).toHaveBeenLastCalledWith('http://127.0.0.1:11434', undefined, undefined, false);
    expect(manager.ensureRunning).toHaveBeenCalledTimes(2);
    expect(runtime.providersRepository.update).toHaveBeenLastCalledWith('ollama', expect.objectContaining({ baseUrl: 'http://127.0.0.1:11434' }));
    expect(runtime.modelManager.setManagedModelsFolder).toHaveBeenLastCalledWith(undefined);
  });
});
