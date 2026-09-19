import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, ModelRef } from '@saurio/shared';
import type { ModelSelectProps } from './ModelSelect.js';

// El proyecto no instala un DOM de test. Este harness recorre el árbol JSX y conserva los hooks
// necesarios para disparar los handlers reales del combobox sin reemplazar su navegación.
const hooks = vi.hoisted(() => ({ state: [] as unknown[], refs: [] as Array<{ current: unknown }>, stateIndex: 0, refIndex: 0 }));
const preferences = vi.hoisted(() => ({
  hidden: [] as ModelRef[], load: vi.fn(), toggleFavorite: vi.fn(), rememberRecent: vi.fn(), toggleHidden: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState(initial: unknown) {
      const index = hooks.stateIndex++;
      if (!(index in hooks.state)) hooks.state[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      const setValue = (next: unknown) => {
        hooks.state[index] = typeof next === 'function'
          ? (next as (previous: unknown) => unknown)(hooks.state[index])
          : next;
      };
      return [hooks.state[index], setValue];
    },
    useRef(initial: unknown) {
      const index = hooks.refIndex++;
      if (!hooks.refs[index]) hooks.refs[index] = { current: initial };
      return hooks.refs[index];
    },
    useId: () => 'model-select-test',
    useMemo: <T,>(factory: () => T) => factory(),
    useCallback: <T,>(callback: T) => callback,
    useEffect() { /* los efectos de foco no son necesarios para probar handlers */ },
  };
});

vi.mock('./modelPreferencesStore.js', () => ({
  modelRefIdentity: (ref: ModelRef) => `${ref.providerId}::${ref.name}`,
  useModelPreferencesStore: (selector: (state: unknown) => unknown) => selector({
    favorites: [], recents: [], hidden: preferences.hidden, error: undefined,
    load: preferences.load, toggleFavorite: preferences.toggleFavorite, rememberRecent: preferences.rememberRecent, toggleHidden: preferences.toggleHidden,
  }),
}));

vi.mock('../../stores/uiNavStore.js', () => ({ useUiNavStore: { getState: () => ({ requestTab: vi.fn() }) } }));

const { ModelSelect } = await import('./ModelSelect.js');

type ElementNode = { type?: unknown; props?: Record<string, unknown> };

function model(name: string): ModelInfo {
  return {
    ref: { providerId: 'local', name, locality: 'local' }, digest: name, sizeBytes: 1,
    family: 'test', parameterSize: '8B', quantization: 'Q4',
    capabilities: { tools: true, thinking: false, vision: false, embedding: false }, contextMax: 8192,
  };
}

const models = [model('alfa'), model('beta'), model('gamma')];

function render(props: ModelSelectProps): ElementNode {
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  return ModelSelect(props) as unknown as ElementNode;
}

function findNodes(node: unknown, predicate: (item: ElementNode) => boolean): ElementNode[] {
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, predicate));
  if (!node || typeof node !== 'object') return [];
  const item = node as ElementNode;
  const own = predicate(item) ? [item] : [];
  const children = item.props?.children;
  return own.concat(...(Array.isArray(children) ? children : [children]).flatMap((child) => findNodes(child, predicate)));
}

function findOne(tree: ElementNode, predicate: (item: ElementNode) => boolean): ElementNode {
  const found = findNodes(tree, predicate)[0];
  if (!found) throw new Error('No se encontró el control esperado');
  return found;
}

function trigger(tree: ElementNode): ElementNode {
  return findOne(tree, (node) => node.props?.className === 'saurio-model-select__trigger');
}

function search(tree: ElementNode): ElementNode {
  return findOne(tree, (node) => node.props?.role === 'combobox' && node.type === 'input');
}

function options(tree: ElementNode): ElementNode[] {
  // ModelOption es un componente hijo: el árbol JSX del harness conserva sus props sin ejecutar
  // una segunda renderización. El id de opción es el contrato que consume aria-activedescendant.
  return findNodes(tree, (node) => typeof node.props?.model === 'object' && node.props.model !== null);
}

