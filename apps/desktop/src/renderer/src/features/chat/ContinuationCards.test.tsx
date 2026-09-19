import { describe, expect, it, vi } from 'vitest';
import { InterruptedRunCard } from './InterruptedRunCard.js';
import { OomLoadCard } from './OomLoadCard.js';

type ElementNode = { type?: unknown; props?: Record<string, unknown> };

function findNodes(node: unknown, predicate: (item: ElementNode) => boolean): ElementNode[] {
  if (!node || typeof node !== 'object') return [];
  const item = node as ElementNode;
  const own = predicate(item) ? [item] : [];
  const children = item.props?.children;
  return own.concat(...(Array.isArray(children) ? children : [children]).flatMap((child) => findNodes(child, predicate)));
}

describe('tarjetas de continuación', () => {
  it('deshabilita la reanudación duplicada y deja el error accesible en la tarjeta interrumpida', () => {
    const tree = InterruptedRunCard({
      info: { runId: 'run-1', chatId: 'chat-1', orphaned: [], abandoned: [] },
      busy: true,
      recoverError: 'El run ya no se puede continuar.',
      onRecover: vi.fn().mockResolvedValue(undefined),
      onDismiss: vi.fn(),
    }) as unknown as ElementNode;

    const buttons = findNodes(tree, (node) => node.type === 'button');
    expect(buttons.map((button) => button.props?.disabled)).toEqual([true, true]);
    expect(buttons[0]?.props?.children).toBe('Reanudando…');
    expect(findNodes(tree, (node) => node.props?.role === 'alert')[0]?.props?.children).toEqual([
      'No se pudo reanudar: ', 'El run ya no se puede continuar.',
    ]);
  });

  it('bloquea el reintento OOM pendiente y conserva su error visible', () => {
    const tree = OomLoadCard({
      runId: 'run-1',
      error: { code: 'oom_load', message: 'Sin memoria disponible.' } as never,
      modelName: 'modelo',
      busy: true,
      retryError: 'El motor no respondió.',
      onRetry: vi.fn().mockResolvedValue(undefined),
    }) as unknown as ElementNode;

    const retryButton = findNodes(tree, (node) => node.type === 'button' && node.props?.className === 'saurio-btn-primary')[0];
    expect(retryButton?.props?.disabled).toBe(true);
    expect(retryButton?.props?.children).toBe('Reintentando…');
    expect(findNodes(tree, (node) => node.props?.role === 'alert').at(-1)?.props?.children).toEqual([
      'No se pudo reintentar: ', 'El motor no respondió.',
    ]);
  });
});
