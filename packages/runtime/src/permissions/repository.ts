// Repositorios de memoria de decisiones — packages/runtime/src/permissions/repository.ts.
// Define: doc 06-permisos-y-modos.md §7 ("recordar decisión") y §11 (auditoría), sobre las tablas
// `permission_rules`/`permission_decisions` de doc 03-modelo-de-datos.md §4.4. `persistence/types.ts`
// (contrato, NO se modifica por esta tarea) todavía no declara `PermissionRuleRepository` ni
// `PermissionDecisionRepository` — se definen acá, locales a este módulo, e inyectadas en
// `PermissionMemory` (engine.ts); documentado como deviation en la salida estructurada. Forma de
// las filas alineada 1:1 con el DDL de doc 03 §4.4 para que una futura implementación en
// persistence/repositories.ts pueda satisfacer esta interfaz sin remapear campos.
import type { PermissionDecisionKind } from '@saurio/shared';
import type { PermissionRule } from './types.js';

/** Fila de `permission_rules` (doc 03 §4.4), superconjunto de `PermissionRule` con las columnas
 *  de persistencia que el motor no necesita para evaluar pero sí para auditoría/Settings. */
export interface PermissionRuleRow extends Required<Pick<PermissionRule, 'id' | 'scope' | 'toolName' | 'decision' | 'source'>> {
  pattern?: string;
  projectId?: string;              // NULL en el DDL cuando scope === 'global'
  createdAt: number;
  sourceToolCallId?: string;
}

/** Fila de `permission_decisions` (doc 03 §4.4): una por cada decisión tomada sobre una tool call. */
export interface PermissionDecisionRow {
  id: string;
  toolCallId: string;
  decision: PermissionDecisionKind;
  ruleId?: string;
  decidedBy: 'user' | 'rule' | 'mode';
  reason?: string;
  decidedAt: number;
}

export interface PermissionRuleRepository {
  create(row: PermissionRuleRow): Promise<PermissionRuleRow>;
  delete(id: string): Promise<void>;
  listByScope(scope: PermissionRule['scope'], projectId?: string): Promise<PermissionRuleRow[]>;
  /** Todas las reglas aplicables a un proyecto dado: `global` + `project` (doc §7). */
  listApplicable(projectId: string): Promise<PermissionRuleRow[]>;
}

export interface PermissionDecisionRepository {
  create(row: PermissionDecisionRow): Promise<PermissionDecisionRow>;
  listByToolCall(toolCallId: string): Promise<PermissionDecisionRow[]>;
}
