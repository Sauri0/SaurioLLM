// AgentMemoryRepository sobre SQLite (tabla `agent_memories`, doc 19 §1.1) —
// packages/runtime/src/persistence/repositories/agentMemory.ts.
// Doc 19 §1.5/§1.7 (E2a "Mis agentes", T09): `list()` es EL ÚNICO lugar que aplica el filtro de
// privacidad por proyecto — `WHERE agent_id = ? AND (project_id = ? OR project_id IS NULL)`. Un
// agente personal usado en el proyecto B nunca recibe filas con `project_id` distinto de B (solo las
// globales). El ensamblador de contexto (packages/runtime/src/context/*) debe llamar a este método,
// nunca leer `agent_memories` por su cuenta, para que el filtro no se pueda evadir accidentalmente.
import { randomUUID } from 'node:crypto';
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { AgentMemory, MemoryConfidence, MemorySourceKind } from '@saurio/shared';

interface AgentMemoryRow extends SqliteRow {
  id: string;
  agent_id: string;
  project_id: string | null;
  content: string;
  source_kind: string;
  confidence: string;
  origin_ref: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  invalidated_at: number | null;
}

function rowToMemory(row: AgentMemoryRow): AgentMemory {
  return {
    id: row.id,
    agentId: row.agent_id,
    projectId: row.project_id ?? undefined,
    content: row.content,
    sourceKind: row.source_kind as MemorySourceKind,
    confidence: row.confidence as MemoryConfidence,
    originRef: row.origin_ref ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? undefined,
    invalidatedAt: row.invalidated_at ?? undefined,
  };
}

/** Entrada de `upsert`: `id` ausente crea una fila nueva; presente actualiza (ON CONFLICT). */
export interface AgentMemoryUpsertInput {
  id?: string;
  agentId: string;
  projectId?: string;
  content: string;
  sourceKind?: MemorySourceKind;
  confidence?: MemoryConfidence;
  originRef?: string;
  expiresAt?: number;
  invalidatedAt?: number;
}

export interface AgentMemoryRepository {
  /** Doc 19 §1.7 (T09): sin `projectId`, devuelve solo las memorias GLOBALES del agente
   *  (`project_id IS NULL`) — nunca "todas, de cualquier proyecto". Excluye filas invalidadas. */
  list(agentId: string, projectId?: string): Promise<AgentMemory[]>;
  upsert(input: AgentMemoryUpsertInput): Promise<AgentMemory>;
  delete(id: string): Promise<void>;
}

export function createAgentMemoryRepository(driver: SqliteDriver): AgentMemoryRepository {
  return {
    async list(agentId: string, projectId?: string): Promise<AgentMemory[]> {
      if (projectId) {
        return driver.prepare<AgentMemoryRow>(
          `SELECT * FROM agent_memories
           WHERE agent_id = ? AND (project_id = ? OR project_id IS NULL) AND invalidated_at IS NULL
           ORDER BY updated_at DESC`,
        ).all(agentId, projectId).map(rowToMemory);
      }
      return driver.prepare<AgentMemoryRow>(
        `SELECT * FROM agent_memories WHERE agent_id = ? AND project_id IS NULL AND invalidated_at IS NULL
         ORDER BY updated_at DESC`,
      ).all(agentId).map(rowToMemory);
    },

    async upsert(input: AgentMemoryUpsertInput): Promise<AgentMemory> {
      const now = Date.now();
      const existing = input.id
        ? driver.prepare<AgentMemoryRow>('SELECT * FROM agent_memories WHERE id = ?').get(input.id)
        : undefined;
      const merged: AgentMemory = {
        id: input.id ?? `mem_${randomUUID()}`,
        agentId: input.agentId,
        projectId: input.projectId ?? (existing?.project_id ?? undefined),
        content: input.content,
        sourceKind: input.sourceKind ?? (existing?.source_kind as MemorySourceKind | undefined) ?? 'user_stated',
        confidence: input.confidence ?? (existing?.confidence as MemoryConfidence | undefined) ?? 'hypothesis',
        originRef: input.originRef ?? (existing?.origin_ref ?? undefined),
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
        expiresAt: input.expiresAt ?? (existing?.expires_at ?? undefined),
        invalidatedAt: input.invalidatedAt ?? (existing?.invalidated_at ?? undefined),
      };
      driver.prepare(
        `INSERT INTO agent_memories
           (id, agent_id, project_id, content, source_kind, confidence, origin_ref, created_at, updated_at, expires_at, invalidated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id, content = excluded.content, source_kind = excluded.source_kind,
           confidence = excluded.confidence, origin_ref = excluded.origin_ref, updated_at = excluded.updated_at,
           expires_at = excluded.expires_at, invalidated_at = excluded.invalidated_at`,
      ).run(
        merged.id, merged.agentId, merged.projectId ?? null, merged.content, merged.sourceKind, merged.confidence,
        merged.originRef ?? null, merged.createdAt, merged.updatedAt, merged.expiresAt ?? null,
        merged.invalidatedAt ?? null,
      );
      return merged;
    },

    async delete(id: string): Promise<void> {
      driver.prepare('DELETE FROM agent_memories WHERE id = ?').run(id);
    },
  };
}
