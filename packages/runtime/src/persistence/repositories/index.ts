// Repositorios tipados sobre SqliteDriver (doc 02 §1: packages/runtime/src/persistence/repositories/).
// Solo se implementan acá las tablas que ya tienen datos reales desde el MVP (doc 03 §12) y que
// packages/runtime/src/persistence/types.ts nombra como interfaz: Project, Chat, Message, ToolCall,
// Checkpoint, Task, Settings. ProfileRepository/BenchmarkRepository/DownloadRepository (v0.2/v0.3,
// ya declaradas como interfaz en types.ts) no tienen implementación concreta acá — ver deviations.
import type { SqliteDriver } from '../driver.js';
import { createProjectRepository } from './project.js';
import { createChatRepository } from './chat.js';
import { createMessageRepository } from './message.js';
import { createToolCallRepository } from './toolCall.js';
import { createCheckpointRepository } from './checkpoint.js';
import { createTaskRepository } from './task.js';
import { createSettingsRepository } from './settings.js';
import { createRunRepository } from './run.js';
import { createAgentRepository } from './agent.js';
import { createCheckpointStoreRepository, createBlobRefStore } from './checkpointStore.js';
import { createPermissionRuleRepository, createPermissionDecisionRepository } from './permission.js';

export function createRepositories(driver: SqliteDriver) {
  return {
    projects: createProjectRepository(driver),
    chats: createChatRepository(driver),
    messages: createMessageRepository(driver),
    toolCalls: createToolCallRepository(driver),
    checkpoints: createCheckpointRepository(driver),
    tasks: createTaskRepository(driver),
    settings: createSettingsRepository(driver),
    // Agregados por la fase de integración (no están en persistence/types.ts; ver 16-estado-de-implementacion.md):
    runs: createRunRepository(driver),
    agents: createAgentRepository(driver),
    checkpointStore: createCheckpointStoreRepository(driver),
    blobRefs: createBlobRefStore(driver),
    // Agregados en esta tarea (doc 16 §4, "allow_always no persiste"): implementación SQLite real de
    // las interfaces que permissions/repository.ts declaraba sin backend.
    permissionRules: createPermissionRuleRepository(driver),
    permissionDecisions: createPermissionDecisionRepository(driver),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;

export { createProjectRepository } from './project.js';
export { createChatRepository } from './chat.js';
export { createMessageRepository } from './message.js';
export { createToolCallRepository } from './toolCall.js';
export { createCheckpointRepository } from './checkpoint.js';
export { createTaskRepository } from './task.js';
export { createSettingsRepository } from './settings.js';
export { createRunRepository, type SqliteRunRepository } from './run.js';
export { createAgentRepository, type AgentRepository } from './agent.js';
export { createCheckpointStoreRepository, createBlobRefStore } from './checkpointStore.js';
export { createPermissionRuleRepository, createPermissionDecisionRepository } from './permission.js';
