// terminalStore: sesiones de terminal por proyecto (doc 01 §4.10, doc 04 §16
// `terminal:create/resize/close`) — apps/desktop/src/renderer/src/stores/terminalStore.ts.
// Solo el ciclo de vida IPC de la sesión (crear/redimensionar/cerrar) vive acá, como le corresponde
// a este módulo (renderer-core); el streaming de datos por `MessagePort` y el montaje de
// `@xterm/xterm` son responsabilidad de `features/terminal` (fuera de los directorios de esta
// tarea) — ver deviations.
import { create } from 'zustand';
import { invoke } from '../ipc/client.js';

export interface TerminalSession {
  terminalId: string;
  projectId: string;
  cols: number;
  rows: number;
}

export interface TerminalStoreState {
  sessionsByProject: Record<string, TerminalSession[]>;
  error: string | undefined;

  create: (projectId: string, shell?: string) => Promise<string>;
  resize: (terminalId: string, projectId: string, cols: number, rows: number) => Promise<void>;
  close: (terminalId: string, projectId: string) => Promise<void>;
}

export const useTerminalStore = create<TerminalStoreState>((set) => ({
  sessionsByProject: {},
  error: undefined,

  create: async (projectId, shell) => {
    try {
      const { terminalId } = await invoke('terminal:create', { projectId, shell });
      const session: TerminalSession = { terminalId, projectId, cols: 80, rows: 24 };
      set((state) => ({
        sessionsByProject: {
          ...state.sessionsByProject,
          [projectId]: [...(state.sessionsByProject[projectId] ?? []), session],
        },
      }));
      return terminalId;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  resize: async (terminalId, projectId, cols, rows) => {
    await invoke('terminal:resize', { terminalId, cols, rows });
    set((state) => ({
      sessionsByProject: {
        ...state.sessionsByProject,
        [projectId]: (state.sessionsByProject[projectId] ?? []).map((s) =>
          s.terminalId === terminalId ? { ...s, cols, rows } : s,
        ),
      },
    }));
  },

  close: async (terminalId, projectId) => {
    await invoke('terminal:close', { terminalId });
    set((state) => ({
      sessionsByProject: {
        ...state.sessionsByProject,
        [projectId]: (state.sessionsByProject[projectId] ?? []).filter((s) => s.terminalId !== terminalId),
      },
    }));
  },
}));
