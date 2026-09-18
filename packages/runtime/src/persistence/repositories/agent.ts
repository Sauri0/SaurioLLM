// AgentRepository sobre SQLite (tabla `agents`, doc 03 §4.1) — packages/runtime/src/persistence/repositories/agent.ts.
// Satisface el puerto `AgentConfigResolver` de agent/ports.ts (doc 05 §2.2 paso 5). Se agrega en la
// fase de integración: ni doc 04 ni persistence/types.ts declaran un AgentRepository, pero `runs` y
// `chats` tienen FK contra `agents`, así que el MVP necesita al menos el agente builtin persistido.
//
// Doc 19 §1.5 (E2a "Mis agentes", migración 0004): agrega la vitrina de "identidad" sobre las mismas
// filas (`owner_kind`/`avatar_emoji`/`avatar_color`/`description`/`model_mode`/`created_at`/
// `archived_at`) sin tocar `rowToConfig`/`save` (siguen siendo la vista `AgentConfig` que usa
// `RunController`, sin cambios de comportamiento para el agente builtin). `listProfiles` filtra
// SIEMPRE por `owner_kind` explícito — nunca expone `'worker'`/`'coordinator'` salvo que se pidan a
// propósito (doc 19 §0), y ese pedido explícito lo hace únicamente el runtime de delegación (E3a),
// nunca la UI de "Mis agentes".
import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { AgentConfig, ContextPolicy } from '../../agent/types.js';
import type { AgentConfigResolver } from '../../agent/ports.js';
import { createPersonalAgentDefaults } from '../../agent/defaults.js';
import type { PermissionPolicy } from '../../permissions/types.js';
import type {
  AgentRole, Mode, ModelRef, AgentProfile, AgentCreateInput, AgentOwnerKind, ModelMode,
} from '@saurio/shared';

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
  updated_at: number;
  // Doc 19 §1.1 (migración 0004):
  owner_kind: string;
  avatar_emoji: string | null;
  avatar_color: string | null;
  description: string | null;
  model_mode: string;
  created_at: number | null;
  archived_at: number | null;
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
    ...(row.model_mode ? { modelMode: row.model_mode as ModelMode } : {}),
  };
}

