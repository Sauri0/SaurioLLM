// Smoke focal real del contrato TextToolProtocol con qwen2.5-coder:7b.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunEvent } from '@saurio/shared';
import { createDefaultAgentConfig } from '../packages/runtime/src/agent/defaults.js';
import { createGlobalRuntime, createProjectRuntime, initGlobalRuntime } from '../apps/desktop/src/main/host/createRuntime.js';
import { ensureHostDataDirs, type HostAdapter } from '../apps/desktop/src/main/host/RuntimeHost.js';
import { driveThroughPermissionAsks } from './runWatcher.js';

const attempts = 3;
const root = path.join(os.tmpdir(), `saurio-text-tool-${Date.now()}`);
const workspace = path.join(root, 'project');
const data = path.join(root, 'data');
const paths: HostAdapter['paths'] = {
  userDataDir: data,
  dbPath: path.join(data, 'saurio.db'),
  blobsDir: path.join(data, 'blobs'),
  toolOutputsDir: path.join(data, 'tool-outputs'),
  logsDir: path.join(data, 'logs'),
  cacheDir: path.join(data, 'cache'),
  repoMapCacheDir: path.join(data, 'cache', 'repo-map'),
  appPath: path.resolve('apps/desktop'),
};
const host: HostAdapter = {
  paths,
  showOpenDirectoryDialog: async () => ({ canceled: true }),
  notify: () => undefined,
};

function removeIsolatedFixture(): void {
  const resolvedTemp = path.resolve(os.tmpdir());
  const resolvedRoot = path.resolve(root);
  if (
    path.dirname(resolvedRoot) !== resolvedTemp
    || !path.basename(resolvedRoot).startsWith('saurio-text-tool-')
  ) {
    throw new Error(`cleanup rechazado fuera del fixture aislado: ${resolvedRoot}`);
  }
  rmSync(resolvedRoot, { recursive: true, force: true });
}

function waitForTerminal(events: {
  since(runId: string, seq: number): RunEvent[];
  subscribe(listener: (event: RunEvent) => void): () => void;
}, runId: string, timeoutMs: number): Promise<string> {
  const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  const replay = events.since(runId, 0).find((event) => event.type === 'run.state' && terminal.has(event.to));
  if (replay?.type === 'run.state') return Promise.resolve(replay.to);
  return new Promise((resolve, reject) => {
    const unsubscribe = events.subscribe((event) => {
      if (event.runId !== runId || event.type !== 'run.state' || !terminal.has(event.to)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event.to);
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout esperando terminal de ${runId}`));
    }, timeoutMs);
  });
}

mkdirSync(path.join(workspace, 'src'), { recursive: true });
ensureHostDataDirs(paths);
const runtime = createGlobalRuntime(host);
let allPassed = true;
let controller: ReturnType<typeof createProjectRuntime>['runController'] | undefined;
let activeRunId: string | undefined;
try {
  await initGlobalRuntime(runtime, workspace);
  const now = Date.now();
  const project = await runtime.persistence.repositories.projects.create({
    id: 'text_tool_project', name: 'Text tool smoke', path: workspace, createdAt: now, lastOpenedAt: now,
  });
  const model = { providerId: 'ollama', name: 'qwen2.5-coder:7b', locality: 'local' as const };
  const agent = {
    ...createDefaultAgentConfig(workspace, model),
    id: 'agent_text_tool_smoke',
    model,
    toolTransport: 'text' as const,
  };
  await runtime.persistence.repositories.agents.save(agent, false);
  controller = createProjectRuntime(runtime, host, project).runController;

  for (let index = 1; index <= attempts; index += 1) {
    const relPath = `src/coder-${index}.ts`;
    const absolutePath = path.join(workspace, relPath);
    writeFileSync(absolutePath, 'export function doble(n: number): number {\n  return n; // BUG: debería devolver n * 2\n}\n', 'utf8');
    const chat = await runtime.persistence.repositories.chats.create({
      id: `chat_text_${index}`, projectId: project.id, agentId: agent.id, mode: 'agent', modelRef: model,
      createdAt: Date.now(), updatedAt: Date.now(), archived: false,
    });
    const { runId } = await controller.start(
      chat.id, `Arreglá el bug de la función doble en ${relPath}: tiene que devolver n * 2.`, 'agent',
    );
    activeRunId = runId;
    const result = await driveThroughPermissionAsks(
      runtime, controller, runId,
      (toolCallId) => ({ toolCallId, answer: 'allow_once' }),
      { perRoundTimeoutMs: 180_000 },
    );
    if (result.finalState === 'timeout' || result.finalState === 'permission_round_limit') {
      const terminalAfterCancel = waitForTerminal(runtime.events, runId, 15_000);
      await controller.cancel(runId);
      await terminalAfterCancel;
    }
    activeRunId = undefined;
    const calls = await runtime.persistence.repositories.toolCalls.listByRun(runId);
    const content = readFileSync(absolutePath, 'utf8');
    const passed = result.finalState === 'completed'
      && calls.some((call) => call.toolName === 'edit_file' && call.transport === 'text' && call.status === 'done')
      && /return\s+n\s*\*\s*2\s*;/.test(content);
    allPassed &&= passed;
    console.log(JSON.stringify({ attempt: index, passed, finalState: result.finalState,
      calls: calls.map((call) => `${call.toolName}[${call.transport}]:${call.status}`), content: content.trim() }));
  }
} finally {
  if (activeRunId && controller) {
    const terminalAfterCancel = waitForTerminal(runtime.events, activeRunId, 15_000).catch(() => undefined);
    await controller.cancel(activeRunId).catch(() => undefined);
    await terminalAfterCancel;
  }
  runtime.persistence.close();
  if (allPassed) removeIsolatedFixture();
}

if (!allPassed) {
  console.error(`Smoke TextToolProtocol falló; fixture conservado en ${root}`);
  process.exitCode = 1;
}
