// projectStore: proyectos abiertos/disponibles (doc 01 §4.1, doc 04 §16 `project:open`/`project:list`)
// — apps/desktop/src/renderer/src/stores/projectStore.ts.
import { create } from 'zustand';
import type { Project } from '@saurio/shared';
import { invoke } from '../ipc/client.js';

export interface ProjectStoreState {
  projects: Project[];
  currentProjectId: string | undefined;
  loading: boolean;
  error: string | undefined;

  loadProjects: () => Promise<void>;
  openProject: (path?: string) => Promise<Project>;
  setCurrentProject: (projectId: string) => void;
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  projects: [],
  currentProjectId: undefined,
  loading: false,
  error: undefined,

  loadProjects: async () => {
    set({ loading: true, error: undefined });
    try {
      const projects = await invoke('project:list', undefined);
      set({ projects, loading: false });
      if (!get().currentProjectId && projects.length > 0) {
        set({ currentProjectId: projects[0]?.id });
      }
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  openProject: async (path) => {
    set({ loading: true, error: undefined });
    try {
      const project = await invoke('project:open', { path });
      set((state) => ({
        loading: false,
        currentProjectId: project.id,
        projects: state.projects.some((p) => p.id === project.id)
          ? state.projects.map((p) => (p.id === project.id ? project : p))
          : [...state.projects, project],
      }));
      return project;
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  setCurrentProject: (projectId) => set({ currentProjectId: projectId }),
}));
