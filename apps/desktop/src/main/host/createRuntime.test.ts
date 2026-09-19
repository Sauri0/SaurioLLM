// Test de integración del cableado real del runtime — apps/desktop/src/main/host/createRuntime.test.ts.
// Verifica que `createGlobalRuntime` + `initGlobalRuntime` + `createProjectRuntime` levantan la base
// (migraciones), siembran el agente builtin y arman un RunController funcional contra un workspace
// temporal, sin tocar Ollama (no se dispara ningún run: solo se construyen las piezas).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_ID } from '@saurio/runtime/agent/defaults';
import type { Provider } from '@saurio/runtime/gateway/Provider';
import { LOCAL_ONLY_SETTINGS_KEY, type AgentMemory, type Project } from '@saurio/shared';
import { createAgentMemoryPort, createGlobalRuntime, createProjectRuntime, initGlobalRuntime, type GlobalRuntime } from './createRuntime.js';
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
    vi.restoreAllMocks();
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
    // 11 desde el punto 4 del encargo (feedback real v0.2.1): se sumó `make_dir` a DEFAULT_ALLOWED_TOOLS.
    expect(agent?.allowedTools).toHaveLength(11);
  });

  it('registra el provider de Ollama en 127.0.0.1:11434 con un único slot de scheduler', () => {
    expect(runtime.providers.map((p) => p.id)).toEqual(['ollama']);
    expect(runtime.gateway.status().slots).toHaveLength(1);
  });

  it('recomienda el catálogo curado con estimaciones cuando el inventario de Ollama está offline', async () => {
    const offline = Object.assign(new Error('fetch failed'), {
      name: 'OllamaHttpError', status: 0, code: 'connection_refused',
    });
    const listInstalled = vi.spyOn(runtime.modelManager, 'listInstalled').mockRejectedValue(offline);
    const hardware = {
      cpu: {
        name: { value: 'fixture', quality: 'measured' as const, source: 'os', sampledAt: 0 },
        threads: { value: 8, quality: 'measured' as const, source: 'os', sampledAt: 0 },
      },
      ram: {
        totalBytes: { value: 32 * 1024 ** 3, quality: 'measured' as const, source: 'os', sampledAt: 0 },
        freeBytes: { value: 16 * 1024 ** 3, quality: 'measured' as const, source: 'os', sampledAt: 0 },
      },
      fingerprint: 'offline-fixture', sampledAt: 0,
    };

    const recommendations = await runtime.recommendationEngine.recommend(hardware, 'coding', 'quality');

    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations.every((item) => item.fitQuality === 'estimated' && item.tested === undefined)).toBe(true);
    expect(listInstalled).toHaveBeenCalledTimes(1);
  });

  it('aplica models.localOnly en la frontera del gateway sin llamar al provider configurado', async () => {
    let providerCalls = 0;
    const cloudProvider: Provider = {
      id: 'cloud-fixture', kind: 'cloud', locality: 'cloud',
      async health() { return { ok: true }; },
      async listModels() { return []; },
      async describeModel() { throw new Error('no usado'); },
      async *chat() {
        providerCalls += 1;
        yield { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } };
      },
    };
    runtime.gateway.setProviders([cloudProvider]);
    await runtime.persistence.repositories.settings.set(LOCAL_ONLY_SETTINGS_KEY, true);

    const chunks = [];
    for await (const chunk of runtime.gateway.chat(
      { providerId: cloudProvider.id, name: 'modelo', locality: 'cloud' },
      { model: 'modelo', messages: [], options: { numCtx: 2048, temperature: 0, numPredict: 8 } },
      { runId: 'run-local-only', signal: new AbortController().signal, authorizedLocality: ['cloud'], priority: 'interactive' },
    )) chunks.push(chunk);

    expect(chunks).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('Solo modelos locales') })]);
    expect(providerCalls).toBe(0);
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

  it.each(['reported', 'missing', 'error'] as const)('un run usa la carpeta abierta y contexto con procedencia %s', async (metadata) => {
    await initGlobalRuntime(runtime, hostAdapter.paths.userDataDir);
    const ref = { providerId: 'ollama', name: 'fixture', locality: 'local' as const };
    const describe = vi.spyOn(runtime.modelManager, 'describeModel');
    if (metadata === 'error') describe.mockRejectedValue(new Error('metadatos no disponibles'));
    else describe.mockResolvedValue({
      ref, digest: '', sizeBytes: 0, family: 'fixture', parameterSize: '8B', quantization: '',
      capabilities: { tools: true, thinking: false, vision: false, embedding: false }, contextMax: metadata === 'reported' ? 32768 : undefined, modelInfo: {},
    });
    let systemPrompt = '';
    let numCtx: number | undefined;
    vi.spyOn(runtime.gateway, 'chat').mockImplementation(async function* (_ref, request) {
      systemPrompt = request.messages.find((message) => message.role === 'system')?.content ?? '';
      numCtx = request.options.numCtx;
      yield { type: 'content', text: '1. Leer index.ts\n2. Revisar el resultado' };
      yield { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } };
    });
    const project = await runtime.persistence.repositories.projects.create({ id: 'max-project', name: 'workspace', path: workspace, createdAt: 1, lastOpenedAt: 1 });
    const chat = await runtime.persistence.repositories.chats.create({
      id: 'max-chat', projectId: project.id, agentId: DEFAULT_AGENT_ID, modelRef: ref,
      mode: 'plan', createdAt: 1, updatedAt: 1, archived: false,
    });
    await runtime.persistence.repositories.settings.set('models.numCtxDefaults', { fixture: 4096 });
    const projectRuntime = createProjectRuntime(runtime, hostAdapter, project);
    const { runId } = await projectRuntime.runController.start(chat.id, 'Armá un plan', 'plan');
    await vi.waitFor(async () => expect((await runtime.persistence.repositories.runs.get(runId))?.state).toBe('completed'));
    expect(systemPrompt).toContain(`Carpeta de trabajo: ${workspace}`);
    expect(systemPrompt).not.toContain(hostAdapter.paths.userDataDir);
    const expectedContext = metadata === 'reported' ? 32768 : 8192;
    const expectedSource = metadata === 'reported' ? 'reported' : 'provisional';
    expect(numCtx).toBe(expectedContext);
    expect((await runtime.persistence.repositories.runs.get(runId))?.effectiveConfig).toMatchObject({
      numCtx: expectedContext, contextLimitSource: expectedSource,
    });
    expect(runtime.events.since(runId, 0).find((event) => event.type === 'context.built'))
      .toMatchObject({ budget: { numCtx: expectedContext, effectiveNumCtx: expectedContext, contextLimitSource: expectedSource } });
    expect(await runtime.persistence.repositories.tasks.listByChat(chat.id)).toHaveLength(2);
    expect((await runtime.persistence.repositories.agents.get(DEFAULT_AGENT_ID))?.workingDir).toBe(hostAdapter.paths.userDataDir);
  });

  it('filtra memorias por la política persistida antes de entregarlas al run', async () => {
    const list = vi.fn(async () => [] as AgentMemory[]);
    const projectOnly = createAgentMemoryPort(
      { getProfile: async () => ({ memoryScope: 'project', projectId: 'project_a' }) as never },
      { list },
    );
    await expect(projectOnly.listForRun('agent_1', 'project_b')).resolves.toEqual([]);
    expect(list).not.toHaveBeenCalled();
    await projectOnly.listForRun('agent_1', 'project_a');
    expect(list).toHaveBeenLastCalledWith('agent_1', 'project_a', { includeGlobal: false });

    const globalOrLegacy = createAgentMemoryPort(
      { getProfile: async () => undefined },
      { list },
    );
    await globalOrLegacy.listForRun('agent_1', 'project_b');
    expect(list).toHaveBeenLastCalledWith('agent_1', 'project_b');
  });

  it('releases project-scoped observers only when the active project changes', async () => {
    await initGlobalRuntime(runtime, workspace);
    const onProjectChanged = vi.fn();
    const host = new RuntimeHost(hostAdapter, { runtime, onProjectChanged });
    const now = Date.now();
    const first = await runtime.persistence.repositories.projects.create({ id: 'watch_a', path: workspace, name: 'A', createdAt: now, lastOpenedAt: now });
    const secondPath = path.join(tmp, 'workspace-b');
    mkdirSync(secondPath);
    const second = await runtime.persistence.repositories.projects.create({ id: 'watch_b', path: secondPath, name: 'B', createdAt: now, lastOpenedAt: now });
    await host.openProject(first);
    await host.openProject(first);
    expect(onProjectChanged).toHaveBeenCalledTimes(1);
    await host.openProject(second);
    expect(onProjectChanged).toHaveBeenCalledTimes(2);
    expect(host.activeProjectRoot).toBe(secondPath);
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
