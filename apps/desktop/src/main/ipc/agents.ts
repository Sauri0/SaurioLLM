// Handlers IPC del dominio "agents"/"agent-memory" (doc 19 §1.4, E2a "Mis agentes") —
// apps/desktop/src/main/ipc/agents.ts. Mismo patrón que providers.ts: delega al repositorio real
// (host.agentRepository/host.agentMemoryRepository, packages/runtime/src/persistence/repositories/
// {agent,agentMemory}.ts), sin lógica de negocio propia acá.
import { ipc } from '@saurio/shared';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import { registerHandler } from './registerHandler.js';

export function registerAgentsHandlers(host: RuntimeHost): void {
  // Doc 19 §1.4: sin filtro explícito, `AgentRepository.listProfiles` ya devuelve solo
  // `ownerKind: 'personal'` no archivados — la vitrina de "Mis agentes" nunca ve
  // `'worker'`/`'coordinator'` (doc 19 §0), y este handler no le da forma de pedirlos.
  registerHandler('agents:list', ipc['agents:list'], async (input) =>
    host.agentRepository.listProfiles({ includeArchived: input.includeArchived }));

  registerHandler('agents:create', ipc['agents:create'], async (input) =>
    host.agentRepository.createProfile(input));

  registerHandler('agents:update', ipc['agents:update'], async (input) =>
    host.agentRepository.updateProfile(input.id, input.patch));

  registerHandler('agents:archive', ipc['agents:archive'], async (input) => {
    await host.agentRepository.archive(input.id);
  });

  registerHandler('agents:duplicate', ipc['agents:duplicate'], async (input) =>
    host.agentRepository.duplicate(input.id, input.name));

  registerHandler('agent-memory:list', ipc['agent-memory:list'], async (input) =>
    host.agentMemoryRepository.list(input.agentId, input.projectId));

  // `AgentMemorySchema.partial()` (doc 19 §1.4): todos los campos son opcionales en el tipo del
  // contrato para admitir un patch parcial contra un `id` existente, pero un alta real siempre
  // necesita `agentId`/`content` — se valida acá, no en el schema, para no perder la forma "partial"
  // que sí hace falta para actualizar.
  registerHandler('agent-memory:upsert', ipc['agent-memory:upsert'], async (input) => {
    if (!input.agentId) throw new Error('saurio: agent-memory:upsert necesita "agentId"');
    if (!input.id && !input.content) throw new Error('saurio: agent-memory:upsert necesita "content" para crear una memoria nueva');
    return host.agentMemoryRepository.upsert({
      id: input.id,
      agentId: input.agentId,
      projectId: input.projectId,
      content: input.content ?? '',
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
