import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const fakeFrame = {} as never;
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => handlers.set(channel, fn) } }));

const { allowFrame } = await import('./registerHandler.js');
const { registerAgentsHandlers } = await import('./agents.js');
type RuntimeHost = import('../host/RuntimeHost.js').RuntimeHost;

async function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`canal no registrado: ${channel}`);
  return handler({ senderFrame: fakeFrame }, payload);
}

function fakeHost() {
  const settings = new Map<string, unknown>();
  return {
    chatRepository: { get: vi.fn(async (id: string) => id === 'chat_a' ? { id, projectId: 'project_a', agentId: 'director' } : undefined) },
    agentRepository: {
      listProfiles: vi.fn(async () => [{ id: 'active', ownerKind: 'personal', name: 'Ada', memoryScope: 'global' }]),
      resolve: vi.fn(async () => ({ id: 'director', role: 'lead' })),
      getProfile: vi.fn(async (id: string) => id === 'project-agent'
        ? { id, memoryScope: 'project', projectId: 'project_a' }
        : { id, memoryScope: 'global' }),
      createProfile: vi.fn(), updateProfile: vi.fn(), archive: vi.fn(), restore: vi.fn(), duplicate: vi.fn(),
    },
    agentMemoryRepository: { list: vi.fn(), get: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    runsOfChat: vi.fn(async (): Promise<{ state: string }[]> => []),
    settingsRepository: {
      get: vi.fn(async (key: string, projectId?: string) => settings.get(`${projectId}:${key}`)),
      set: vi.fn(async (key: string, value: unknown, projectId?: string) => { settings.set(`${projectId}:${key}`, value); }),
    },
    settings: { get: vi.fn(), set: vi.fn() },
  };
}

describe('ipc/agents — colaboradores de chat', () => {
  beforeEach(() => { handlers.clear(); allowFrame(fakeFrame); });

  it('persiste sólo perfiles personales activos del proyecto dueño del chat', async () => {
    const host = fakeHost();
    registerAgentsHandlers(host as unknown as RuntimeHost);
    await expect(invoke('agents:collaborators:set', { chatId: 'chat_a', projectId: 'project_a', agentIds: ['active'] }))
      .resolves.toEqual({ agentIds: ['active'] });
    await expect(invoke('agents:collaborators:get', { chatId: 'chat_a', projectId: 'project_a' }))
      .resolves.toEqual({ agentIds: ['active'] });
    await expect(invoke('agents:collaborators:set', { chatId: 'chat_a', projectId: 'project_a', agentIds: ['archived'] }))
      .rejects.toThrow(/inexistentes o archivados/);
    await expect(invoke('agents:collaborators:get', { chatId: 'chat_a', projectId: 'project_b' }))
      .rejects.toThrow(/no pertenece/);
  });

  it('conserva globales y legacy al filtrar por proyecto, y expone restaurar', async () => {
    const host = fakeHost();
    host.agentRepository.listProfiles.mockResolvedValueOnce([
      { id: 'global', ownerKind: 'personal', name: 'Global', memoryScope: 'global' },
      { id: 'project_a', ownerKind: 'personal', name: 'A', memoryScope: 'project', projectId: 'project_a' },
      { id: 'project_b', ownerKind: 'personal', name: 'B', memoryScope: 'project', projectId: 'project_b' },
      { id: 'legacy', ownerKind: 'personal', name: 'Legacy', memoryScope: undefined },
    ] as never);
    registerAgentsHandlers(host as unknown as RuntimeHost);
    await expect(invoke('agents:list', { projectId: 'project_a', includeArchived: true })).resolves.toEqual([
      { id: 'global', ownerKind: 'personal', name: 'Global', memoryScope: 'global' },
      { id: 'project_a', ownerKind: 'personal', name: 'A', memoryScope: 'project', projectId: 'project_a' },
      { id: 'legacy', ownerKind: 'personal', name: 'Legacy', memoryScope: undefined },
    ]);
    await invoke('agents:restore', { id: 'archived' });
    expect(host.agentRepository.restore).toHaveBeenCalledWith('archived');
  });

  it('la escritura de memoria conserva agente y proyecto configurados', async () => {
    const host = fakeHost();
    registerAgentsHandlers(host as unknown as RuntimeHost);

    await invoke('agent-memory:upsert', { agentId: 'project-agent', content: 'dato privado' });
    expect(host.agentMemoryRepository.upsert).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'project-agent', projectId: 'project_a', content: 'dato privado',
    }));

    await expect(invoke('agent-memory:upsert', {
      agentId: 'project-agent', projectId: 'project_b', content: 'otro proyecto',
    })).rejects.toThrow(/proyecto asociado/);

    host.agentMemoryRepository.get.mockResolvedValueOnce({ id: 'mem-ajena', agentId: 'otro-agente', content: 'x' });
    await expect(invoke('agent-memory:upsert', {
      id: 'mem-ajena', agentId: 'project-agent', content: 'x',
    })).rejects.toThrow(/cambiar de agente/);
  });

  it('no cambia el equipo mientras el chat tiene un run activo', async () => {
    const host = fakeHost();
    host.runsOfChat.mockResolvedValueOnce([{ state: 'generating' }]);
    registerAgentsHandlers(host as unknown as RuntimeHost);
    await expect(invoke('agents:collaborators:set', { chatId: 'chat_a', projectId: 'project_a', agentIds: ['active'] }))
      .rejects.toThrow(/termine la tarea activa/);
    expect(host.settingsRepository.set).not.toHaveBeenCalled();
  });
});
