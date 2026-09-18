// Tests de PermissionMemory ("recordar decisión", doc 06 §7) contra repos fake en memoria.
import { describe, expect, it } from 'vitest';
import type { PermissionAnswer, PermissionDecision, PermissionRequest } from '@saurio/shared';
import { PermissionMemory } from './memory.js';
import type {
  PermissionDecisionRepository, PermissionDecisionRow, PermissionRuleRepository, PermissionRuleRow,
} from './repository.js';

class FakeRuleRepo implements PermissionRuleRepository {
  rows: PermissionRuleRow[] = [];
  async create(row: PermissionRuleRow) { this.rows.push(row); return row; }
  async delete(id: string) { this.rows = this.rows.filter((r) => r.id !== id); }
  async listByScope(scope: PermissionRuleRow['scope'], projectId?: string) {
    return this.rows.filter((r) => r.scope === scope && (projectId === undefined || r.projectId === projectId));
  }
  async listApplicable(projectId: string) {
    return this.rows.filter((r) => r.scope === 'global' || (r.scope === 'project' && r.projectId === projectId));
  }
}

class FakeDecisionRepo implements PermissionDecisionRepository {
  rows: PermissionDecisionRow[] = [];
  async create(row: PermissionDecisionRow) { this.rows.push(row); return row; }
  async listByToolCall(toolCallId: string) { return this.rows.filter((r) => r.toolCallId === toolCallId); }
}

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    toolCallId: 'tc1', toolName: 'run_command', category: 'terminal', risk: 'low',
    summary: 'npm test', triggeredBy: 'categoría terminal -> ask (preset balanced)',
    rememberOptions: [{ scope: 'project', suggestedPattern: 'npm test' }, { scope: 'global', suggestedPattern: 'npm test' }],
    ...overrides,
  };
}

describe('PermissionMemory.recordAnswer', () => {
  it('allow_once: registra permission_decisions, no crea regla', async () => {
    const rules = new FakeRuleRepo();
    const decisions = new FakeDecisionRepo();
    let n = 0;
    const mem = new PermissionMemory(rules, decisions, () => `id${n++}`, { now: () => 1000 });
    const answer: PermissionAnswer = { toolCallId: 'tc1', answer: 'allow_once' };

    const { decisionRow, rule } = await mem.recordAnswer(makeRequest(), answer, 'proj1', undefined);

    expect(rule).toBeUndefined();
    expect(rules.rows).toHaveLength(0);
    expect(decisionRow.decision).toBe('allow');
    expect(decisionRow.decidedBy).toBe('user');
    expect(decisions.rows).toHaveLength(1);
  });

  it('allow_always con scope project: crea PermissionRule ligada al proyecto', async () => {
    const rules = new FakeRuleRepo();
    const decisions = new FakeDecisionRepo();
    let n = 0;
    const mem = new PermissionMemory(rules, decisions, () => `id${n++}`, { now: () => 1000 });
    const answer: PermissionAnswer = { toolCallId: 'tc1', answer: 'allow_always', rememberScope: 'project' };

    const { rule, decisionRow } = await mem.recordAnswer(makeRequest(), answer, 'proj1', 'tc1');

    expect(rule).toBeDefined();
    expect(rule?.scope).toBe('project');
    expect(rule?.pattern).toBe('npm test');
    expect(rules.rows[0]?.projectId).toBe('proj1');
    expect(decisionRow.ruleId).toBe(rule?.id);
  });

  it('allow_always con scope global: projectId queda undefined (NULL en el DDL)', async () => {
    const rules = new FakeRuleRepo();
    const decisions = new FakeDecisionRepo();
    let n = 0;
    const mem = new PermissionMemory(rules, decisions, () => `id${n++}`, { now: () => 1000 });
    const answer: PermissionAnswer = { toolCallId: 'tc1', answer: 'allow_always', rememberScope: 'global' };

    await mem.recordAnswer(makeRequest(), answer, 'proj1', undefined);

    expect(rules.rows[0]?.scope).toBe('global');
    expect(rules.rows[0]?.projectId).toBeUndefined();
  });

  it('allow_always respeta un pattern editado por el usuario en vez del sugerido', async () => {
    const rules = new FakeRuleRepo();
    const decisions = new FakeDecisionRepo();
    let n = 0;
    const mem = new PermissionMemory(rules, decisions, () => `id${n++}`, { now: () => 1000 });
    const answer: PermissionAnswer = { toolCallId: 'tc1', answer: 'allow_always', rememberScope: 'project', pattern: 'npm *' };

    const { rule } = await mem.recordAnswer(makeRequest(), answer, 'proj1', undefined);

    expect(rule?.pattern).toBe('npm *');
  });

  it('deny: registra permission_decisions sin crear regla si no hay rememberScope', async () => {
    const rules = new FakeRuleRepo();
    const decisions = new FakeDecisionRepo();
    let n = 0;
    const mem = new PermissionMemory(rules, decisions, () => `id${n++}`, { now: () => 1000 });
    const answer: PermissionAnswer = { toolCallId: 'tc1', answer: 'deny', reason: 'no hace falta' };

    const { decisionRow, rule } = await mem.recordAnswer(makeRequest(), answer, 'proj1', undefined);

    expect(rule).toBeUndefined();
    expect(decisionRow.decision).toBe('deny');
    expect(decisionRow.reason).toBe('no hace falta');
  });
});

describe('PermissionMemory.loadRules', () => {
  it('trae reglas project + global, no session', async () => {
    const rules = new FakeRuleRepo();
    rules.rows = [
      { id: 'r1', scope: 'project', projectId: 'proj1', toolName: 'edit_file', pattern: 'src/**', decision: 'allow', source: 'user', createdAt: 1 },
      { id: 'r2', scope: 'global', toolName: 'run_command', pattern: 'npm test', decision: 'allow', source: 'user', createdAt: 1 },
      { id: 'r3', scope: 'project', projectId: 'other', toolName: 'edit_file', pattern: 'src/**', decision: 'allow', source: 'user', createdAt: 1 },
    ];
    const decisions = new FakeDecisionRepo();
    const mem = new PermissionMemory(rules, decisions, () => 'id', { now: () => 1000 });

    const loaded = await mem.loadRules('proj1');
    expect(loaded.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });
});

describe('PermissionMemory.recordAutoDecision', () => {
  it('registra una decisión allow/deny tomada sin intervención del usuario', async () => {
    const rules = new FakeRuleRepo();
    const decisions = new FakeDecisionRepo();
    const mem = new PermissionMemory(rules, decisions, () => 'id1', { now: () => 2000 });
    const decision: PermissionDecision = { decision: 'allow', decidedBy: 'rule', reason: 'x', ruleId: 'r1' };

    const row = await mem.recordAutoDecision('tc2', decision);

    expect(row.decidedBy).toBe('rule');
    expect(row.decision).toBe('allow');
    expect(row.ruleId).toBe('r1');
  });

  it('rechaza registrar una decisión "ask" (todavía no resuelta)', async () => {
    const rules = new FakeRuleRepo();
    const decisions = new FakeDecisionRepo();
    const mem = new PermissionMemory(rules, decisions, () => 'id1');
    const request = makeRequest();

    await expect(mem.recordAutoDecision('tc2', { decision: 'ask', request })).rejects.toThrow();
  });
});
