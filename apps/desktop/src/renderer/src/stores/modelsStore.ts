// modelsStore: catálogo instalado + modelos cargados (doc 01 §4.1, doc 04 §16 `models:list/loaded`,
// evento `models:changed`) — apps/desktop/src/renderer/src/stores/modelsStore.ts.
import { create } from 'zustand';
import type { LoadedModel, ModelInfo } from '@saurio/shared';
import { invoke, onEvent } from '../ipc/client.js';

// `models:list` puede tardar mientras el usuario agrega/quita un provider o llega `models:changed`.
// Una respuesta anterior no debe restaurar un inventario que el evento ya reemplazó.
let modelsRevision = 0;

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
    const revision = ++modelsRevision;
    set({ loading: true, error: undefined });
    const [installedResult, loadedResult] = await Promise.allSettled([
      invoke('models:list', { refresh: opts?.refresh }),
      invoke('models:loaded', undefined),
    ]);
    const installedError = installedResult.status === 'rejected' ? installedResult.reason : undefined;
    const loadedError = loadedResult.status === 'rejected' ? loadedResult.reason : undefined;
    const errorParts = [
      installedError ? `No se pudo actualizar el inventario de modelos: ${installedError instanceof Error ? installedError.message : String(installedError)}` : undefined,
      loadedError ? `No se pudo consultar qué modelos están cargados: ${loadedError instanceof Error ? loadedError.message : String(loadedError)}` : undefined,
    ].filter((message): message is string => message !== undefined);
    if (revision !== modelsRevision) return;
    set((state) => ({
      // Un fallo al preguntar qué está cargado en Ollama no invalida el catálogo que sí respondió
      // otro provider. Si la lectura de carga falla, se vacía para no pintar un dato obsoleto como vivo.
      installed: installedResult.status === 'fulfilled' ? installedResult.value : state.installed,
      loaded: loadedResult.status === 'fulfilled' ? loadedResult.value : [],
      loading: false,
      error: errorParts.length > 0 ? errorParts.join(' ') : undefined,
    }));
  },

  subscribe: () => {
    if (get().unsubscribe) {
      return;
    }
    const off = onEvent('models:changed', (payload) => {
      // El evento viene del host después de una mutación; siempre gana a cualquier refresh en vuelo.
      modelsRevision += 1;
      set({ installed: payload.installed, loaded: payload.loaded, loading: false, error: undefined });
    });
    set({ unsubscribe: off });
  },
}));
