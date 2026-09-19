// ChatRepository (doc 03 §4.1, doc 04 §2 Chat) — packages/runtime/src/persistence/repositories/chat.ts.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { ChatRepository } from '../types.js';
import type { Chat, IpcInput, IpcOutput } from '@saurio/shared';

interface ChatRow extends SqliteRow {
  id: string; project_id: string; agent_id: string; title: string | null; mode: string;
  model_ref_json: string | null; profile_id: string | null; override_json: string | null;
  created_at: number; updated_at: number; archived: number;
  origin_run_id: string | null;
  // Migración 0006 (puntos 1a/1b/12 del encargo).
  permission_preset: string | null; effort: string | null; deleted_at: number | null;
}

interface ChatOverrides {
  modelSelection?: 'auto' | 'explicit';
  [key: string]: unknown;
}

function parseOverrides(raw: string | null): ChatOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const overrides = { ...parsed } as ChatOverrides;
    if (overrides.modelSelection !== 'auto' && overrides.modelSelection !== 'explicit') delete overrides.modelSelection;
    return overrides;
  } catch {
    return {};
  }
}

function serializeOverrides(current: ChatOverrides, modelSelection: Chat['modelSelection']): string | null {
  const next = { ...current };
  if (modelSelection) next.modelSelection = modelSelection;
  else delete next.modelSelection;
  return Object.keys(next).length > 0 ? JSON.stringify(next) : null;
}

function rowToChat(row: ChatRow): Chat {
  const parsedModel = row.model_ref_json ? JSON.parse(row.model_ref_json) as unknown : undefined;
  const overrides = parseOverrides(row.override_json);
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    title: row.title ?? undefined,
    mode: row.mode as Chat['mode'],
    modelRef: parsedModel && typeof parsedModel === 'object' ? parsedModel as Chat['modelRef'] : undefined,
    modelSelection: overrides.modelSelection,
    profileId: row.profile_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    // Doc 19 §2.1 (E3a delegación, migración 0005): chat hijo -> run padre que lo creó.
    originRunId: row.origin_run_id ?? undefined,
    permissionPreset: (row.permission_preset ?? undefined) as Chat['permissionPreset'],
    effort: (row.effort ?? undefined) as Chat['effort'],
  };
}

type SearchInput = IpcInput<'chat:search'>;
type SearchOutput = IpcOutput<'chat:search'>;
export type SearchableChatRepository = ChatRepository & { search(input: SearchInput): Promise<SearchOutput> };

