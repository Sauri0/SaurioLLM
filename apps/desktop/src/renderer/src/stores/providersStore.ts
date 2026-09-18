// providersStore: providers configurados (Ollama/OpenAI/OpenRouter/Anthropic/personalizado) — punto 3
// del encargo, doc 04 §16 `providers:list/add/update/remove/test` —
// apps/desktop/src/renderer/src/stores/providersStore.ts. Único store para Ajustes > Proveedores Y
// para el selector de modelo (ChatHeader/Sidebar necesitan el `label`/`preset` de cada provider para
// agrupar y mostrar el badge LOCAL/LAN/NUBE junto al nombre real, no solo el id crudo).
import { create } from 'zustand';
import type { IpcInput, ProviderConfig, ProviderTestResult } from '@saurio/shared';
import { invoke } from '../ipc/client.js';

type AddInput = IpcInput<'providers:add'>;
type UpdateInput = IpcInput<'providers:update'>;

export interface ProvidersStoreState {
  providers: ProviderConfig[];
  loading: boolean;
  error: string | undefined;
  /** id del provider con una operación en curso (test/borrado/guardado) — para deshabilitar sus
   *  propios controles sin bloquear el resto de la lista. */
  busyId: string | undefined;
  lastTestResult: Record<string, ProviderTestResult>;

  load: () => Promise<void>;
  add: (input: AddInput) => Promise<ProviderConfig>;
  update: (input: UpdateInput) => Promise<ProviderConfig>;
  remove: (id: string) => Promise<void>;
  test: (id: string) => Promise<ProviderTestResult>;
}

export const useProvidersStore = create<ProvidersStoreState>((set, get) => ({
  providers: [],
  loading: false,
  error: undefined,
  busyId: undefined,
  lastTestResult: {},

  load: async () => {
    set({ loading: true, error: undefined });
    try {
      const providers = await invoke('providers:list', undefined);
      set({ providers, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  add: async (input) => {
    set({ error: undefined });
    try {
      const created = await invoke('providers:add', input);
      set((state) => ({ providers: [...state.providers, created] }));
      return created;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  update: async (input) => {
    set({ busyId: input.id, error: undefined });
    try {
      const updated = await invoke('providers:update', input);
      set((state) => ({
        busyId: undefined,
        providers: state.providers.map((p) => (p.id === updated.id ? updated : p)),
      }));
      return updated;
    } catch (err) {
      set({ busyId: undefined, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  remove: async (id) => {
    set({ busyId: id, error: undefined });
    try {
      await invoke('providers:remove', { id });
      set((state) => ({ busyId: undefined, providers: state.providers.filter((p) => p.id !== id) }));
    } catch (err) {
      set({ busyId: undefined, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  test: async (id) => {
    set({ busyId: id, error: undefined });
    try {
      const result = await invoke('providers:test', { id });
      set((state) => ({ busyId: undefined, lastTestResult: { ...state.lastTestResult, [id]: result } }));
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        busyId: undefined,
        lastTestResult: { ...state.lastTestResult, [id]: { providerId: id, ok: false, error: message } },
      }));
      return get().lastTestResult[id]!;
    }
  },
}));
