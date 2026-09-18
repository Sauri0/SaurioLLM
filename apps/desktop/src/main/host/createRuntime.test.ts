// Test de integración del cableado real del runtime — apps/desktop/src/main/host/createRuntime.test.ts.
// Verifica que `createGlobalRuntime` + `initGlobalRuntime` + `createProjectRuntime` levantan la base
// (migraciones), siembran el agente builtin y arman un RunController funcional contra un workspace
// temporal, sin tocar Ollama (no se dispara ningún run: solo se construyen las piezas).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_ID } from '@saurio/runtime/agent/defaults';
import type { Project } from '@saurio/shared';
import { createGlobalRuntime, createProjectRuntime, initGlobalRuntime, type GlobalRuntime } from './createRuntime.js';
import { ensureHostDataDirs, type HostAdapter } from './RuntimeHost.js';

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
      // `process.cwd()` bajo vitest es `apps/desktop/` (mismo nivel relativo que `app.getAppPath()`
      // en dev real, doc 13 §3): permite que `readResourceFile('model-catalog.json', ...)` encuentre
      // el catálogo real del repo sin mockear nada.
      appPath: process.cwd(),
    },
    async showOpenDirectoryDialog() { return { canceled: true }; },
    notify() { /* sin notificaciones en test */ },
  };
}

describe('createRuntime (integración)', () => {
  let tmp: string;
  let workspace: string;
  let runtime: GlobalRuntime;
  let hostAdapter: HostAdapter;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'saurio-integration-'));
    workspace = path.join(tmp, 'workspace');
    hostAdapter = makeHostAdapter(path.join(tmp, 'userData'));
    ensureHostDataDirs(hostAdapter.paths);
    // workspace mínimo con un archivo real, para que el repo map tenga algo que indexar
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, 'index.ts'), 'export function hola(): string { return "hola"; }\n');
    runtime = createGlobalRuntime(hostAdapter);
  });

  afterEach(() => {
    runtime.persistence.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('aplica migraciones, siembra el agente builtin y recover() no encuentra nada en una base nueva', async () => {
    const recovered = await initGlobalRuntime(runtime, workspace);
    expect(recovered.orphaned).toEqual([]);
    expect(recovered.abandoned).toEqual([]);

    const agent = await runtime.persistence.repositories.agents.get(DEFAULT_AGENT_ID);
    expect(agent?.contextPolicy.numCtx).toBe(8192);
    expect(agent?.thinking).toBe('off');
    expect(agent?.allowedTools).toHaveLength(10);
  });

  it('registra el provider de Ollama en 127.0.0.1:11434 con un único slot de scheduler', () => {
    expect(runtime.providers.map((p) => p.id)).toEqual(['ollama']);
    expect(runtime.gateway.status().slots).toHaveLength(1);
  });

  it('crea el ProjectRuntime del proyecto abierto y persiste chat + run contra saurio.db', async () => {
    await initGlobalRuntime(runtime, workspace);
    const project: Project = {
      id: 'project_test', path: workspace, name: 'workspace', createdAt: Date.now(), lastOpenedAt: Date.now(),
    };
    await runtime.persistence.repositories.projects.create(project);

    const projectRuntime = createProjectRuntime(runtime, hostAdapter, project);
    expect(projectRuntime.projectRoot).toBe(workspace);

    const now = Date.now();
    const chat = await runtime.persistence.repositories.chats.create({
      id: 'chat_test', projectId: project.id, agentId: DEFAULT_AGENT_ID, mode: 'agent',
      modelRef: { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' },
      createdAt: now, updatedAt: now, archived: false,
    });

    // Se escribe una fila de `runs` a mano (sin arrancar el loop, que hablaría con Ollama) para
    // comprobar que el RunRepository nuevo de la integración lee/escribe la tabla real.
    await runtime.persistence.repositories.runs.create({
      id: 'run_test', chatId: chat.id, agentId: DEFAULT_AGENT_ID, mode: 'agent', state: 'queued',
      iteration: 0, lastEventSeq: 0, createdAt: now,
    });
    const active = await runtime.persistence.repositories.runs.listActive();
    expect(active.map((r) => r.id)).toEqual(['run_test']);

    await runtime.persistence.repositories.runs.update('run_test', { state: 'completed' });
    expect(await runtime.persistence.repositories.runs.listActive()).toEqual([]);
    expect((await runtime.persistence.repositories.runs.listByChat(chat.id)).map((r) => r.state)).toEqual(['completed']);
  });

  it('el BroadcastEventStore publica los RunEvent ya persistidos', async () => {
    await initGlobalRuntime(runtime, workspace);
    const now = Date.now();
    await runtime.persistence.repositories.projects.create({ id: 'p', path: workspace, name: 'workspace', createdAt: now, lastOpenedAt: now });
    await runtime.persistence.repositories.chats.create({
      id: 'c', projectId: 'p', agentId: DEFAULT_AGENT_ID, mode: 'agent', createdAt: now, updatedAt: now, archived: false,
    });
    await runtime.persistence.repositories.runs.create({
      id: 'r', chatId: 'c', agentId: DEFAULT_AGENT_ID, mode: 'agent', state: 'queued',
      iteration: 0, lastEventSeq: 0, createdAt: now,
    });

    const seen: string[] = [];
    const off = runtime.events.subscribe((event) => seen.push(event.type));
    runtime.events.append({ runId: 'r', chatId: 'c', ts: now, type: 'run.state', from: 'queued', to: 'generating' });
    off();

    expect(seen).toEqual(['run.state']);
    expect(runtime.events.lastSeq('r')).toBeGreaterThan(0);
  });
});
