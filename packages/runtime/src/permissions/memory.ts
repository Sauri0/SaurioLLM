// Memoria de decisiones ("recordar decisión") — packages/runtime/src/permissions/memory.ts.
// Define: doc 06-permisos-y-modos.md §7. Traduce un `PermissionAnswer` del usuario en una fila de
// `permission_decisions` (siempre) y, si corresponde (`allow_always`/deny explícito con "recordar"),
// una fila de `permission_rules` — vía los repositorios inyectados de repository.ts (locales a este
// módulo, ver deviations: `persistence/types.ts` no los declara todavía). También expone `loadRules`
// para que el runtime arme el `PermissionPolicy.rules` de proyecto/global antes de llamar a
// `PermissionEngine.evaluate` (el propio motor es sin estado, doc §6).
import type { PermissionAnswer, PermissionDecision, PermissionRequest } from '@saurio/shared';
import type { PermissionRule } from './types.js';
import type {
  PermissionDecisionRepository, PermissionDecisionRow, PermissionRuleRepository, PermissionRuleRow,
} from './repository.js';

export interface IdGenerator { (): string }
export interface Clock { now(): number }

const defaultClock: Clock = { now: () => Date.now() };

function rowToRule(row: PermissionRuleRow): PermissionRule {
  return { id: row.id, scope: row.scope, toolName: row.toolName, pattern: row.pattern, decision: row.decision, source: row.source };
}

export class PermissionMemory {
  constructor(
    private readonly rules: PermissionRuleRepository,
    private readonly decisions: PermissionDecisionRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock = defaultClock,
  ) {}

  /** Reglas `project` + `global` aplicables, para componer `PermissionPolicy.rules` (doc §6 pasos
   *  4-5; las de `session`/"reglas del agente" no persisten acá — ver nota de scope, doc §6). */
  async loadRules(projectId: string): Promise<PermissionRule[]> {
    const rows = await this.rules.listApplicable(projectId);
    return rows.map(rowToRule);
  }

  /** Registra la decisión del usuario sobre una `PermissionRequest` en `ask`, y crea una
   *  `PermissionRule` si el usuario eligió "permitir siempre" / "denegar siempre" con scope. */
  async recordAnswer(
    request: PermissionRequest, answer: PermissionAnswer, projectId: string | undefined,
    sourceToolCallId: string | undefined,
  ): Promise<{ decisionRow: PermissionDecisionRow; rule?: PermissionRule }> {
    const decisionKind = answer.answer === 'deny' ? 'deny' : 'allow';
    let rule: PermissionRule | undefined;

    if (answer.answer === 'allow_always' && answer.rememberScope) {
      const pattern = answer.pattern
        ?? request.rememberOptions.find((o) => o.scope === answer.rememberScope)?.suggestedPattern;
      const row: PermissionRuleRow = {
        id: this.ids(),
        scope: answer.rememberScope,
        toolName: request.toolName,
        pattern,
        decision: 'allow',
        source: 'user',
        projectId: answer.rememberScope === 'project' ? projectId : undefined,
        createdAt: this.clock.now(),
        sourceToolCallId,
      };
      const created = await this.rules.create(row);
      rule = rowToRule(created);
    }

    const decisionRow: PermissionDecisionRow = {
      id: this.ids(),
      toolCallId: request.toolCallId,
      decision: decisionKind,
      ruleId: rule?.id,
      decidedBy: 'user',
      reason: answer.reason,
      decidedAt: this.clock.now(),
    };
    const created = await this.decisions.create(decisionRow);
    return { decisionRow: created, rule };
  }

  /** Registra una decisión tomada automáticamente por una regla o por el modo (sin intervención
   *  del usuario), para que `permission_decisions` quede completo incluso cuando `evaluate()`
   *  resuelve sin preguntar (doc §11: "una fila por cada decisión tomada sobre una tool call"). */
  async recordAutoDecision(toolCallId: string, decision: PermissionDecision): Promise<PermissionDecisionRow> {
    if (decision.decision === 'ask') {
      throw new Error('recordAutoDecision: una decisión "ask" todavía no tiene resolución del usuario');
    }
    const row: PermissionDecisionRow = {
      id: this.ids(),
      toolCallId,
      decision: decision.decision,
      ruleId: decision.ruleId,
      decidedBy: decision.decidedBy,
      reason: decision.reason,
      decidedAt: this.clock.now(),
    };
    return this.decisions.create(row);
  }
}
