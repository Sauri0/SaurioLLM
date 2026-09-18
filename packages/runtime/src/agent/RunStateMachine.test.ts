import { describe, expect, it } from 'vitest';
import { RunStateMachine, InvalidTransitionError } from './RunStateMachine.js';

describe('RunStateMachine', () => {
  it('acepta las aristas documentadas (doc 05 §1 / doc 10 §2)', () => {
    const sm = new RunStateMachine();
    expect(sm.canTransition('created', 'preparing')).toBe(true);
    expect(sm.canTransition('queued', 'generating')).toBe(true);
    expect(sm.canTransition('parsing', 'executing_tool')).toBe(true);
    expect(sm.canTransition('executing_tool', 'queued')).toBe(true);
    expect(sm.canTransition('awaiting_permission', 'executing_tool')).toBe(true);
    expect(() => sm.assert('queued', 'generating')).not.toThrow();
  });

  it('rechaza aristas inexistentes', () => {
    const sm = new RunStateMachine();
    expect(sm.canTransition('queued', 'parsing')).toBe(false);
    expect(() => sm.assert('queued', 'parsing')).toThrow(InvalidTransitionError);
  });

  it('rechaza -> interrupted fuera de recover(), y la acepta con allowRecoverOnly', () => {
    const sm = new RunStateMachine();
    expect(() => sm.assert('executing_tool', 'interrupted')).toThrow(InvalidTransitionError);
    expect(() => sm.assert('executing_tool', 'interrupted', { allowRecoverOnly: true })).not.toThrow();
  });

  it('los estados terminales no tienen salidas', () => {
    const sm = new RunStateMachine();
    expect(sm.canTransition('completed', 'created')).toBe(false);
    expect(sm.canTransition('failed', 'queued')).toBe(false);
  });
});
