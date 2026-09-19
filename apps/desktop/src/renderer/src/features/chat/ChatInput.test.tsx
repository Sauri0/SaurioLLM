import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '@saurio/shared';
import type { ChatInputProps } from './ChatInput.js';

// No hay DOM renderer ni testing-library en el monorepo. Este harness mínimo ejecuta el componente
// con hooks controlados y recorre el árbol JSX resultante para disparar los handlers reales.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
const attachmentMocks = vi.hoisted(() => ({ fileToAttachment: vi.fn() }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState(initial: unknown) {
      const slot = hooks.index++;
      if (!(slot in hooks.slots)) hooks.slots[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      const setValue = (next: unknown) => {
        hooks.slots[slot] = typeof next === 'function'
          ? (next as (previous: unknown) => unknown)(hooks.slots[slot])
          : next;
      };
      return [hooks.slots[slot], setValue];
    },
    useRef(initial: unknown) {
      const slot = hooks.index++;
      if (!(slot in hooks.slots)) hooks.slots[slot] = { current: initial };
      return hooks.slots[slot];
    },
    useEffect() { hooks.index += 1; },
  };
});

vi.mock('./attachments.js', () => ({
  MAX_ATTACHMENT_BYTES: 10 * 1024 * 1024,
  formatAttachmentSize: () => '1 B',
  fileToAttachment: attachmentMocks.fileToAttachment,
}));

const { ChatInput } = await import('./ChatInput.js');

type ElementNode = { type?: unknown; props?: Record<string, unknown> };

const attachment: Attachment = {
  kind: 'file', name: 'nota.txt', mime: 'text/plain', dataBase64: 'bm90YQ==', sizeBytes: 4,
};

const baseProps = (onSend: ChatInputProps['onSend']): ChatInputProps => ({
  mode: 'agent', onModeChange: vi.fn(), effort: 'balanced', onEffortChange: vi.fn(),
  permissionPreset: 'ask', onPermissionPresetChange: vi.fn(), isRunning: false,
  onSend, onCancel: vi.fn(), modelName: 'modelo de prueba', contextLabel: undefined,
});

function render(props: ChatInputProps): ElementNode {
  hooks.index = 0;
  return ChatInput(props) as unknown as ElementNode;
}

function findNode(node: unknown, predicate: (item: ElementNode) => boolean): ElementNode {
  if (!node || typeof node !== 'object') throw new Error('No se encontró el control esperado');
  const item = node as ElementNode;
  if (predicate(item)) return item;
  const children = item.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    try {
      return findNode(child, predicate);
    } catch {
      // Continúa por los demás hijos del árbol JSX.
    }
  }
  throw new Error('No se encontró el control esperado');
}

function textarea(tree: ElementNode): ElementNode {
  return findNode(tree, (item) => item.type === 'textarea');
}

function sendButton(tree: ElementNode): ElementNode {
  return findNode(tree, (item) => item.props?.className === 'chat-input__send saurio-btn-primary');
}

function fileInput(tree: ElementNode): ElementNode {
  return findNode(tree, (item) => item.type === 'input' && item.props?.type === 'file');
}

function changeText(tree: ElementNode, value: string): void {
  const handler = textarea(tree).props?.onChange;
  if (typeof handler !== 'function') throw new Error('Textarea sin onChange');
  (handler as (event: { target: { value: string } }) => void)({ target: { value } });
}

function attachFile(tree: ElementNode): void {
  const handler = fileInput(tree).props?.onChange;
  if (typeof handler !== 'function') throw new Error('Input de archivo sin onChange');
  const target = { files: [{ name: 'nota.txt', type: 'text/plain', size: 4 }] as unknown as FileList, value: 'nota.txt' };
  (handler as (event: { target: typeof target }) => void)({ target });
}

function clickSend(tree: ElementNode): void {
  const handler = sendButton(tree).props?.onClick;
  if (typeof handler !== 'function') throw new Error('Botón Enviar sin onClick');
  (handler as () => void)();
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ChatInput: envío asíncrono', () => {
  beforeEach(() => {
    hooks.slots = [];
    hooks.index = 0;
    attachmentMocks.fileToAttachment.mockReset();
    attachmentMocks.fileToAttachment.mockResolvedValue(attachment);
  });

  it('conserva texto y adjuntos, y muestra el error, si onSend rechaza', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('El run fue rechazado'));
    const props = baseProps(onSend);
    let tree = render(props);
    changeText(tree, '  borrador importante  ');
    tree = render(props);
    attachFile(tree);
    await settle();
    tree = render(props);

    clickSend(tree);
    await settle();
    tree = render(props);

    expect(onSend).toHaveBeenCalledWith('borrador importante', [attachment]);
    expect(textarea(tree).props?.value).toBe('  borrador importante  ');
    expect(findNode(tree, (item) => item.props?.role === 'alert').props?.children).toBe('El run fue rechazado');
    expect(findNode(tree, (item) => item.props?.className === 'chat-input__attachment-name').props?.children).toBe('nota.txt');
  });

  it('limpia texto y adjuntos solamente después de que onSend resuelve', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const props = baseProps(onSend);
    let tree = render(props);
    changeText(tree, 'mensaje enviado');
    tree = render(props);
    attachFile(tree);
    await settle();
    tree = render(props);

    clickSend(tree);
    await settle();
    tree = render(props);

    expect(onSend).toHaveBeenCalledWith('mensaje enviado', [attachment]);
    expect(textarea(tree).props?.value).toBe('');
    expect(() => findNode(tree, (item) => item.props?.className === 'chat-input__attachment-name')).toThrow();
  });

  it('la doble acción mientras el envío está pendiente sólo inicia un run', async () => {
    let resolveSend: () => void;
    const pending = new Promise<void>((resolve) => { resolveSend = resolve; });
    const onSend = vi.fn(() => pending);
    const props = baseProps(onSend);
    let tree = render(props);
    changeText(tree, 'una sola vez');
    tree = render(props);

    clickSend(tree);
    clickSend(tree);
    expect(onSend).toHaveBeenCalledTimes(1);
    resolveSend!();
    await settle();
    tree = render(props);

    expect(textarea(tree).props?.value).toBe('');
  });
});
