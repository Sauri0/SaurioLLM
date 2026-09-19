import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRef } from '@saurio/shared';

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../../ipc/client.js', () => ({ invoke: ipc.invoke }));

const {
  MODEL_HIDDEN_KEY, MODEL_FAVORITES_KEY, MODEL_RECENTS_KEY, parseModelRefs, useModelPreferencesStore,
} = await import('./modelPreferencesStore.js');

const model: ModelRef = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' };

function resetStore(): void {
  useModelPreferencesStore.setState({
    favorites: [], recents: [], hidden: [], persistedHidden: [], loaded: false, loading: false, error: null,
  });
}

describe('modelPreferencesStore', () => {
  beforeEach(() => {
    resetStore();
    ipc.invoke.mockReset();
  });

  it('carga y deduplica ocultos por providerId+name junto con las demás preferencias', async () => {
    ipc.invoke.mockImplementation((_channel: string, input: { key: string }) => {
      if (input.key === MODEL_HIDDEN_KEY) return Promise.resolve([model, { ...model, locality: 'cloud' }]);
      if (input.key === MODEL_FAVORITES_KEY) return Promise.resolve([]);
      if (input.key === MODEL_RECENTS_KEY) return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    await useModelPreferencesStore.getState().load();

    expect(useModelPreferencesStore.getState().hidden).toEqual([model]);
    expect(parseModelRefs([{ providerId: '', name: 'inválido', locality: 'local' }, model])).toEqual([model]);
  });

  it('revierte el último cambio fallido y deja el error visible', async () => {
    ipc.invoke.mockRejectedValueOnce(new Error('settings sin disco'));

    await useModelPreferencesStore.getState().toggleHidden(model);

    expect(useModelPreferencesStore.getState().hidden).toEqual([]);
    expect(useModelPreferencesStore.getState().error).toContain('settings sin disco');
    expect(ipc.invoke).toHaveBeenCalledWith('settings:set', { key: MODEL_HIDDEN_KEY, value: [model] });
  });

  it('no revierte un segundo clic cuando falla la escritura anterior y persiste la intención final', async () => {
    let rejectFirst: (reason?: unknown) => void = () => undefined;
    let resolveSecond: () => void = () => undefined;
    let writeCount = 0;
    ipc.invoke.mockImplementation(() => {
      writeCount += 1;
      return new Promise<void>((resolve, reject) => {
        if (writeCount === 1) rejectFirst = reject;
        else resolveSecond = resolve;
      });
    });

    const hide = useModelPreferencesStore.getState().toggleHidden(model);
    const restore = useModelPreferencesStore.getState().toggleHidden(model);
    expect(useModelPreferencesStore.getState().hidden).toEqual([]);

    await Promise.resolve();
    await Promise.resolve();
    expect(writeCount).toBe(1);
    rejectFirst(new Error('primer guardado falló'));
    await hide;
    await Promise.resolve();
    await Promise.resolve();
    expect(writeCount).toBe(2);
    resolveSecond();
    await restore;

    expect(useModelPreferencesStore.getState().hidden).toEqual([]);
    expect(useModelPreferencesStore.getState().error).toBeNull();
    expect(ipc.invoke).toHaveBeenNthCalledWith(1, 'settings:set', { key: MODEL_HIDDEN_KEY, value: [model] });
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'settings:set', { key: MODEL_HIDDEN_KEY, value: [] });
  });

  it('vuelve al último valor confirmado si falla el cambio más reciente', async () => {
    ipc.invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('segundo guardado falló'));

    await useModelPreferencesStore.getState().toggleHidden(model);
    await useModelPreferencesStore.getState().toggleHidden(model);

    expect(useModelPreferencesStore.getState().hidden).toEqual([model]);
    expect(useModelPreferencesStore.getState().persistedHidden).toEqual([model]);
    expect(useModelPreferencesStore.getState().error).toContain('segundo guardado falló');
  });
});
