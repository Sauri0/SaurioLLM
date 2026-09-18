// PermissionRuleRepository / PermissionDecisionRepository sobre SQLite — packages/runtime/src/
// persistence/repositories/permission.ts.
// Define: doc 06-permisos-y-modos.md §7 ("recordar decisión") y §11 (auditoría), sobre las tablas
// `permission_rules`/`permission_decisions` de doc 03-modelo-de-datos.md §4.4 (DDL en
// persistence/migrations/0001_init.ts, ya creadas desde la migración 1; hasta esta tarea no tenían
// implementación concreta — solo las interfaces locales de permissions/repository.ts). Doc 16 §4
// ítem "allow_always no persiste": esta es la pieza que faltaba para que `PermissionMemory`
// (permissions/memory.ts) pueda escribir/leer de verdad en vez de quedarse solo con la interfaz.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type {
  PermissionRuleRepository, PermissionRuleRow, PermissionDecisionRepository, PermissionDecisionRow,
} from '../../permissions/repository.js';
import type { PermissionRule } from '../../permissions/types.js';

interface PermissionRuleDbRow extends SqliteRow {
  id: string; scope: string; project_id: string | null; tool_name: string; pattern: string | null;
  decision: string; source: string; created_at: number; source_tool_call_id: string | null;
}

interface PermissionDecisionDbRow extends SqliteRow {
  id: string; tool_call_id: string; decision: string; rule_id: string | null;
  decided_by: string; reason: string | null; decided_at: number;
}

function rowToRuleRow(row: PermissionRuleDbRow): PermissionRuleRow {
  return {
    id: row.id,
    scope: row.scope as PermissionRule['scope'],
    toolName: row.tool_name,
    decision: row.decision as PermissionRule['decision'],
    source: row.source as PermissionRule['source'],
    pattern: row.pattern ?? undefined,
    projectId: row.project_id ?? undefined,
    createdAt: row.created_at,
    sourceToolCallId: row.source_tool_call_id ?? undefined,
  };
}

function rowToDecisionRow(row: PermissionDecisionDbRow): PermissionDecisionRow {
  return {
    id: row.id,
    toolCallId: row.tool_call_id,
    decision: row.decision as PermissionDecisionRow['decision'],
    ruleId: row.rule_id ?? undefined,
    decidedBy: row.decided_by as PermissionDecisionRow['decidedBy'],
    reason: row.reason ?? undefined,
    decidedAt: row.decided_at,
  };
}

export function createPermissionRuleRepository(driver: SqliteDriver): PermissionRuleRepository {
  return {
    async create(row: PermissionRuleRow): Promise<PermissionRuleRow> {
      driver.prepare(
        `INSERT INTO permission_rules (id, scope, project_id, tool_name, pattern, decision, source, created_at, source_tool_call_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id, row.scope, row.projectId ?? null, row.toolName, row.pattern ?? null,
        row.decision, row.source, row.createdAt, row.sourceToolCallId ?? null,
      );
      return row;
    },
    async delete(id: string): Promise<void> {
      driver.prepare('DELETE FROM permission_rules WHERE id = ?').run(id);
    },
    async listByScope(scope: PermissionRule['scope'], projectId?: string): Promise<PermissionRuleRow[]> {
      if (scope === 'project') {
        return driver.prepare<PermissionRuleDbRow>(
          'SELECT * FROM permission_rules WHERE scope = ? AND project_id = ? ORDER BY created_at ASC',
        ).all(scope, projectId ?? null).map(rowToRuleRow);
      }
      return driver.prepare<PermissionRuleDbRow>(
        'SELECT * FROM permission_rules WHERE scope = ? ORDER BY created_at ASC',
      ).all(scope).map(rowToRuleRow);
    },
    /** Reglas aplicables a un proyecto (doc §7): `global` (project_id NULL) + `project` (project_id
     *  = projectId). `session` queda fuera a propósito (doc 06 §6, nota de scope: vive en memoria
     *  del RunController mientras el run está activo, no en esta tabla). */
    async listApplicable(projectId: string): Promise<PermissionRuleRow[]> {
      return driver.prepare<PermissionRuleDbRow>(
        `SELECT * FROM permission_rules WHERE scope = 'global' OR (scope = 'project' AND project_id = ?) ORDER BY created_at ASC`,
      ).all(projectId).map(rowToRuleRow);
    },
  };
}

export function createPermissionDecisionRepository(driver: SqliteDriver): PermissionDecisionRepository {
  return {
    async create(row: PermissionDecisionRow): Promise<PermissionDecisionRow> {
      driver.prepare(
        `INSERT INTO permission_decisions (id, tool_call_id, decision, rule_id, decided_by, reason, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.id, row.toolCallId, row.decision, row.ruleId ?? null, row.decidedBy, row.reason ?? null, row.decidedAt);
      return row;
    },
    async listByToolCall(toolCallId: string): Promise<PermissionDecisionRow[]> {
      return driver.prepare<PermissionDecisionDbRow>(
        'SELECT * FROM permission_decisions WHERE tool_call_id = ? ORDER BY decided_at ASC',
      ).all(toolCallId).map(rowToDecisionRow);
    },
  };
}
