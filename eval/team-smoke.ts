// Opt-in real local Director -> selected collaborator through the desktop runtime wiring.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createGlobalRuntime, initGlobalRuntime, createProjectRuntime } from '../apps/desktop/src/main/host/createRuntime.js';
import { ensureHostDataDirs, type HostAdapter } from '../apps/desktop/src/main/host/RuntimeHost.js';
import { driveThroughPermissionAsks } from './runWatcher.js';

const root = path.resolve(`smoke/team-023-${Date.now()}`);
const workspace = path.join(root, 'Proyecto del equipo');
const data = path.join(root, 'datos');
mkdirSync(workspace, { recursive: true });
writeFileSync(path.join(workspace, 'fixture.txt'), 'Resultado esperado del fixture: SAURIO-023-OK\n');
const host: HostAdapter = { paths: { userDataDir: data, dbPath: path.join(data, 'saurio.db'),
  blobsDir: path.join(data, 'blobs'), toolOutputsDir: path.join(data, 'tool-outputs'), logsDir: path.join(data, 'logs'),
  cacheDir: path.join(data, 'cache'), repoMapCacheDir: path.join(data, 'cache', 'repo-map'), appPath: path.resolve('apps/desktop') },
  showOpenDirectoryDialog: async () => ({ canceled: true }), notify: () => undefined };
ensureHostDataDirs(host.paths);
const runtime = createGlobalRuntime(host);
const now = Date.now();
const automatic = process.argv.includes('--auto');
try {
  await initGlobalRuntime(runtime, workspace);
  const model = { providerId: 'ollama', name: process.env['SAURIO_EVAL_MODEL'] ?? 'qwen3:8b', locality: 'local' as const };
  const agents = runtime.persistence.repositories.agents;
  const profileModel = automatic ? { modelMode: 'auto' as const } : { modelMode: 'fixed' as const, model };
  const director = await agents.createProfile({ name: 'Director de prueba', role: 'lead', ...profileModel,
    allowedTools: ['delegate', 'finish'], permissionPreset: 'balanced',
    systemPrompt: 'Coordinás el trabajo. Debés delegar al colaborador habilitado y entregar su resultado. No inventes contenido de archivos.' });
  const tester = await agents.createProfile({ name: 'Tester habilitado', role: 'custom', ...profileModel,
    allowedTools: ['read_file', 'finish'], permissionPreset: 'balanced',
    systemPrompt: 'Leé el archivo pedido con read_file y devolvé su contenido exacto mediante finish. No inventes rutas ni resultados.' });
  await agents.createProfile({ name: 'Agente no habilitado', role: 'reviewer', modelMode: 'fixed', model, allowedTools: ['finish'], permissionPreset: 'balanced' });
  const project = await runtime.persistence.repositories.projects.create({ id: 'team_project', name: 'Equipo', path: workspace, createdAt: now, lastOpenedAt: now });
  const chat = await runtime.persistence.repositories.chats.create({ id: 'team_chat', projectId: project.id, agentId: director.id,
    mode: 'agent', ...(automatic ? { modelSelection: 'auto' as const } : { modelRef: model }), createdAt: now, updatedAt: now, archived: false });
  await runtime.persistence.repositories.settings.set(`chat.collaborators.${chat.id}`, [tester.id], project.id);
  const controller = createProjectRuntime(runtime, host, project).runController;
  const { runId } = await controller.start(chat.id, 'Delegá al Tester habilitado la lectura de fixture.txt usando delegate. Cuando responda, entregá el contenido que encontró. No leas el archivo por tu cuenta.', 'agent');
  const result = await driveThroughPermissionAsks(runtime, controller, runId, (toolCallId) => ({ toolCallId, answer: 'allow_once' }), { perRoundTimeoutMs: 240_000 });
  const events = runtime.events.since(runId, 0);
  const delegated = events.filter((event) => event.type === 'run.delegated');
  const messages = await runtime.persistence.repositories.messages.listByChat(chat.id);
  const finalText = messages.filter((message) => message.role === 'assistant').map((message) => message.content).join('\n');
  if (result.finalState !== 'completed' || delegated.length !== 1 || delegated[0]?.targetAgentId !== tester.id || !finalText.includes('SAURIO-023-OK')) {
    throw new Error(JSON.stringify({ result, delegated, finalText, root }));
  }
  const effectiveModels = messages.filter(message => message.role === 'assistant').map(message => message.modelRef).filter(Boolean);
  if (automatic && (effectiveModels.length === 0 || effectiveModels.some(ref => ref?.locality !== 'local'))) throw new Error('Auto did not record a local effective model');
  console.log(JSON.stringify({ ok: true, automatic, effectiveModels, result, delegated, finalText, elapsedMs: Date.now() - now, root }));
} finally { runtime.persistence.close(); }
