import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@saurio/shared';
import { createGlobalRuntime, initGlobalRuntime, type GlobalRuntime } from './createRuntime.js';
import { ensureHostDataDirs, RuntimeHost, type HostAdapter } from './RuntimeHost.js';

function makeHostAdapter(userDataDir: string): HostAdapter {
  return {
    paths: {
      userDataDir,
      dbPath: path.join(userDataDir, 'saurio.db'),
      blobsDir: path.join(userDataDir, 'blobs'),
      toolOutputsDir: path.join(userDataDir, 'tool-outputs'),
      logsDir: path.join(userDataDir, 'logs'),
      cacheDir: path.join(userDataDir, 'cache'),
      repoMapCacheDir: path.join(userDataDir, 'cache', 'repo-map'),
      appPath: process.cwd(),
    },
    async showOpenDirectoryDialog() { return { canceled: true }; },
    notify() { /* sin notificaciones en test */ },
  };
}

describe('RuntimeHost: cancelación al cerrar proyectos', () => {
  let tmp: string;
  let runtime: GlobalRuntime;
  let hostAdapter: HostAdapter;
  let first: Project;
  let second: Project;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'saurio-runtime-host-'));
    hostAdapter = makeHostAdapter(path.join(tmp, 'userData'));
    ensureHostDataDirs(hostAdapter.paths);
    const firstRoot = path.join(tmp, 'first');
    const secondRoot = path.join(tmp, 'second');
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    runtime = createGlobalRuntime(hostAdapter);
    await initGlobalRuntime(runtime, firstRoot);
    const now = Date.now();
    first = await runtime.persistence.repositories.projects.create({
      id: 'first', path: firstRoot, name: 'First', createdAt: now, lastOpenedAt: now,
    });
    second = await runtime.persistence.repositories.projects.create({
      id: 'second', path: secondRoot, name: 'Second', createdAt: now, lastOpenedAt: now,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    runtime.persistence.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function addActiveRun(id: string, parentRunId?: string): Promise<void> {
    const now = Date.now();
    const chat = await runtime.persistence.repositories.chats.create({
      id: `chat-${id}`, projectId: first.id, agentId: 'agent_builtin_lead', mode: 'agent',
      modelRef: { providerId: 'ollama', name: 'fixture', locality: 'local' },
      createdAt: now, updatedAt: now, archived: false,
    });
    await runtime.persistence.repositories.runs.create({
      id: `run-${id}`, chatId: chat.id, agentId: 'agent_builtin_lead', mode: 'agent', state: 'queued',
      ...(parentRunId ? { parentRunId } : {}),
      iteration: 0, lastEventSeq: 0, createdAt: now,
    });
  }

  it('conserva el runtime y no libera observadores si falla al cancelar al cambiar de proyecto', async () => {
    await addActiveRun('open-failure');
    const onProjectChanged = vi.fn();
    const host = new RuntimeHost(hostAdapter, { runtime, onProjectChanged });
    await host.openProject(first);
    const cancel = vi.spyOn(host.runController, 'cancel').mockRejectedValue(new Error('cancelación fallida'));

    await expect(host.openProject(second)).rejects.toThrow(/no se pudieron cancelar/i);

    expect(cancel).toHaveBeenCalledWith('run-open-failure');
    expect(host.activeProjectRoot).toBe(first.path);
    expect(onProjectChanged).toHaveBeenCalledTimes(1);
  });

  it('espera todos los intentos y conserva el runtime si alguno falla al cerrar', async () => {
    await addActiveRun('first');
    await addActiveRun('second');
    const onProjectChanged = vi.fn();
    const host = new RuntimeHost(hostAdapter, { runtime, onProjectChanged });
    await host.openProject(first);
    const firstError = new Error('primero falló');
    const secondError = new Error('segundo falló');
    const cancel = vi.spyOn(host.runController, 'cancel').mockImplementation(async (runId) => {
      if (runId === 'run-first') throw firstError;
      throw secondError;
    });

    let caught: unknown;
    try {
      await host.closeProject();
    } catch (error) {
      caught = error;
    }

    expect(cancel).toHaveBeenCalledTimes(2);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual(expect.arrayContaining([firstError, secondError]));
    expect(host.activeProjectRoot).toBe(first.path);
    expect(onProjectChanged).toHaveBeenCalledTimes(1);
  });

  it('propaga un error al listar runs y conserva el proyecto abierto', async () => {
    const onProjectChanged = vi.fn();
    const host = new RuntimeHost(hostAdapter, { runtime, onProjectChanged });
    await host.openProject(first);
    vi.spyOn(runtime.persistence.repositories.runs, 'listActive').mockRejectedValue(new Error('SQLite no disponible'));

    await expect(host.closeProject()).rejects.toThrow(/SQLite no disponible/);

    expect(host.activeProjectRoot).toBe(first.path);
    expect(onProjectChanged).toHaveBeenCalledTimes(1);
  });

  it('cierra el proyecto luego de cancelar correctamente todos sus runs', async () => {
    await addActiveRun('success');
    const onProjectChanged = vi.fn();
    const host = new RuntimeHost(hostAdapter, { runtime, onProjectChanged });
    await host.openProject(first);
    const cancel = vi.spyOn(host.runController, 'cancel').mockResolvedValue(undefined);

    await expect(host.closeProject()).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledWith('run-success');
    expect(host.activeProject).toBeUndefined();
    expect(onProjectChanged).toHaveBeenCalledTimes(2);
  });

  it('al cerrar la app cancela todos los runs y espera que sus estados terminales estén persistidos', async () => {
    await addActiveRun('parent');
    await addActiveRun('child', 'run-parent');
    const host = new RuntimeHost(hostAdapter, { runtime });
    await host.openProject(first);
    const cancel = vi.spyOn(host.runController, 'cancel').mockImplementation(async (runId) => {
      setTimeout(() => {
        void runtime.persistence.repositories.runs.update(runId, { state: 'cancelled' });
      }, 20);
    });
    const startedAt = Date.now();

    await expect(host.cancelAllActiveRunsAndWait({ timeoutMs: 1_000, pollMs: 5 })).resolves.toBeUndefined();

    expect(cancel.mock.calls.map(([runId]) => runId).sort()).toEqual(['run-child', 'run-parent']);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
    await expect(host.listActiveRuns()).resolves.toEqual([]);
  });

  it('si un run no alcanza estado terminal vence sin cerrar ni inutilizar SQLite', async () => {
    await addActiveRun('stuck');
    const host = new RuntimeHost(hostAdapter, { runtime });
    await host.openProject(first);
    vi.spyOn(host.runController, 'cancel').mockResolvedValue(undefined);

    await expect(host.cancelAllActiveRunsAndWait({ timeoutMs: 20, pollMs: 5 }))
      .rejects.toThrow(/todavía hay tareas activas/i);

    await expect(host.listActiveRuns()).resolves.toHaveLength(1);
    await expect(runtime.persistence.repositories.projects.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id }),
    ]));
  });

  it('el timeout también limita una promesa de cancelación que nunca resuelve', async () => {
    await addActiveRun('hung-cancel');
    const host = new RuntimeHost(hostAdapter, { runtime });
    await host.openProject(first);
    vi.spyOn(host.runController, 'cancel').mockReturnValue(new Promise<void>(() => {}));
    const startedAt = Date.now();

    await expect(host.cancelAllActiveRunsAndWait({ timeoutMs: 30, pollMs: 5 }))
      .rejects.toThrow(/todavía hay tareas activas/i);

    expect(Date.now() - startedAt).toBeLessThan(250);
    await expect(host.listActiveRuns()).resolves.toHaveLength(1);
  });
});
