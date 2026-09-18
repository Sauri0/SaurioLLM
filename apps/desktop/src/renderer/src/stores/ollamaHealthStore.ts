// Estado compartido de "¿Ollama responde?" — apps/desktop/src/renderer/src/stores/ollamaHealthStore.ts.
//
// Tarea "ModelSelect: estados explícitos" (punto 2): antes cada componente que necesitaba saber si
// Ollama estaba corriendo (`layout/StatusBar.tsx`) armaba su propio poll de `provider:health` cada
// 8s con `useState` local. Ahora que `ModelSelect` (Sidebar/ChatHeader) también necesita el mismo
// dato para decidir entre "Iniciando motor local…"/"Ollama no está corriendo → Iniciar"/el `<select>`
// normal, un poll por instancia montada sería redundante (dos o tres pedidos idénticos a
// `provider:health` al mismo tiempo). Este store centraliza un ÚNICO poll (arranca con el primer
// `subscribe()`, nunca se duplica) que cualquier componente puede leer con `useOllamaHealthStore`.
//
// `layout/StatusBar.tsx` sigue con su propio poll local (no se tocó para no arriesgar una regresión
// fuera del alcance de esta tarea puntual) — duplicación menor y conocida, documentada en la salida
// estructurada de la tarea.
import { create } from 'zustand';
import { invoke } from '../ipc/client.js';
import { isDemoMode } from '../demo/demoState.js';

const HEALTH_POLL_MS = 8000;

interface OllamaHealthState {
  /** `null` = todavía no se pidió `provider:health` ni una vez. */
  ok: boolean | null;
  starting: boolean;
  startError: string | undefined;
  subscribe: () => () => void;
  start: () => Promise<void>;
}

let pollHandle: ReturnType<typeof setInterval> | undefined;
let subscriberCount = 0;

function checkHealthOnce(set: (patch: Partial<OllamaHealthState>) => void): void {
  invoke('provider:health', undefined)
    .then((health) => set({ ok: health.every((h) => h.ok) }))
    .catch(() => set({ ok: false }));
}

export const useOllamaHealthStore = create<OllamaHealthState>((set, get) => ({
  ok: null,
  starting: false,
  startError: undefined,
  /** Arranca el poll único la primera vez que alguien se suscribe; lo para cuando el último
   *  componente se desmonta. Devuelve la función de limpieza (para `useEffect`). */
  subscribe: () => {
    if (isDemoMode()) {
      set({ ok: true }); // mismo criterio que StatusBar.tsx en modo demo: sin runtime real detrás.
      return () => {};
    }
    subscriberCount += 1;
    if (pollHandle === undefined) {
      checkHealthOnce(set);
      pollHandle = setInterval(() => checkHealthOnce(set), HEALTH_POLL_MS);
    }
    return () => {
      subscriberCount -= 1;
      if (subscriberCount <= 0 && pollHandle !== undefined) {
        clearInterval(pollHandle);
        pollHandle = undefined;
      }
    };
  },
  start: async () => {
    set({ starting: true, startError: undefined });
    try {
      const result = await invoke('ollama:ensureRunning', undefined);
      if (result.running) {
        set({ ok: true });
      } else {
        set({
          startError: result.error === 'ollama_not_installed'
            ? 'Ollama no está instalado en este equipo.'
            : 'Ollama no respondió a tiempo. Probá de nuevo en unos segundos.',
        });
      }
    } catch (err) {
      set({ startError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ starting: false });
      // resultado final real (no confiar en `result.running` solo): mismo criterio que
      // `checkHealthOnce`, así el resto de la UI (badges LOCAL, ModelSelect) ve el mismo valor
      // que la barra de estado apenas termina de intentar arrancarlo.
      if (!get().starting) checkHealthOnce(set);
    }
  },
}));