function keyEvent(key: string): { key: string; preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn> } {
  return { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

describe('ModelSelect: combobox de teclado', () => {
  const onChange = vi.fn();
  const onPopoverOpenChange = vi.fn();
  const props = (): ModelSelectProps => ({
    models, providers: [], value: models[0]!.ref, onChange, onPopoverOpenChange,
  });

  beforeEach(() => {
    hooks.state = [];
    hooks.refs = [];
    hooks.stateIndex = 0;
    hooks.refIndex = 0;
    onChange.mockReset();
    onPopoverOpenChange.mockReset();
    preferences.load.mockReset();
    preferences.toggleFavorite.mockReset();
    preferences.rememberRecent.mockReset();
    preferences.toggleHidden.mockReset();
    preferences.hidden = [];
  });

  it('recorre opciones con flechas, Home y End, y Enter confirma la activa sin elegir la primera', () => {
    let tree = render(props());
    const open = trigger(tree).props?.onClick;
    if (typeof open !== 'function') throw new Error('El disparador no abre el combobox');
    open();
    tree = render(props());

    let keyboard = keyEvent('ArrowDown');
    (search(tree).props?.onKeyDown as (event: typeof keyboard) => void)(keyboard);
    tree = render(props());
    expect(search(tree).props?.['aria-activedescendant']).toBe(options(tree)[1]?.props?.id);
    expect(options(tree)[1]?.props?.active).toBe(true);

    keyboard = keyEvent('ArrowUp');
    (search(tree).props?.onKeyDown as (event: typeof keyboard) => void)(keyboard);
    tree = render(props());
    expect(search(tree).props?.['aria-activedescendant']).toBe(options(tree)[0]?.props?.id);

    keyboard = keyEvent('End');
    (search(tree).props?.onKeyDown as (event: typeof keyboard) => void)(keyboard);
    tree = render(props());
    expect(search(tree).props?.['aria-activedescendant']).toBe(options(tree)[2]?.props?.id);

    keyboard = keyEvent('Home');
    (search(tree).props?.onKeyDown as (event: typeof keyboard) => void)(keyboard);
    tree = render(props());
    expect(search(tree).props?.['aria-activedescendant']).toBe(options(tree)[0]?.props?.id);

    keyboard = keyEvent('ArrowDown');
    (search(tree).props?.onKeyDown as (event: typeof keyboard) => void)(keyboard);
    tree = render(props());
    keyboard = keyEvent('Enter');
    (search(tree).props?.onKeyDown as (event: typeof keyboard) => void)(keyboard);

    expect(onChange).toHaveBeenCalledWith(models[1]!.ref);
    expect(keyboard.preventDefault).toHaveBeenCalledOnce();
  });

  it('confirma el término filtrado activo y Escape sólo cierra el popover anidado', () => {
    let tree = render(props());
    (trigger(tree).props?.onClick as () => void)();
    tree = render(props());
    const change = search(tree).props?.onChange;
    if (typeof change !== 'function') throw new Error('La búsqueda no actualiza el filtro');
    change({ target: { value: 'gamma' } });
    tree = render(props());
    // La selección vigente se conserva como referencia, pero el término filtrado queda activo.
    expect(options(tree)).toHaveLength(2);
    expect(search(tree).props?.['aria-activedescendant']).toBe(options(tree)[1]?.props?.id);

    let keyboard = keyEvent('Enter');
    (search(tree).props?.onKeyDown as (event: typeof keyboard) => void)(keyboard);
    expect(onChange).toHaveBeenCalledWith(models[2]!.ref);

    tree = render(props());
    (trigger(tree).props?.onClick as () => void)();
    tree = render(props());
    keyboard = keyEvent('Escape');
    (search(tree).props?.onKeyDown as (event: typeof keyboard) => void)(keyboard);
    expect(keyboard.preventDefault).toHaveBeenCalledOnce();
    expect(keyboard.stopPropagation).toHaveBeenCalledOnce();
    expect(onPopoverOpenChange.mock.calls.at(-1)).toEqual([false]);
  });

  it('excluye modelos ocultos, pero conserva identificado el modelo oculto que ya usa el chat', () => {
    preferences.hidden = [models[0]!.ref];

    let tree = render(props());
    (trigger(tree).props?.onClick as () => void)();
    tree = render(props());
    expect(options(tree).map((option) => (option.props?.model as ModelInfo).ref.name)).toEqual(['alfa', 'beta', 'gamma']);
    expect(options(tree)[0]?.props?.hidden).toBe(true);

    hooks.state = [];
    hooks.refs = [];
    tree = render({ ...props(), value: undefined });
    (trigger(tree).props?.onClick as () => void)();
    tree = render({ ...props(), value: undefined });
    expect(options(tree).map((option) => (option.props?.model as ModelInfo).ref.name)).toEqual(['beta', 'gamma']);
  });
});