export function createChatRepository(driver: SqliteDriver): SearchableChatRepository {
  return {
    async search(input): Promise<SearchOutput> {
      const query = input.query.trim();
      if (!query || query.length > 200) throw new Error('Ingresá una búsqueda de entre 1 y 200 caracteres.');
      const limit = Math.max(1, Math.min(50, input.limit ?? 20));
      const offset = Math.max(0, input.offset ?? 0);
      const since = input.since ?? 0;
      const until = input.until ?? Number.MAX_SAFE_INTEGER;
      if (until < since) throw new Error('La fecha final debe ser posterior a la inicial.');
      // FTS5 ya se mantiene mediante triggers desde la migración 0001. Se buscan palabras como
      // texto literal/prefijos, nunca se ejecuta sintaxis MATCH proporcionada por la persona.
      const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
      const match = terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' AND ');
      const titlePattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      const contentWhere = `m.chat_id = c.id AND m.role IN ('user', 'assistant')
        AND m.created_at BETWEEN ? AND ? AND messages_fts MATCH ?`;
      const rows = driver.prepare<ChatRow>(`SELECT c.* FROM chats c
        WHERE c.project_id = ? AND c.deleted_at IS NULL AND (? = 1 OR c.archived = 0)
        AND ((c.updated_at BETWEEN ? AND ? AND
          (COALESCE(c.title, 'Chat nuevo') LIKE ? ESCAPE '\\' OR c.mode LIKE ? ESCAPE '\\'
           OR COALESCE(json_extract(c.model_ref_json, '$.name'), '') LIKE ? ESCAPE '\\'))
          ${match ? `OR EXISTS (SELECT 1 FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE ${contentWhere})` : ''})
        ORDER BY c.updated_at DESC, c.id ASC LIMIT ? OFFSET ?`).all(
          input.projectId, input.includeArchived ? 1 : 0, since, until,
          titlePattern, titlePattern, titlePattern,
          ...(match ? [since, until, match] : []), limit + 1, offset,
        );
      const excerpt = match ? driver.prepare<{ id: string; created_at: number; excerpt: string }>(`
        SELECT m.id, m.created_at, snippet(messages_fts, 0, '', '', '…', 32) AS excerpt
        FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
        WHERE m.chat_id = ? AND m.role IN ('user', 'assistant') AND m.created_at BETWEEN ? AND ?
        AND messages_fts MATCH ? ORDER BY m.created_at DESC, m.id ASC LIMIT 1`) : undefined;
      return {
        items: rows.slice(0, limit).map((row) => {
          const message = excerpt?.get(row.id, since, until, match);
          return { chatId: row.id, projectId: row.project_id, title: row.title ?? 'Chat nuevo',
            updatedAt: row.updated_at, archived: row.archived === 1,
            snippet: message?.excerpt.slice(0, 400) ?? row.title ?? 'Chat nuevo',
            messageId: message?.id, matchedAt: message?.created_at };
        }),
        hasMore: rows.length > limit,
      };
    },
    async create(chat: Chat): Promise<Chat> {
      driver.prepare(
        `INSERT INTO chats (id, project_id, agent_id, title, mode, model_ref_json, profile_id, override_json, created_at, updated_at, archived, origin_run_id, permission_preset, effort, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        chat.id, chat.projectId, chat.agentId, chat.title ?? null, chat.mode,
        chat.modelRef ? JSON.stringify(chat.modelRef) : null, chat.profileId ?? null,
        serializeOverrides({}, chat.modelSelection),
        chat.createdAt, chat.updatedAt, chat.archived ? 1 : 0, chat.originRunId ?? null,
        chat.permissionPreset ?? null, chat.effort ?? null,
      );
      return chat;
    },
    async get(id: string): Promise<Chat | undefined> {
      const row = driver.prepare<ChatRow>('SELECT * FROM chats WHERE id = ?').get(id);
      return row ? rowToChat(row) : undefined;
    },
    async listByProject(projectId: string): Promise<Chat[]> {
      return driver.prepare<ChatRow>('SELECT * FROM chats WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
        .all(projectId).map(rowToChat);
    },
    async update(id: string, patch: Partial<Omit<Chat, 'id' | 'projectId'>>): Promise<Chat> {
      const row = driver.prepare<ChatRow>('SELECT * FROM chats WHERE id = ?').get(id);
      if (!row) throw new Error(`chat ${id} no existe`);
      const current = rowToChat(row);
      const merged: Chat = { ...current, ...patch };
      driver.prepare(
        `UPDATE chats SET agent_id = ?, title = ?, mode = ?, model_ref_json = ?, profile_id = ?, override_json = ?, updated_at = ?, archived = ?, permission_preset = ?, effort = ?
         WHERE id = ?`,
      ).run(
        merged.agentId, merged.title ?? null, merged.mode,
        merged.modelRef ? JSON.stringify(merged.modelRef) : null, merged.profileId ?? null,
        serializeOverrides(parseOverrides(row.override_json), merged.modelSelection),
        merged.updatedAt, merged.archived ? 1 : 0, merged.permissionPreset ?? null, merged.effort ?? null, id,
      );
      return merged;
    },
    async softDelete(id: string, deletedAt: number): Promise<void> {
      driver.prepare('UPDATE chats SET deleted_at = ? WHERE id = ?').run(deletedAt, id);
    },
  };
}