function rowToProfile(row: AgentRow): AgentProfile {
  const permissions = JSON.parse(row.permission_policy_json) as PermissionPolicy;
  return {
    id: row.id,
    ownerKind: row.owner_kind as AgentOwnerKind,
    name: row.name,
    role: row.role as AgentRole,
    description: row.description ?? undefined,
    avatarEmoji: row.avatar_emoji ?? undefined,
    avatarColor: row.avatar_color ?? undefined,
    modelMode: row.model_mode as ModelMode,
    model: JSON.parse(row.model_ref_json) as ModelRef,
    systemPrompt: row.system_prompt,
    allowedTools: JSON.parse(row.allowed_tools_json) as string[],
    permissionPreset: permissions.preset,
    createdAt: row.created_at ?? row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

export interface AgentProfileFilter {
  /** Default `['personal']` (doc 19 §1.4: "agents:list sin filtro devuelve solo ownerKind:
   *  'personal' no archivados" — la UI de "Mis agentes" nunca ve 'worker'/'coordinator'). */
  ownerKind?: AgentOwnerKind[];
  includeArchived?: boolean;
}

export interface AgentRepository extends AgentConfigResolver {
  get(id: string): Promise<AgentConfig | undefined>;
  list(): Promise<AgentConfig[]>;
  /** Inserta o actualiza el agente (upsert por id); `is_builtin` marca los que trae la app. */
  save(config: AgentConfig, isBuiltin?: boolean): Promise<AgentConfig>;

  // ── Doc 19 §1.5 (E2a "Mis agentes") ─────────────────────────────────────
  getProfile(id: string): Promise<AgentProfile | undefined>;
  listProfiles(filter?: AgentProfileFilter): Promise<AgentProfile[]>;
  /** `ownerKind` default `'personal'`; E3a (delegación) es el único llamador que pasa `'worker'`. */
  createProfile(input: AgentCreateInput, ownerKind?: AgentOwnerKind): Promise<AgentProfile>;
  updateProfile(id: string, patch: Partial<AgentCreateInput>): Promise<AgentProfile>;
  /** Doc 19 §1.5: nunca borra la fila (la FK de `chats.agent_id`/`runs.agent_id` lo impediría de
   *  todas formas) — marca `archived_at` y `listProfiles` sin `includeArchived: true` la excluye. */
  archive(id: string): Promise<void>;
  duplicate(id: string, name?: string): Promise<AgentProfile>;
}

const DEFAULT_PROFILE_FILTER: Required<AgentProfileFilter> = { ownerKind: ['personal'], includeArchived: false };

export function createAgentRepository(driver: SqliteDriver): AgentRepository {
  const getRow = (id: string): AgentRow | undefined =>
    driver.prepare<AgentRow>('SELECT * FROM agents WHERE id = ?').get(id);

  function insertRow(row: {
    id: string; name: string; role: string; model: ModelRef; systemPrompt: string; systemPromptHash: string;
    allowedTools: string[]; permissions: PermissionPolicy; contextPolicy: ContextPolicy;
    defaultMode: string; temperature: number; thinking: string; toolTransport: string; maxIterations: number;
    ownerKind: AgentOwnerKind; avatarEmoji?: string; avatarColor?: string; description?: string;
    modelMode: ModelMode; createdAt: number;
  }): void {
    driver.prepare(
      `INSERT INTO agents (id, project_id, name, role, model_ref_json, system_prompt, system_prompt_hash,
                           allowed_tools_json, permission_policy_json, context_policy_json, memory_policy_json,
                           default_mode, temperature, thinking, tool_transport, max_iterations, working_dir,
                           file_scope, profile_id, is_builtin, updated_at,
                           owner_kind, avatar_emoji, avatar_color, description, model_mode, created_at, archived_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      row.id, row.name, row.role, JSON.stringify(row.model), row.systemPrompt, row.systemPromptHash,
      JSON.stringify(row.allowedTools), JSON.stringify(row.permissions), JSON.stringify(row.contextPolicy),
      row.defaultMode, row.temperature, row.thinking, row.toolTransport, row.maxIterations, row.createdAt,
      row.ownerKind, row.avatarEmoji ?? null, row.avatarColor ?? null, row.description ?? null,
      row.modelMode, row.createdAt,
    );
  }

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

    async getProfile(id: string): Promise<AgentProfile | undefined> {
      const row = getRow(id);
      return row ? rowToProfile(row) : undefined;
    },

    async listProfiles(filter: AgentProfileFilter = {}): Promise<AgentProfile[]> {
      const ownerKind = filter.ownerKind ?? DEFAULT_PROFILE_FILTER.ownerKind;
      const includeArchived = filter.includeArchived ?? DEFAULT_PROFILE_FILTER.includeArchived;
      const placeholders = ownerKind.map(() => '?').join(', ');
      const archivedClause = includeArchived ? '' : ' AND archived_at IS NULL';
      const rows = driver.prepare<AgentRow>(
        `SELECT * FROM agents WHERE owner_kind IN (${placeholders})${archivedClause} ORDER BY created_at DESC, name ASC`,
      ).all(...ownerKind);
      return rows.map(rowToProfile);
    },

    async createProfile(input: AgentCreateInput, ownerKind: AgentOwnerKind = 'personal'): Promise<AgentProfile> {
      const config = createPersonalAgentDefaults(input);
      const now = Date.now();
      insertRow({
        id: config.id, name: config.name, role: config.role, model: config.model,
        systemPrompt: config.systemPrompt, systemPromptHash: config.systemPromptHash,
        allowedTools: config.allowedTools, permissions: config.permissions, contextPolicy: config.contextPolicy,
        defaultMode: config.defaultMode, temperature: config.temperature, thinking: config.thinking,
        toolTransport: config.toolTransport, maxIterations: config.maxIterations,
        ownerKind, avatarEmoji: input.avatarEmoji, avatarColor: input.avatarColor, description: input.description,
        modelMode: input.modelMode ?? 'fixed', createdAt: now,
      });
      const profile = await repo.getProfile(config.id);
      if (!profile) throw new Error(`saurio: no se pudo crear el agente "${config.id}"`);
      return profile;
    },

    async updateProfile(id: string, patch: Partial<AgentCreateInput>): Promise<AgentProfile> {
      const row = getRow(id);
      if (!row) throw new Error(`saurio: no existe el agente "${id}"`);
      const currentPermissions = JSON.parse(row.permission_policy_json) as PermissionPolicy;
      const nextPermissions: PermissionPolicy = patch.permissionPreset
        ? { ...currentPermissions, preset: patch.permissionPreset }
        : currentPermissions;
      const nextModel = patch.model ?? (JSON.parse(row.model_ref_json) as ModelRef);
      const nextTools = patch.allowedTools ?? (JSON.parse(row.allowed_tools_json) as string[]);
      const nextSystemPrompt = patch.systemPrompt ?? row.system_prompt;
      const nextName = patch.name ?? row.name;
      const nextRole = patch.role ?? row.role;
      const nextDescription = patch.description !== undefined ? patch.description : (row.description ?? undefined);
      const nextAvatarEmoji = patch.avatarEmoji !== undefined ? patch.avatarEmoji : (row.avatar_emoji ?? undefined);
      const nextAvatarColor = patch.avatarColor !== undefined ? patch.avatarColor : (row.avatar_color ?? undefined);
      const nextModelMode = patch.modelMode ?? (row.model_mode as ModelMode);

      driver.prepare(
        `UPDATE agents SET name = ?, role = ?, model_ref_json = ?, system_prompt = ?, system_prompt_hash = ?,
                           allowed_tools_json = ?, permission_policy_json = ?, avatar_emoji = ?, avatar_color = ?,
                           description = ?, model_mode = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        nextName, nextRole, JSON.stringify(nextModel), nextSystemPrompt,
        createHash('sha256').update(nextSystemPrompt, 'utf8').digest('hex'),
        JSON.stringify(nextTools), JSON.stringify(nextPermissions),
        nextAvatarEmoji ?? null, nextAvatarColor ?? null, nextDescription ?? null, nextModelMode,
        Date.now(), id,
      );
      const updated = await repo.getProfile(id);
      if (!updated) throw new Error(`saurio: el agente "${id}" desapareció durante la actualización`);
      return updated;
    },

    async archive(id: string): Promise<void> {
      driver.prepare('UPDATE agents SET archived_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id);
    },

    async duplicate(id: string, name?: string): Promise<AgentProfile> {
      const row = getRow(id);
      if (!row) throw new Error(`saurio: no existe el agente "${id}" para duplicar`);
      const now = Date.now();
      const newId = `agent_personal_${randomUUID()}`;
      insertRow({
        id: newId, name: name ?? `${row.name} (copia)`, role: row.role,
        model: JSON.parse(row.model_ref_json) as ModelRef, systemPrompt: row.system_prompt,
        systemPromptHash: row.system_prompt_hash, allowedTools: JSON.parse(row.allowed_tools_json) as string[],
        permissions: JSON.parse(row.permission_policy_json) as PermissionPolicy,
        contextPolicy: JSON.parse(row.context_policy_json) as ContextPolicy,
        defaultMode: row.default_mode, temperature: row.temperature ?? 0, thinking: row.thinking,
        toolTransport: row.tool_transport, maxIterations: row.max_iterations,
        ownerKind: row.owner_kind as AgentOwnerKind, avatarEmoji: row.avatar_emoji ?? undefined,
        avatarColor: row.avatar_color ?? undefined, description: row.description ?? undefined,
        modelMode: row.model_mode as ModelMode, createdAt: now,
      });
      const profile = await repo.getProfile(newId);
      if (!profile) throw new Error(`saurio: no se pudo duplicar el agente "${id}"`);
      return profile;
    },
  };

  return repo;
}
