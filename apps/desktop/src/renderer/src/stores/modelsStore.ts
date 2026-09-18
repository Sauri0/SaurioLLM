// modelsStore: catálogo instalado + modelos cargados (doc 01 §4.1, doc 04 §16 `models:list/loaded`,
// evento `models:changed`) — apps/desktop/src/renderer/src/stores/modelsStore.ts.
import { create } from 'zustand';
import type { LoadedModel, ModelInfo } from '@saurio/shared';
import { invoke, onEvent } from '../ipc/client.js';

export interface ModelsStoreState {
  installed: ModelInfo[];
  loaded: LoadedModel[];
  loading: boolean;
  error: string | undefined;
  unsubscribe: (() => void) | undefined;

  refresh: (opts?: { refresh?: boolean }) => Promise<void>;
  subscribe: () => void;
}

export const useModelsStore = create<ModelsStoreState>((set, get) => ({
  installed: [],
  loaded: [],
  loading: false,
  error: undefined,
  unsubscribe: undefined,

  refresh: async (opts) => {
    set({ loading: true, error: undefined });
    try {
      const [installed, loaded] = await Promise.all([
        invoke('models:list', { refresh: opts?.refresh }),
        invoke('models:loaded', undefined),
      ]);
      set({ installed, loaded, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  subscribe: () => {
    if (get().unsubscribe) {
      return;
    }
    const off = onEvent('models:changed', (payload) => {
      set({ installed: payload.installed, loaded: payload.loaded });
    });
    set({ unsubscribe: off });
  },
}));
