// Test de los handlers nuevos project:recent/remove/rename (punto 12 del encargo) —
// apps/desktop/src/main/ipc/project.recent.test.ts. Mismo patrón que providers.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
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
    hostAdapter: { showOpenDirectoryDialog: async () => ({ canceled: true }) },
    hasRuntime: () => false,
    projectRepository: {
      list: async () => [...projects.values()],
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
    },
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

  it('project:rename cambia el nombre', async () => {
    const { host } = makeFakeHost(realFolder);
    registerProjectHandlers(host as unknown as RuntimeHost);
    const renamed = await invoke('project:rename', { id: 'p1', name: 'Renombrado' }) as Project;
    expect(renamed.name).toBe('Renombrado');
  });
});
