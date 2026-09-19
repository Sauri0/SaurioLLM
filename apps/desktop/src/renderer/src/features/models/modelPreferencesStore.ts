import type { Locality, ModelRef } from '@saurio/shared';
import { create } from 'zustand';
import { invoke } from '../../ipc/client.js';

export const MODEL_FAVORITES_KEY = 'ui.models.favorites';
export const MODEL_RECENTS_KEY = 'ui.models.recents';
export const MODEL_HIDDEN_KEY = 'ui.models.hidden';
const MAX_RECENTS = 12;

// Las escrituras de ocultos se ordenan para que dos clics rápidos no dejen settings con un valor
// viejo. El contador además impide que un error de una escritura anterior revierta la intención
// más reciente que ya está visible en el selector.
let hiddenWriteTail: Promise<void> = Promise.resolve();
let hiddenWriteRevision = 0;

function isModelRef(value: unknown): value is ModelRef {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.providerId === 'string' && candidate.providerId.length > 0
    && typeof candidate.name === 'string' && candidate.name.length > 0
    && ['local', 'lan', 'cloud', 'proxied-cloud'].includes(String(candidate.locality));
}

export function parseModelRefs(value: unknown): ModelRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!isModelRef(entry)) return [];
    const ref: ModelRef = {
      providerId: entry.providerId,
      name: entry.name,
      locality: entry.locality as Locality,
    };
    const key = `${ref.providerId}::${ref.name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [ref];
  });
}

function refKey(ref: ModelRef): string { return `${ref.providerId}::${ref.name}`; }

interface ModelPreferencesState {
  favorites: ModelRef[];
  recents: ModelRef[];
  hidden: ModelRef[];
  /** Último valor de ocultos confirmado por settings; se usa únicamente para rollback. */
  persistedHidden: ModelRef[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  toggleFavorite: (ref: ModelRef) => Promise<void>;
  rememberRecent: (ref: ModelRef) => Promise<void>;
  toggleHidden: (ref: ModelRef) => Promise<void>;
}

export const useModelPreferencesStore = create<ModelPreferencesState>((set, get) => ({
  favorites: [], recents: [], hidden: [], persistedHidden: [], loaded: false, loading: false, error: null,
  async load() {
    if (get().loaded || get().loading) return;
    set({ loading: true, error: null });
    try {
      const [favorites, recents, hidden] = await Promise.all([
        invoke('settings:get', { key: MODEL_FAVORITES_KEY }),
        invoke('settings:get', { key: MODEL_RECENTS_KEY }),
        invoke('settings:get', { key: MODEL_HIDDEN_KEY }),
      ]);
      const parsedHidden = parseModelRefs(hidden);
      set({ favorites: parseModelRefs(favorites), recents: parseModelRefs(recents), hidden: parsedHidden, persistedHidden: parsedHidden, loaded: true, loading: false });
    } catch (error) {
      set({ loaded: true, loading: false, error: `No se pudieron cargar las preferencias de modelos: ${error instanceof Error ? error.message : String(error)}` });
    }
  },
  async toggleFavorite(ref) {
    const previous = get().favorites;
    const key = refKey(ref);
    const next = previous.some((item) => refKey(item) === key)
      ? previous.filter((item) => refKey(item) !== key)
      : [...previous, ref];
    set({ favorites: next, error: null });
    try {
      await invoke('settings:set', { key: MODEL_FAVORITES_KEY, value: next });
    } catch (error) {
      set({ favorites: previous, error: `No se pudo guardar favoritos: ${error instanceof Error ? error.message : String(error)}` });
    }
  },
  async rememberRecent(ref) {
    const previous = get().recents;
    const next = [ref, ...previous.filter((item) => refKey(item) !== refKey(ref))].slice(0, MAX_RECENTS);
    set({ recents: next, error: null });
    try {
      await invoke('settings:set', { key: MODEL_RECENTS_KEY, value: next });
    } catch (error) {
      set({ recents: previous, error: `No se pudo guardar recientes: ${error instanceof Error ? error.message : String(error)}` });
    }
  },
  async toggleHidden(ref) {
    const previous = get().hidden;
    const key = refKey(ref);
    const next = previous.some((item) => refKey(item) === key)
      ? previous.filter((item) => refKey(item) !== key)
      : [...previous, ref];
    const revision = ++hiddenWriteRevision;
    set({ hidden: next, error: null });

    const write = hiddenWriteTail.then(() => invoke('settings:set', { key: MODEL_HIDDEN_KEY, value: next }));
    hiddenWriteTail = write.then(() => undefined, () => undefined);
    try {
      await write;
      set({ persistedHidden: next });
    } catch (error) {
      // Una respuesta tardía no puede deshacer un clic posterior. La siguiente escritura en cola
      // persiste esa intención más nueva una vez que ésta termina, aun si esta falló.
      if (revision === hiddenWriteRevision) {
        set({ hidden: get().persistedHidden, error: `No se pudo guardar los modelos ocultos: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  },
}));

export function modelRefIdentity(ref: Pick<ModelRef, 'providerId' | 'name'>): string {
  return `${ref.providerId}::${ref.name}`;
}
