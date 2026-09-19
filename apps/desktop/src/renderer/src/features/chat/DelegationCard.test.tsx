import { describe, expect, it, vi } from 'vitest';
import type { ToolCallRecord } from '@saurio/shared';
import { DelegationCard } from './DelegationCard.js';

type ElementNode = { type?: unknown; props?: Record<string, unknown> };

function findNodes(node: unknown, predicate: (item: ElementNode) => boolean): ElementNode[] {
  if (!node || typeof node !== 'object') return [];
  const item = node as ElementNode;
  const own = predicate(item) ? [item] : [];
  const children = item.props?.children;
  return own.concat(...(Array.isArray(children) ? children : [children]).flatMap((child) => findNodes(child, predicate)));
}

function runningDelegate(): ToolCallRecord {
  return {
    id: 'call_delegate', runId: 'run_parent', iteration: 0, toolName: 'delegate',
    args: { task: 'revisar', expectedDeliverable: 'informe' }, argsHash: 'hash', category: 'delegate',
    risk: 'medium', transport: 'native', status: 'running', startedAt: 1,
  };
}

describe('DelegationCard', () => {
  it('detiene sólo el hijo correlacionado y bloquea clicks duplicados', () => {
    const stop = vi.fn();
    const tree = DelegationCard({
      call: runningDelegate(), childRunId: 'run_child', childRunState: 'generating', stopping: true,
      onStopChild: stop,
    }) as unknown as ElementNode;
    const button = findNodes(tree, (node) => node.props?.className === 'saurio-btn-ghost delegation-card__stop')[0];
    expect(button?.props?.disabled).toBe(true);
    expect(button?.props?.children).toBe('Deteniendo…');
    (button?.props?.onClick as (() => void))();
    expect(stop).toHaveBeenCalledWith('run_parent', 'run_child');
  });

  it('oculta Detener cuando el hijo ya terminó y expone el error recuperable', () => {
    const tree = DelegationCard({
      call: runningDelegate(), childRunId: 'run_child', childRunState: 'completed',
      stopError: 'la relación cambió', onStopChild: vi.fn(),
    }) as unknown as ElementNode;
    expect(findNodes(tree, (node) => node.props?.className === 'saurio-btn-ghost delegation-card__stop')).toHaveLength(0);
    expect(findNodes(tree, (node) => node.props?.role === 'alert')[0]?.props?.children)
      .toEqual(['No se pudo detener: ', 'la relación cambió']);
  });
});
