import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@saurio/shared';

vi.mock('../ipc/client.js', () => ({ invoke: vi.fn() }));

const { invoke } = await import('../ipc/client.js');
const { useProjectStore } = await import('./projectStore.js');
const invokeMock = vi.mocked(invoke);

const project = (id: string, lastOpenedAt: number): Project => ({
  id, path: `C:\\proyectos\\${id}`, name: id, createdAt: 1, lastOpenedAt,
});

const resetStore = (): void => useProjectStore.setState({
  projects: [], currentProjectId: undefined, pinnedProjectIds: [], loading: false, error: undefined,
});

function settingKey(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('key' in input)) return undefined;
  const key = (input as { key?: unknown }).key;
  return typeof key === 'string' ? key : undefined;
}

describe('projectStore', () => {
  beforeEach(() => {
    resetStore();
    invokeMock.mockReset();
  });

  it('localizar cancelado conserva selección y no abre otro proyecto', async () => {
    const previous = project('uno', 1);
    useProjectStore.setState({ projects: [previous], currentProjectId: previous.id });
    invokeMock.mockResolvedValue(null);
    await useProjectStore.getState().relocateProject(previous.id);
    expect(useProjectStore.getState().currentProjectId).toBe(previous.id);
    expect(useProjectStore.getState().projects).toEqual([previous]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('una ubicación tardía no reemplaza una selección posterior', async () => {
    const previous = project('uno', 1);
    const moved = { ...previous, path: 'C:\\movido' };
    let resolveRelocation!: (value: Project) => void;
    invokeMock.mockImplementation(async (channel) => channel === 'project:relocate'
      ? new Promise<Project>((resolve) => { resolveRelocation = resolve; }) : undefined);
    useProjectStore.setState({ projects: [previous, project('dos', 2)], currentProjectId: previous.id });
    const pending = useProjectStore.getState().relocateProject(previous.id);
    useProjectStore.getState().setCurrentProject('dos');
    resolveRelocation(moved);
    await pending;
    expect(useProjectStore.getState().currentProjectId).toBe('dos');
    expect(useProjectStore.getState().projects.find((item) => item.id === 'uno')?.path).toBe(moved.path);
    expect(invokeMock).not.toHaveBeenCalledWith('project:open', expect.anything());
  });

  it('si falla reabrir conserva la ruta reasociada sin simular un runtime activo', async () => {
    const previous = project('uno', 1);
    const moved = { ...previous, path: 'C:\\movido' };
    useProjectStore.setState({ projects: [previous], currentProjectId: previous.id });
    invokeMock.mockImplementation(async (channel) => {
      if (channel === 'project:relocate') return moved;
      throw new Error('No se pudo abrir');
    });
    await expect(useProjectStore.getState().relocateProject(previous.id)).rejects.toThrow(/abrir/);
    expect(useProjectStore.getState().currentProjectId).toBeUndefined();
    expect(useProjectStore.getState().projects).toEqual([moved]);
  });

  it('cargar recientes no simula un proyecto abierto en RuntimeHost', async () => {
    invokeMock.mockImplementation(async (channel, input) => {
      if (channel === 'project:list') return [project('primero', 2), project('segundo', 1)];
      if (channel === 'settings:get' && settingKey(input) === 'ui.projects.pinnedIds') return [];
      throw new Error(`IPC inesperado: ${channel}`);
    });

    await useProjectStore.getState().loadProjects();
    expect(useProjectStore.getState().currentProjectId).toBeUndefined();
    expect(useProjectStore.getState().projects.map((item) => item.id)).toEqual(['primero', 'segundo']);
  });

  it('sin último proyecto guardado no abre el primero de la lista', async () => {
    invokeMock.mockImplementation(async (channel, input) => {
      if (channel === 'project:list') return [project('reciente', 2)];
      if (channel === 'settings:get') return settingKey(input) === 'ui.projects.pinnedIds' ? [] : undefined;
      throw new Error(`IPC inesperado: ${channel}`);
    });

    await expect(useProjectStore.getState().restoreLastProject()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalledWith('project:open', expect.anything());
    expect(useProjectStore.getState().currentProjectId).toBeUndefined();
  });

  it('si el último proyecto fue quitado de recientes no abre otro arbitrariamente', async () => {
    invokeMock.mockImplementation(async (channel, input) => {
      if (channel === 'project:list') return [project('otro-reciente', 2)];
      if (channel === 'settings:get') {
        return settingKey(input) === 'ui.projects.pinnedIds' ? [] : 'proyecto-quitado';
      }
      throw new Error(`IPC inesperado: ${channel}`);
    });

    await expect(useProjectStore.getState().restoreLastProject()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalledWith('project:open', expect.anything());
    expect(useProjectStore.getState().currentProjectId).toBeUndefined();
  });

  it('restaura únicamente el último proyecto registrado mediante project:open', async () => {
    const saved = project('ultimo', 3);
    invokeMock.mockImplementation(async (channel, input) => {
      if (channel === 'project:list') return [saved, project('otro', 2)];
      if (channel === 'settings:get') return settingKey(input) === 'ui.projects.pinnedIds' ? [] : 'ultimo';
      if (channel === 'project:open') return saved;
      if (channel === 'settings:set') return undefined;
      throw new Error(`IPC inesperado: ${channel}`);
    });

    await expect(useProjectStore.getState().restoreLastProject()).resolves.toEqual(saved);
    expect(invokeMock).toHaveBeenCalledWith('project:open', { path: saved.path });
    expect(useProjectStore.getState().currentProjectId).toBe('ultimo');
  });

  it('restaura Personal por su IPC dedicado sin mezclar su raíz sintética con proyectos normales', async () => {
    const personal = project('project_personal', 4);
    invokeMock.mockImplementation(async (channel, input) => {
      if (channel === 'project:list') return [project('normal', 2)];
      if (channel === 'settings:get') return settingKey(input) === 'ui.projects.pinnedIds'
        ? ['project_personal', 'normal']
        : 'project_personal';
      if (channel === 'project:personal') return personal;
      if (channel === 'settings:set') return undefined;
      throw new Error(`IPC inesperado: ${channel}`);
    });

    await expect(useProjectStore.getState().restoreLastProject()).resolves.toEqual(personal);
    expect(invokeMock).toHaveBeenCalledWith('project:personal', undefined);
    expect(useProjectStore.getState().currentProjectId).toBe('project_personal');
    expect(useProjectStore.getState().pinnedProjectIds).toEqual(['normal']);
  });

  it('protege Personal de pin, rename y remove antes de invocar IPC', async () => {
    await expect(useProjectStore.getState().toggleProjectPinned('project_personal')).rejects.toThrow(/no se puede pinear/);
    await expect(useProjectStore.getState().renameProject('project_personal', 'Otro')).rejects.toThrow(/no se puede renombrar/);
    await expect(useProjectStore.getState().removeProject('project_personal')).rejects.toThrow(/no se puede quitar/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('descarta la fila Personal de la proyección al abrir un proyecto normal', async () => {
    const personal = project('project_personal', 4);
    const normal = project('normal', 5);
    useProjectStore.setState({ projects: [personal], currentProjectId: personal.id });
    invokeMock.mockImplementation(async (channel) => {
      if (channel === 'project:open') return normal;
      if (channel === 'settings:set') return undefined;
      throw new Error(`IPC inesperado: ${channel}`);
    });

    await useProjectStore.getState().openProject(normal.path);
    expect(useProjectStore.getState().projects).toEqual([normal]);
    expect(useProjectStore.getState().currentProjectId).toBe('normal');
  });
});
