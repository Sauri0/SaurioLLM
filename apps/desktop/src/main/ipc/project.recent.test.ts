// Test de los handlers nuevos project:recent/remove/rename (punto 12 del encargo) —
// apps/desktop/src/main/ipc/project.recent.test.ts. Mismo patrón que providers.test.ts.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@saurio/shared';

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const fakeFrame = {} as never;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

const { allowFrame } = await import('./registerHandler.js');
const { registerProjectHandlers } = await import('./project.js');
type RuntimeHost = import('../host/RuntimeHost.js').RuntimeHost;

function makeFakeHost(realFolder: string) {
  const projects = new Map<string, Project & { removedFromRecents: boolean }>();
  projects.set('p1', { id: 'p1', path: realFolder, name: 'P1', createdAt: 1, lastOpenedAt: 2, removedFromRecents: false });
  projects.set('p2', { id: 'p2', path: '/no/existe/esta/carpeta', name: 'P2', createdAt: 1, lastOpenedAt: 1, removedFromRecents: false });

  const host = {
    hostAdapter: { paths: { userDataDir: realFolder }, showOpenDirectoryDialog: async () => ({ canceled: true }) },
    hasRuntime: () => false,
    projectRepository: {
      get: async (id: string) => projects.get(id),
      list: async () => [...projects.values()],
      create: async (project: Project) => {
        projects.set(project.id, { ...project, removedFromRecents: false });
        return project;
      },
      touchLastOpened: async (id: string, lastOpenedAt: number) => {
        const project = projects.get(id);
        if (project) projects.set(id, { ...project, lastOpenedAt });
      },
      listRecent: async () => [...projects.values()]
        .filter((p) => !p.removedFromRecents)
        .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
        .map((p) => ({ project: p, chatCount: 0 })),
      setRemovedFromRecents: async (id: string, removed: boolean) => {
        const p = projects.get(id);
        if (p) p.removedFromRecents = removed;
      },
      rename: async (id: string, name: string) => {
        const p = projects.get(id);
        if (!p) throw new Error('no existe');
        const updated = { ...p, name };
        projects.set(id, updated);
        return updated;
      },
      relocate: async (id: string, newPath: string) => {
        const previous = projects.get(id)!;
        const updated = { ...previous, path: newPath };
        projects.set(id, updated);
        return updated;
      },
    },
    openProject: vi.fn(async () => undefined),
    closeProject: vi.fn(async () => undefined),
    activeProject: undefined as { projectId: string } | undefined,
  };
  return { host, projects };
}

async function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handle = handlers.get(channel);
  if (!handle) throw new Error(`canal no registrado: ${channel}`);
  return handle({ senderFrame: fakeFrame }, payload);
}

