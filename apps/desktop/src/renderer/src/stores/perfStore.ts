// perfStore: snapshot de rendimiento (doc 14 §4/§6, doc 04 §16 `metrics:snapshot`, evento
// `metrics:tick`) — apps/desktop/src/renderer/src/stores/perfStore.ts.
// `MetricsSnapshot` acá es el de packages/shared/src/domain.ts (contrato IPC real, `{ slots, queue,
// loaded, system, diagnostics }`); el doc 14 §4 propone un superconjunto (`packages/shared/src/
// telemetry.ts`, `MetricSample<T>` con `unit`) que no existe en el código de contratos ya instalado.
import { create } from 'zustand';
import type { MetricsSnapshot } from '@saurio/shared';
import { invoke, onEvent } from '../ipc/client.js';

/** Historial en memoria para los gráficos SVG simples del panel (doc 14 §9: "gráficos de línea de
 *  los últimos 10 minutos, ring buffer en memoria"); a 2 s por muestra, 300 puntos ~ 10 minutos. */
const HISTORY_LIMIT = 300;

export interface PerfHistoryPoint { t: number; cpuPct: number; ramUsedBytes: number; vramUsedBytes?: number; gpuUtilPct?: number }

export interface PerfStoreState {
  snapshot: MetricsSnapshot | undefined;
  history: PerfHistoryPoint[];
  panelOpen: boolean;
  loading: boolean;
  error: string | undefined;
  unsubscribe: (() => void) | undefined;

  refresh: () => Promise<void>;
  /** Avisa a main (canal `metrics:setPanelOpen`, v0.2) para que arranque/pare el muestreo continuo
   *  de `MetricsTicker` — antes esto solo tocaba estado local del renderer y `metrics:tick` nunca se
   *  emitía de verdad (doc 16 §"Panel de rendimiento v0.2... sigue siendo de solo lectura"). */
  setPanelOpen: (open: boolean) => void;
  subscribe: () => void;
}

function pushHistory(history: PerfHistoryPoint[], snapshot: MetricsSnapshot): PerfHistoryPoint[] {
  const point: PerfHistoryPoint = {
    t: snapshot.system.cpuPct.sampledAt,
    cpuPct: snapshot.system.cpuPct.value,
    ramUsedBytes: snapshot.system.ramUsedBytes.value,
    vramUsedBytes: snapshot.system.vramUsedBytes?.value,
    gpuUtilPct: snapshot.system.gpuUtilPct?.value,
  };
  const next = [...history, point];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

export const usePerfStore = create<PerfStoreState>((set, get) => ({
  snapshot: undefined,
  history: [],
  panelOpen: false,
  loading: false,
  error: undefined,
  unsubscribe: undefined,

  refresh: async () => {
    set({ loading: true, error: undefined });
    try {
      const snapshot = await invoke('metrics:snapshot', undefined);
      set((s) => ({ snapshot, history: pushHistory(s.history, snapshot), loading: false }));
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  setPanelOpen: (open) => {
    set({ panelOpen: open });
    invoke('metrics:setPanelOpen', { open }).catch((err: unknown) => {
      console.error('[perfStore] metrics:setPanelOpen falló', err);
    });
  },

  subscribe: () => {
    if (get().unsubscribe) {
      return;
    }
    const off = onEvent('metrics:tick', (snapshot) => set((s) => ({ snapshot, history: pushHistory(s.history, snapshot) })));
    set({ unsubscribe: off });
  },
}));
