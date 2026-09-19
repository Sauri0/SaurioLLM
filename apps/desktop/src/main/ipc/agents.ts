// Handlers IPC del dominio "agents"/"agent-memory" (doc 19 §1.4, E2a "Mis agentes") —
// apps/desktop/src/main/ipc/agents.ts. Mismo patrón que providers.ts: delega al repositorio real
// (host.agentRepository/host.agentMemoryRepository, packages/runtime/src/persistence/repositories/
// {agent,agentMemory}.ts), sin lógica de negocio propia acá.
import { ipc } from '@saurio/shared';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import { registerHandler } from './registerHandler.js';
import { readSetting, writeSetting } from '../services/settings/settingsAccess.js';

const collaboratorsKey = (chatId: string): string => `chat.collaborators.${chatId}`;

async function assertDirectorChat(host: RuntimeHost, chatId: string, projectId: string): Promise<{ agentId: string }> {
  const chat = await host.chatRepository.get(chatId);
  if (!chat || chat.projectId !== projectId) {
    throw new Error(`El chat ${chatId} no pertenece al proyecto ${projectId}.`);
  }
  const agent = await host.agentRepository.resolve(chat.agentId);
  if (agent.role !== 'lead') throw new Error('Sólo un chat de Director puede configurar colaboradores.');
  return { agentId: chat.agentId };
}

export function registerAgentsHandlers(host: RuntimeHost): void {
  // Doc 19 §1.4: sin filtro explícito, `AgentRepository.listProfiles` ya devuelve solo
  // `ownerKind: 'personal'` no archivados — la vitrina de "Mis agentes" nunca ve
  // `'worker'`/`'coordinator'` (doc 19 §0), y este handler no le da forma de pedirlos.
  registerHandler('agents:list', ipc['agents:list'], async (input) => {
    const profiles = await host.agentRepository.listProfiles({ includeArchived: input.includeArchived });
    // Un perfil personal global sigue disponible en cualquier proyecto; sólo se excluyen perfiles
    // cuyo alcance de memoria declara explícitamente otro proyecto. Los perfiles históricos sin
    // policy se conservan visibles para no inventarles un alcance.
    return input.projectId
      ? profiles.filter((profile) => profile.memoryScope !== 'project' || profile.projectId === input.projectId)
      : profiles;
  });

  registerHandler('agents:create', ipc['agents:create'], async (input) =>
    host.agentRepository.createProfile(input));

  registerHandler('agents:update', ipc['agents:update'], async (input) =>
    host.agentRepository.updateProfile(input.id, input.patch));

  registerHandler('agents:archive', ipc['agents:archive'], async (input) => {
    await host.agentRepository.archive(input.id);
  });

  registerHandler('agents:restore', ipc['agents:restore'], async (input) => {
    await host.agentRepository.restore(input.id);
  });

  registerHandler('agents:duplicate', ipc['agents:duplicate'], async (input) =>
    host.agentRepository.duplicate(input.id, input.name));

  registerHandler('agents:collaborators:get', ipc['agents:collaborators:get'], async (input) => {
    const chat = await assertDirectorChat(host, input.chatId, input.projectId);
    const raw = await readSetting(host, collaboratorsKey(input.chatId), input.projectId);
    const saved = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
    const active = new Set((await host.agentRepository.listProfiles()).map((profile) => profile.id));
    return { agentIds: [...new Set(saved)].filter((id) => id !== chat.agentId && active.has(id)).slice(0, 12) };
  });

  registerHandler('agents:collaborators:set', ipc['agents:collaborators:set'], async (input) => {
    const chat = await assertDirectorChat(host, input.chatId, input.projectId);
    const activeRun = (await host.runsOfChat(input.chatId)).find((run) =>
      !['completed', 'cancelled', 'failed', 'interrupted'].includes(run.state));
    if (activeRun) throw new Error('Podés cambiar el equipo cuando termine la tarea activa.');
    const requested = [...new Set(input.agentIds)];
    const active = new Set((await host.agentRepository.listProfiles()).map((profile) => profile.id));
    const invalid = requested.filter((id) => id === chat.agentId || !active.has(id));
    if (invalid.length > 0) throw new Error(`Agentes inexistentes o archivados: ${invalid.join(', ')}.`);
    await writeSetting(host, collaboratorsKey(input.chatId), requested, input.projectId);
    return { agentIds: requested };
  });

  registerHandler('agent-memory:list', ipc['agent-memory:list'], async (input) =>
    host.agentMemoryRepository.list(input.agentId, input.projectId));

  // `AgentMemorySchema.partial()` (doc 19 §1.4): todos los campos son opcionales en el tipo del
  // contrato para admitir un patch parcial contra un `id` existente, pero un alta real siempre
  // necesita `agentId`/`content` — se valida acá, no en el schema, para no perder la forma "partial"
  // que sí hace falta para actualizar.
  registerHandler('agent-memory:upsert', ipc['agent-memory:upsert'], async (input) => {
    if (!input.agentId) throw new Error('saurio: agent-memory:upsert necesita "agentId"');
    if (!input.id && !input.content) throw new Error('saurio: agent-memory:upsert necesita "content" para crear una memoria nueva');
    const profile = await host.agentRepository.getProfile(input.agentId);
    if (!profile) throw new Error(`saurio: no existe el agente "${input.agentId}"`);
    const existing = input.id ? await host.agentMemoryRepository.get(input.id) : undefined;
    if (input.id && !existing) throw new Error(`saurio: no existe la memoria "${input.id}"`);
    if (existing && existing.agentId !== input.agentId) {
      throw new Error('saurio: una edición de memoria no puede cambiar de agente');
    }
    const requestedProjectId = input.projectId ?? existing?.projectId;
    const projectId = profile.memoryScope === 'project'
      ? profile.projectId
      : requestedProjectId;
    if (profile.memoryScope === 'project' && !projectId) {
      throw new Error('saurio: este agente tiene memoria de proyecto sin proyecto asociado');
    }
    if (profile.memoryScope === 'project' && requestedProjectId && requestedProjectId !== projectId) {
      throw new Error('saurio: la memoria de este agente sólo puede guardarse en su proyecto asociado');
    }
    return host.agentMemoryRepository.upsert({
      id: input.id,
      agentId: input.agentId,
      projectId,
      content: input.content ?? existing?.content ?? '',
      sourceKind: input.sourceKind,
      confidence: input.confidence,
      originRef: input.originRef,
      expiresAt: input.expiresAt,
      invalidatedAt: input.invalidatedAt,
    });
  });

  registerHandler('agent-memory:delete', ipc['agent-memory:delete'], async (input) => {
    await host.agentMemoryRepository.delete(input.id);
  });
}
