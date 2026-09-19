import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@saurio/shared';

const eventState = vi.hoisted(() => ({ handler: undefined as ((payload: unknown) => void) | undefined }));

vi.mock('../ipc/client.js', () => ({
  invoke: vi.fn(),
  onEvent: vi.fn((_channel, handler) => {
    eventState.handler = handler;
    return () => { eventState.handler = undefined; };
  }),
}));

const { invoke } = await import('../ipc/client.js');
const { useModelsStore } = await import('./modelsStore.js');
const invokeMock = vi.mocked(invoke);

const model: ModelInfo = {
  ref: { providerId: 'api-local', name: 'modelo-api', locality: 'local' }, digest: '', sizeBytes: 0,
  family: 'api', parameterSize: '', quantization: '',
  capabilities: { tools: true, thinking: false, vision: false, embedding: false },
};

describe('modelsStore.refresh', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    eventState.handler = undefined;
    useModelsStore.setState({ installed: [], loaded: [], loading: false, error: undefined, unsubscribe: undefined });
  });

  it('conserva el inventario de API y vacía la carga cuando Ollama no responde', async () => {
    invokeMock.mockImplementation(async (channel) => {
      if (channel === 'models:list') return [model];
      if (channel === 'models:loaded') throw new Error('Ollama no responde');
      throw new Error(`IPC inesperado: ${channel}`);
    });

    await useModelsStore.getState().refresh();

    expect(useModelsStore.getState()).toMatchObject({ installed: [model], loaded: [], loading: false });
    expect(useModelsStore.getState().error).toContain('No se pudo consultar qué modelos están cargados: Ollama no responde');
  });

  it('mantiene el último inventario si falla su actualización, pero acepta la carga nueva', async () => {
    useModelsStore.setState({ installed: [model], loaded: [], loading: false, error: undefined });
    const loaded = [{ name: 'modelo-local', sizeVramBytes: 1, expiresAt: 2 }];
    invokeMock.mockImplementation(async (channel) => {
      if (channel === 'models:list') throw new Error('provider temporalmente no disponible');
      if (channel === 'models:loaded') return loaded;
      throw new Error(`IPC inesperado: ${channel}`);
    });

    await useModelsStore.getState().refresh();

    expect(useModelsStore.getState()).toMatchObject({ installed: [model], loaded, loading: false });
    expect(useModelsStore.getState().error).toContain('No se pudo actualizar el inventario de modelos: provider temporalmente no disponible');
  });

  it('limpia el error cuando inventario y carga responden', async () => {
    invokeMock.mockImplementation(async (channel) => {
      if (channel === 'models:list') return [model];
      if (channel === 'models:loaded') return [];
      throw new Error(`IPC inesperado: ${channel}`);
    });

    await useModelsStore.getState().refresh({ refresh: true });

    expect(useModelsStore.getState()).toMatchObject({ installed: [model], loaded: [], loading: false, error: undefined });
    expect(invokeMock).toHaveBeenCalledWith('models:list', { refresh: true });
  });

  it('no deja que un refresh anterior pise el resultado más nuevo', async () => {
    let resolveOldInventory: (value: ModelInfo[]) => void;
    let resolveOldLoaded: (value: []) => void;
    const oldInventory = new Promise<ModelInfo[]>((resolve) => { resolveOldInventory = resolve; });
    const oldLoaded = new Promise<[]>((resolve) => { resolveOldLoaded = resolve; });
    const newerModel = { ...model, ref: { ...model.ref, name: 'modelo-nuevo' } };
    let listCalls = 0;
    let loadedCalls = 0;
    invokeMock.mockImplementation((channel) => {
      if (channel === 'models:list') return listCalls++ === 0 ? oldInventory : Promise.resolve([newerModel]);
      if (channel === 'models:loaded') return loadedCalls++ === 0 ? oldLoaded : Promise.resolve([]);
      throw new Error(`IPC inesperado: ${channel}`);
    });

    const oldRefresh = useModelsStore.getState().refresh();
    await useModelsStore.getState().refresh();
    resolveOldInventory!([model]);
    resolveOldLoaded!([]);
    await oldRefresh;

    expect(useModelsStore.getState()).toMatchObject({ installed: [newerModel], loaded: [], loading: false });
  });

  it('un evento models:changed invalida un refresh en vuelo y termina la carga', async () => {
    let resolveInventory: (value: ModelInfo[]) => void;
    let resolveLoaded: (value: []) => void;
    const inventory = new Promise<ModelInfo[]>((resolve) => { resolveInventory = resolve; });
    const loaded = new Promise<[]>((resolve) => { resolveLoaded = resolve; });
    invokeMock.mockImplementation((channel) => {
      if (channel === 'models:list') return inventory;
      if (channel === 'models:loaded') return loaded;
      throw new Error(`IPC inesperado: ${channel}`);
    });
    useModelsStore.getState().subscribe();
    const eventModel = { ...model, ref: { ...model.ref, name: 'desde-evento' } };

    const refresh = useModelsStore.getState().refresh();
    const eventHandler = eventState.handler;
    expect(eventHandler).toBeTypeOf('function');
    if (!eventHandler) throw new Error('No se registró models:changed');
    eventHandler({ installed: [eventModel], loaded: [] });
    resolveInventory!([model]);
    resolveLoaded!([]);
    await refresh;

    expect(useModelsStore.getState()).toMatchObject({ installed: [eventModel], loaded: [], loading: false, error: undefined });
  });
});
