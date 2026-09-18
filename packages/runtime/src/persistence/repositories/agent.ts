// AgentRepository sobre SQLite (tabla `agents`, doc 03 §4.1) — packages/runtime/src/persistence/repositories/agent.ts.
// Satisface el puerto `AgentConfigResolver` de agent/ports.ts (doc 05 §2.2 paso 5). Se agrega en la
// fase de integración: ni doc 04 ni persistence/types.ts declaran un AgentRepository, pero `runs` y
// `chats` tienen FK contra `agents`, así que el MVP necesita al menos el agente builtin persistido.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { AgentConfig, ContextPolicy } from '../../agent/types.js';
import type { AgentConfigResolver } from '../../agent/ports.js';
import type { PermissionPolicy } from '../../permissions/types.js';
import type { AgentRole, Mode, ModelRef } from '@saurio/shared';

interface AgentRow extends SqliteRow {
  id: string;
  name: string;
  role: string;
  model_ref_json: string;
  system_prompt: string;
  system_prompt_hash: string;
  allowed_tools_json: string;
  permission_policy_json: string;
  context_policy_json: string;
  memory_policy_json: string | null;
  default_mode: string;
  temperature: number | null;
  thinking: string;
  tool_transport: string;
  max_iterations: number;
  working_dir: string | null;
  file_scope: string | null;
  profile_id: string | null;
}

function rowToConfig(row: AgentRow): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    role: row.role as AgentRole,
    model: JSON.parse(row.model_ref_json) as ModelRef,
    systemPrompt: row.system_prompt,
    systemPromptHash: row.system_prompt_hash,
    allowedTools: JSON.parse(row.allowed_tools_json) as string[],
    permissions: JSON.parse(row.permission_policy_json) as PermissionPolicy,
    workingDir: row.working_dir ?? '',
    contextPolicy: JSON.parse(row.context_policy_json) as ContextPolicy,
    memory: row.memory_policy_json
      ? (JSON.parse(row.memory_policy_json) as AgentConfig['memory'])
      : { readProjectMemory: true, writeProjectMemory: false },
    maxIterations: row.max_iterations,
    temperature: row.temperature ?? 0,
    thinking: row.thinking as AgentConfig['thinking'],
    toolTransport: row.tool_transport as AgentConfig['toolTransport'],
    defaultMode: row.default_mode as Mode,
    ...(row.profile_id ? { profileId: row.profile_id } : {}),
    ...(row.file_scope ? { fileScope: row.file_scope } : {}),
  };
}

export interface AgentRepository extends AgentConfigResolver {
  get(id: string): Promise<AgentConfig | undefined>;
  list(): Promise<AgentConfig[]>;
  /** Inserta o actualiza el agente (upsert por id); `is_builtin` marca los que trae la app. */
  save(config: AgentConfig, isBuiltin?: boolean): Promise<AgentConfig>;
}

export function createAgentRepository(driver: SqliteDriver): AgentRepository {
  const getRow = (id: string): AgentRow | undefined =>
    driver.prepare<AgentRow>('SELECT * FROM agents WHERE id = ?').get(id);

  const repo: AgentRepository = {
    async get(id: string): Promise<AgentConfig | undefined> {
      const row = getRow(id);
      return row ? rowToConfig(row) : undefined;
    },

    async list(): Promise<AgentConfig[]> {
      return driver.prepare<AgentRow>('SELECT * FROM agents ORDER BY name').all().map(rowToConfig);
    },

    async save(config: AgentConfig, isBuiltin = false): Promise<AgentConfig> {
      driver.prepare(
        `INSERT INTO agents (id, project_id, name, role, model_ref_json, system_prompt, system_prompt_hash,
                             allowed_tools_json, permission_policy_json, context_policy_json, memory_policy_json,
                             default_mode, temperature, thinking, tool_transport, max_iterations, working_dir,
                             file_scope, profile_id, is_builtin, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, role = excluded.role, model_ref_json = excluded.model_ref_json,
           system_prompt = excluded.system_prompt, system_prompt_hash = excluded.system_prompt_hash,
           allowed_tools_json = excluded.allowed_tools_json,
           permission_policy_json = excluded.permission_policy_json,
           context_policy_json = excluded.context_policy_json,
           memory_policy_json = excluded.memory_policy_json, default_mode = excluded.default_mode,
           temperature = excluded.temperature, thinking = excluded.thinking,
           tool_transport = excluded.tool_transport, max_iterations = excluded.max_iterations,
           working_dir = excluded.working_dir, file_scope = excluded.file_scope,
           profile_id = excluded.profile_id, updated_at = excluded.updated_at`,
      ).run(
        config.id, config.name, config.role, JSON.stringify(config.model), config.systemPrompt,
        config.systemPromptHash, JSON.stringify(config.allowedTools), JSON.stringify(config.permissions),
        JSON.stringify(config.contextPolicy), JSON.stringify(config.memory), config.defaultMode,
        config.temperature, config.thinking, config.toolTransport, config.maxIterations,
        config.workingDir, config.fileScope ?? null, config.profileId ?? null,
        isBuiltin ? 1 : 0, Date.now(),
      );
      return config;
    },

    async resolve(agentId: string): Promise<AgentConfig> {
      const config = await repo.get(agentId);
      if (!config) throw new Error(`saurio: no existe el agente "${agentId}"`);
      return config;
    },
  };

  return repo;
}
