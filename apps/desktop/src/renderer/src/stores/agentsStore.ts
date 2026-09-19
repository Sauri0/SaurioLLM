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
const FAVORITE_AGENTS_SETTINGS_KEY = 'ui.agents.favoriteIds';
let loadRevision = 0;

function readFavoriteIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : [];
}

function scopeKey(options: { projectId?: string; includeArchived?: boolean }): string {
  return `${options.projectId ?? ''}:${options.includeArchived ? 'with-archived' : 'active-only'}`;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export interface AgentsStoreState {
  personalAgents: AgentProfile[];
  loading: boolean;
  error: string | undefined;
  busyId: string | undefined;
  favoriteAgentIds: string[];
  /** Alcance de la carga vigente: evita mostrar perfiles de otro proyecto mientras se actualiza. */
  activeScopeKey: string | undefined;
  /** No escribe favoritos hasta recuperar con éxito la preferencia que falló al leerse. */
  favoriteIdsReadFailed: boolean;

  load: (options?: { projectId?: string; includeArchived?: boolean }) => Promise<void>;
  create: (input: CreateInput) => Promise<AgentProfile>;
  update: (id: string, patch: UpdatePatch) => Promise<AgentProfile>;
  archive: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  duplicate: (id: string, name?: string) => Promise<AgentProfile>;
  toggleFavorite: (id: string) => Promise<void>;
}

export const useAgentsStore = create<AgentsStoreState>((set, get) => ({
  personalAgents: [],
  loading: false,
  error: undefined,
  busyId: undefined,
  favoriteAgentIds: [],
  activeScopeKey: undefined,
  favoriteIdsReadFailed: false,

  load: async (options = {}) => {
    const requestRevision = ++loadRevision;
    const nextScopeKey = scopeKey(options);
    const scopeChanged = get().activeScopeKey !== nextScopeKey;
    set({
      loading: true,
      error: undefined,
      ...(scopeChanged ? { personalAgents: [], activeScopeKey: nextScopeKey } : {}),
    });
    const [agentsResult, favoritesResult] = await Promise.allSettled([
      invoke('agents:list', options),
      invoke('settings:get', { key: FAVORITE_AGENTS_SETTINGS_KEY }),
    ]);
    // Una respuesta de A después de B no puede reponer su lista, sus favoritos ni su error.
    if (requestRevision !== loadRevision) return;

    const favoriteReadFailed = favoritesResult.status === 'rejected';
    if (agentsResult.status === 'rejected') {
      set({
        loading: false,
        favoriteIdsReadFailed: favoriteReadFailed,
        error: errorMessage(agentsResult.reason),
      });
      return;
    }

    set((state) => ({
      personalAgents: agentsResult.value,
      // No descartamos favoritos fuera del filtro actual. Si settings falla, se conserva el
      // último valor confirmado y se bloquea una escritura que podría pisar la preferencia real.
      favoriteAgentIds: favoriteReadFailed ? state.favoriteAgentIds : readFavoriteIds(favoritesResult.value),
      favoriteIdsReadFailed: favoriteReadFailed,
      loading: false,
      error: favoriteReadFailed ? `No se pudieron cargar los favoritos: ${errorMessage(favoritesResult.reason)}` : undefined,
    }));
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

  restore: async (id) => {
    set({ busyId: id, error: undefined });
    try {
      await invoke('agents:restore', { id });
      set((state) => ({
        busyId: undefined,
        personalAgents: state.personalAgents.map((agent) => agent.id === id ? { ...agent, archivedAt: undefined } : agent),
      }));
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

  toggleFavorite: async (id) => {
    if (get().favoriteIdsReadFailed) {
      const message = 'No se pudieron cargar los favoritos. Reintentá cargar la lista antes de modificarlos.';
      set({ error: message });
      throw new Error(message);
    }
    const current = get().favoriteAgentIds;
    const favoriteAgentIds = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    set({ error: undefined });
    try {
      await invoke('settings:set', { key: FAVORITE_AGENTS_SETTINGS_KEY, value: favoriteAgentIds });
      set({ favoriteAgentIds });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
}));
