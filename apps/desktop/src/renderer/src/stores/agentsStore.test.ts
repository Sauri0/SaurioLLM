import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile } from '@saurio/shared';

vi.mock('../ipc/client.js', () => ({ invoke: vi.fn() }));

const { invoke } = await import('../ipc/client.js');
const { useAgentsStore } = await import('./agentsStore.js');
const invokeMock = vi.mocked(invoke);

const agent = (id: string, archivedAt?: number): AgentProfile => ({
  id, ownerKind: 'personal', name: id, role: 'reviewer', modelMode: 'auto', systemPrompt: '', allowedTools: [],
  permissionPreset: 'balanced', memoryScope: 'global', createdAt: 1, ...(archivedAt ? { archivedAt } : {}),
});

function resetStore(): void {
  useAgentsStore.setState({
    personalAgents: [], favoriteAgentIds: [], loading: false, error: undefined, busyId: undefined,
    activeScopeKey: undefined, favoriteIdsReadFailed: false,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

describe('agentsStore', () => {
  beforeEach(() => { resetStore(); invokeMock.mockReset(); });

  it('carga el alcance pedido y conserva favoritos aunque el filtro no los devuelva', async () => {
    invokeMock.mockImplementation(async (channel) => {
      if (channel === 'agents:list') return [agent('visible')];
      if (channel === 'settings:get') return ['visible', 'archived_elsewhere'];
      throw new Error(`IPC inesperado: ${channel}`);
    });
    await useAgentsStore.getState().load({ projectId: 'project_a', includeArchived: true });
    expect(invokeMock).toHaveBeenCalledWith('agents:list', { projectId: 'project_a', includeArchived: true });
    expect(useAgentsStore.getState().favoriteAgentIds).toEqual(['visible', 'archived_elsewhere']);
  });

  it('persiste favoritos y restaura un perfil sin borrar su historial', async () => {
    useAgentsStore.setState({ personalAgents: [agent('archived', 2)], favoriteAgentIds: [] });
    invokeMock.mockResolvedValue(undefined);
    await useAgentsStore.getState().toggleFavorite('archived');
    expect(invokeMock).toHaveBeenCalledWith('settings:set', { key: 'ui.agents.favoriteIds', value: ['archived'] });
    await useAgentsStore.getState().restore('archived');
    expect(invokeMock).toHaveBeenCalledWith('agents:restore', { id: 'archived' });
    expect(useAgentsStore.getState().personalAgents[0]?.archivedAt).toBeUndefined();
  });

  it('descarta la respuesta vieja y oculta el alcance anterior al cambiar rápido de proyecto', async () => {
    const projectA = deferred<AgentProfile[]>();
    const projectB = deferred<AgentProfile[]>();
    invokeMock.mockImplementation(async (channel, input) => {
      if (channel === 'agents:list') {
        return ((input as { projectId?: string }).projectId === 'project_a' ? projectA.promise : projectB.promise) as never;
      }
      if (channel === 'settings:get') return [] as never;
      throw new Error(`IPC inesperado: ${channel}`);
    });
    useAgentsStore.setState({ personalAgents: [agent('visible-a')], activeScopeKey: 'project_a:active-only' });

    const loadingA = useAgentsStore.getState().load({ projectId: 'project_a' });
    const loadingB = useAgentsStore.getState().load({ projectId: 'project_b' });
    expect(useAgentsStore.getState()).toMatchObject({ loading: true, personalAgents: [], activeScopeKey: 'project_b:active-only' });

    projectB.resolve([agent('visible-b')]);
    await loadingB;
    projectA.resolve([agent('stale-a')]);
    await loadingA;
    expect(useAgentsStore.getState().personalAgents.map((item) => item.id)).toEqual(['visible-b']);
    expect(useAgentsStore.getState().activeScopeKey).toBe('project_b:active-only');
  });

  it('conserva favoritos y bloquea su escritura si no pudo leerlos', async () => {
    useAgentsStore.setState({ favoriteAgentIds: ['preservado'] });
    invokeMock.mockImplementation(async (channel) => {
      if (channel === 'agents:list') return [agent('visible')];
      if (channel === 'settings:get') throw new Error('ajustes no disponibles');
      throw new Error(`IPC inesperado: ${channel}`);
    });

    await useAgentsStore.getState().load();
    expect(useAgentsStore.getState()).toMatchObject({
      favoriteAgentIds: ['preservado'], favoriteIdsReadFailed: true,
    });
    expect(useAgentsStore.getState().error).toContain('No se pudieron cargar los favoritos');
    await expect(useAgentsStore.getState().toggleFavorite('visible')).rejects.toThrow('No se pudieron cargar los favoritos');
    expect(invokeMock).not.toHaveBeenCalledWith('settings:set', expect.anything());
  });
});
