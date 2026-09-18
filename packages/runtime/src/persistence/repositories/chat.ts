// ChatRepository (doc 03 §4.1, doc 04 §2 Chat) — packages/runtime/src/persistence/repositories/chat.ts.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { ChatRepository } from '../types.js';
import type { Chat } from '@saurio/shared';

interface ChatRow extends SqliteRow {
  id: string; project_id: string; agent_id: string; title: string | null; mode: string;
  model_ref_json: string | null; profile_id: string | null; override_json: string | null;
  created_at: number; updated_at: number; archived: number;
  origin_run_id: string | null;
}

function rowToChat(row: ChatRow): Chat {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    title: row.title ?? undefined,
    mode: row.mode as Chat['mode'],
    modelRef: row.model_ref_json ? JSON.parse(row.model_ref_json) : undefined,
    profileId: row.profile_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    // Doc 19 §2.1 (E3a delegación, migración 0005): chat hijo -> run padre que lo creó.
    originRunId: row.origin_run_id ?? undefined,
  };
}

export function createChatRepository(driver: SqliteDriver): ChatRepository {
  return {
    async create(chat: Chat): Promise<Chat> {
      driver.prepare(
        `INSERT INTO chats (id, project_id, agent_id, title, mode, model_ref_json, profile_id, override_json, created_at, updated_at, archived, origin_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      ).run(
        chat.id, chat.projectId, chat.agentId, chat.title ?? null, chat.mode,
        chat.modelRef ? JSON.stringify(chat.modelRef) : null, chat.profileId ?? null,
        chat.createdAt, chat.updatedAt, chat.archived ? 1 : 0, chat.originRunId ?? null,
      );
      return chat;
    },
    async get(id: string): Promise<Chat | undefined> {
      const row = driver.prepare<ChatRow>('SELECT * FROM chats WHERE id = ?').get(id);
      return row ? rowToChat(row) : undefined;
    },
    async listByProject(projectId: string): Promise<Chat[]> {
      return driver.prepare<ChatRow>('SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC')
        .all(projectId).map(rowToChat);
    },
    async update(id: string, patch: Partial<Omit<Chat, 'id' | 'projectId'>>): Promise<Chat> {
      const current = await this.get(id);
      if (!current) throw new Error(`chat ${id} no existe`);
      const merged: Chat = { ...current, ...patch };
      driver.prepare(
        `UPDATE chats SET agent_id = ?, title = ?, mode = ?, model_ref_json = ?, profile_id = ?, updated_at = ?, archived = ?
         WHERE id = ?`,
      ).run(
        merged.agentId, merged.title ?? null, merged.mode,
        merged.modelRef ? JSON.stringify(merged.modelRef) : null, merged.profileId ?? null,
        merged.updatedAt, merged.archived ? 1 : 0, id,
      );
      return merged;
    },
  };
}