describe('ipc/project — recientes/remove/rename', () => {
  let realFolder: string;

  beforeEach(() => {
    handlers.clear();
    allowFrame(fakeFrame);
    realFolder = mkdtempSync(path.join(tmpdir(), 'saurio-project-recent-'));
  });

  afterEach(() => rmSync(realFolder, { recursive: true, force: true }));

  it('project:recent devuelve folderExists=true/false según corresponda', async () => {
    const { host } = makeFakeHost(realFolder);
    registerProjectHandlers(host as unknown as RuntimeHost);
    const recent = await invoke('project:recent', undefined) as Array<{ id: string; folderExists: boolean }>;
    expect(recent.find((p) => p.id === 'p1')?.folderExists).toBe(true);
    expect(recent.find((p) => p.id === 'p2')?.folderExists).toBe(false);
  });

  it('project:remove saca el proyecto de project:recent sin borrar la fila', async () => {
    const { host, projects } = makeFakeHost(realFolder);
    registerProjectHandlers(host as unknown as RuntimeHost);
    await invoke('project:remove', { id: 'p1' });
    const recent = await invoke('project:recent', undefined) as Array<{ id: string }>;
    expect(recent.map((p) => p.id)).not.toContain('p1');
    expect(projects.has('p1')).toBe(true);
  });

  it('project:list tampoco vuelve a mostrar un proyecto quitado de SaurioLLM', async () => {
    const { host } = makeFakeHost(realFolder);
    registerProjectHandlers(host as unknown as RuntimeHost);
    await invoke('project:remove', { id: 'p1' });
    const listed = await invoke('project:list', undefined) as Project[];
    expect(listed.map((p) => p.id)).toEqual(['p2']);
  });

  it('project:createManaged crea una carpeta aislada en los datos de la app', async () => {
    const { host } = makeFakeHost(realFolder);
    registerProjectHandlers(host as unknown as RuntimeHost);
    const managed = await invoke('project:createManaged', { name: 'Notas de equipo' }) as Project;
    expect(managed.name).toBe('Notas de equipo');
    expect(managed.path).toMatch(/managed-projects/);
    expect(managed.path).not.toBe(realFolder);
    expect(await import('node:fs').then(({ existsSync }) => existsSync(managed.path))).toBe(true);
  });

  it('normaliza una carpeta existente antes de persistirla o abrir el runtime', async () => {
    const { host } = makeFakeHost(realFolder);
    const nested = path.join(realFolder, 'carpeta real');
    mkdirSync(nested);
    registerProjectHandlers(host as unknown as RuntimeHost);
    const opened = await invoke('project:open', { path: nested }) as Project;
    expect(opened.path).toBe(realpathSync.native(nested));
  });

  it('rechaza una ruta relativa, inexistente o que apunta a un archivo sin tocar recientes', async () => {
    const { host, projects } = makeFakeHost(realFolder);
    const missing = path.join(realFolder, 'carpeta borrada');
    const file = path.join(realFolder, 'archivo.txt');
    writeFileSync(file, 'no es directorio');
    registerProjectHandlers(host as unknown as RuntimeHost);

    await expect(invoke('project:open', { path: 'relativa' })).rejects.toThrow(/ruta absoluta/);
    await expect(invoke('project:open', { path: missing })).rejects.toThrow(/no existe o ya no es accesible/);
    await expect(invoke('project:open', { path: file })).rejects.toThrow(/no existe o ya no es accesible/);
    expect(projects.size).toBe(2);
    expect((await invoke('project:recent', undefined) as Array<{ id: string }>).map((project) => project.id)).toContain('p2');
  });

  it('project:rename cambia el nombre', async () => {
    const { host } = makeFakeHost(realFolder);
    registerProjectHandlers(host as unknown as RuntimeHost);
    const renamed = await invoke('project:rename', { id: 'p1', name: 'Renombrado' }) as Project;
    expect(renamed.name).toBe('Renombrado');
  });

  it('localiza una carpeta conservando ID/nombre y cierra primero su raíz activa', async () => {
    const { host, projects } = makeFakeHost(realFolder);
    const destination = path.join(realFolder, 'movido');
    mkdirSync(destination);
    host.activeProject = { projectId: 'p2' };
    host.closeProject.mockImplementation(async () => {
      expect(projects.get('p2')?.path).toBe('/no/existe/esta/carpeta');
    });
    registerProjectHandlers(host as unknown as RuntimeHost);
    const updated = await invoke('project:relocate', { id: 'p2', path: destination });
    expect(updated).toMatchObject({ id: 'p2', name: 'P2', createdAt: 1, path: realpathSync.native(destination) });
    expect(host.closeProject).toHaveBeenCalledOnce();
    expect(projects.size).toBe(2);
  });

  it('cancelar localizar no cambia datos; rechaza colisiones y Personal', async () => {
    const { host, projects } = makeFakeHost(realFolder);
    const occupied = path.join(realFolder, 'ocupada');
    mkdirSync(occupied);
    projects.set('p1', { ...projects.get('p1')!, path: occupied });
    registerProjectHandlers(host as unknown as RuntimeHost);
    expect(await invoke('project:relocate', { id: 'p2' })).toBeNull();
    await expect(invoke('project:relocate', { id: 'p2', path: occupied })).rejects.toThrow(/ya pertenece/);
    await expect(invoke('project:relocate', { id: 'project_personal', path: realFolder })).rejects.toThrow(/Personal/);
    expect(projects.get('p2')?.path).toBe('/no/existe/esta/carpeta');
    expect(host.closeProject).not.toHaveBeenCalled();
  });

  it('una cancelación fallida del runtime impide cambiar la carpeta', async () => {
    const { host, projects } = makeFakeHost(realFolder);
    const destination = path.join(realFolder, 'destino');
    mkdirSync(destination);
    host.activeProject = { projectId: 'p2' };
    host.closeProject.mockRejectedValue(new Error('No se pudo detener'));
    registerProjectHandlers(host as unknown as RuntimeHost);
    await expect(invoke('project:relocate', { id: 'p2', path: destination })).rejects.toThrow(/detener/);
    expect(projects.get('p2')?.path).toBe('/no/existe/esta/carpeta');
  });

  it('abre Personal sobre una raíz física privada y conserva su ID persistido', async () => {
    const { host, projects } = makeFakeHost(realFolder);
    projects.set('project_personal', {
      id: 'project_personal', path: '\0saurio-personal', name: 'Personal', createdAt: 1,
      lastOpenedAt: 1, removedFromRecents: false,
    });
    host.hasRuntime = () => true;
    registerProjectHandlers(host as unknown as RuntimeHost);

    const opened = await invoke('project:personal', undefined) as Project;

    expect(opened.id).toBe('project_personal');
    expect(opened.path).toBe(realpathSync.native(path.join(realFolder, 'personal-project')));
    expect(host.openProject).toHaveBeenCalledWith(opened);
  });

  it('rechaza junctions o symlinks como raíz Personal', async () => {
    const { host, projects } = makeFakeHost(realFolder);
    const target = path.join(realFolder, 'otro-proyecto');
    mkdirSync(target);
    const personalPath = path.join(realFolder, 'personal-project');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(target, personalPath, process.platform === 'win32' ? 'junction' : 'dir');
    projects.set('project_personal', {
      id: 'project_personal', path: '\0saurio-personal', name: 'Personal', createdAt: 1,
      lastOpenedAt: 1, removedFromRecents: false,
    });
    host.hasRuntime = () => true;
    registerProjectHandlers(host as unknown as RuntimeHost);

    await expect(invoke('project:personal', undefined)).rejects.toThrow(/enlace o junction/);
    expect(host.openProject).not.toHaveBeenCalled();
  });

  it('reserva la raíz Personal frente a aperturas normales y colisiones persistidas', async () => {
    const { host, projects } = makeFakeHost(realFolder);
    const personalPath = path.join(realFolder, 'personal-project');
    mkdirSync(personalPath);
    const personalChild = path.join(personalPath, 'subcarpeta');
    mkdirSync(personalChild);
    registerProjectHandlers(host as unknown as RuntimeHost);
    await expect(invoke('project:open', { path: personalPath })).rejects.toThrow(/reservada para el espacio Personal/);
    await expect(invoke('project:open', { path: personalChild })).rejects.toThrow(/reservada para el espacio Personal/);
    await expect(invoke('project:open', { path: realFolder })).rejects.toThrow(/reservada para el espacio Personal/);

    projects.set('project_personal', {
      id: 'project_personal', path: '\0saurio-personal', name: 'Personal', createdAt: 1,
      lastOpenedAt: 1, removedFromRecents: false,
    });
    projects.set('normal-same-root', {
      id: 'normal-same-root', path: personalPath, name: 'Duplicado', createdAt: 1,
      lastOpenedAt: 1, removedFromRecents: false,
    });
    host.hasRuntime = () => true;
    await expect(invoke('project:personal', undefined)).rejects.toThrow(/ya pertenece al proyecto/);
    expect(host.openProject).not.toHaveBeenCalled();
  });

  it('protege el ID Personal y cierra un proyecto normal activo antes de quitarlo', async () => {
    const { host } = makeFakeHost(realFolder);
    registerProjectHandlers(host as unknown as RuntimeHost);
    await expect(invoke('project:remove', { id: 'project_personal' })).rejects.toThrow(/no se puede quitar/);
    await expect(invoke('project:rename', { id: 'project_personal', name: 'Otro' })).rejects.toThrow(/no se puede renombrar/);

    host.activeProject = { projectId: 'p1' };
    await invoke('project:remove', { id: 'p1' });
    expect(host.closeProject).toHaveBeenCalledOnce();
  });
});
