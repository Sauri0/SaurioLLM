// agentsStore: agentes personales del usuario ("Mis agentes", doc 19 §1.6) —
// apps/desktop/src/renderer/src/stores/agentsStore.ts. Mismo patrón que providersStore.ts: un único
// store para la pestaña "Agentes" del panel derecho y para cualquier otro lugar que necesite listar
// agentes personales (Sidebar, ChatHeader). `agents:list` sin filtro ya excluye 'worker'/'coordinator'
// del lado del handler (doc 19 §0) — este store nunca pide `includeArchived` salvo que se lo pidan.
import { create } from 'zustand';
import type { AgentProfile, IpcInput } from '@saurio/shared';
import { invoke } from '../ipc/client.js';

type CreateInput = IpcInput<'agents:create'>;
type UpdatePatch = IpcInput<'agents:update'>['patch'];

export interface AgentsStoreState {
  personalAgents: AgentProfile[];
  loading: boolean;
  error: string | undefined;
  busyId: string | undefined;

  load: () => Promise<void>;
  create: (input: CreateInput) => Promise<AgentProfile>;
  update: (id: string, patch: UpdatePatch) => Promise<AgentProfile>;
  archive: (id: string) => Promise<void>;
  duplicate: (id: string, name?: string) => Promise<AgentProfile>;
}

export const useAgentsStore = create<AgentsStoreState>((set) => ({
  personalAgents: [],
  loading: false,
  error: undefined,
  busyId: undefined,

  load: async () => {
    set({ loading: true, error: undefined });
    try {
      const personalAgents = await invoke('agents:list', {});
      set({ personalAgents, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  create: async (input) => {
    set({ error: undefined });
    try {
      const created = await invoke('agents:create', input);
      set((state) => ({ personalAgents: [created, ...state.personalAgents] }));
      return created;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  update: async (id, patch) => {
    set({ busyId: id, error: undefined });
    try {
      const updated = await invoke('agents:update', { id, patch });
      set((state) => ({
        busyId: undefined,
        personalAgents: state.personalAgents.map((a) => (a.id === updated.id ? updated : a)),
      }));
      return updated;
    } catch (err) {
      set({ busyId: undefined, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  archive: async (id) => {
    set({ busyId: id, error: undefined });
    try {
      await invoke('agents:archive', { id });
      set((state) => ({ busyId: undefined, personalAgents: state.personalAgents.filter((a) => a.id !== id) }));
    } catch (err) {
      set({ busyId: undefined, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  duplicate: async (id, name) => {
    set({ busyId: id, error: undefined });
    try {
      const created = await invoke('agents:duplicate', { id, name });
      set((state) => ({ busyId: undefined, personalAgents: [created, ...state.personalAgents] }));
      return created;
    } catch (err) {
      set({ busyId: undefined, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
}));
