// projectStore: proyectos abiertos/disponibles (doc 01 §4.1, doc 04 §16 `project:open`/`project:list`)
// — apps/desktop/src/renderer/src/stores/projectStore.ts.
import { create } from 'zustand';
import type { Project } from '@saurio/shared';
import { invoke } from '../ipc/client.js';

export interface ProjectStoreState {
  projects: Project[];
  currentProjectId: string | undefined;
  pinnedProjectIds: string[];
  loading: boolean;
  error: string | undefined;

  loadProjects: () => Promise<void>;
  openProject: (path?: string) => Promise<Project>;
  openPersonalProject: () => Promise<Project>;
  createManagedProject: (name: string) => Promise<Project>;
  /** Reabre explícitamente el último proyecto recordado: también reconstruye el runtime del host. */
  restoreLastProject: () => Promise<Project | undefined>;
  setCurrentProject: (projectId: string) => void;
  toggleProjectPinned: (projectId: string) => Promise<void>;
  renameProject: (projectId: string, name: string) => Promise<void>;
  relocateProject: (projectId: string) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
}

const LAST_PROJECT_SETTINGS_KEY = 'ui.projects.lastProjectId';
let projectSelectionRevision = 0;
const PINNED_PROJECTS_SETTINGS_KEY = 'ui.projects.pinnedIds';
export const PERSONAL_PROJECT_ID = 'project_personal';

function readPinnedIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && id !== PERSONAL_PROJECT_ID)
    : [];
}

function orderProjects(projects: Project[], pinnedProjectIds: string[]): Project[] {
  const pinned = new Set(pinnedProjectIds);
  return projects.slice().sort((a, b) => {
    const pinOrder = Number(pinned.has(b.id)) - Number(pinned.has(a.id));
    return pinOrder || b.lastOpenedAt - a.lastOpenedAt;
  });
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  projects: [],
  currentProjectId: undefined,
  pinnedProjectIds: [],
  loading: false,
  error: undefined,

  loadProjects: async () => {
    set({ loading: true, error: undefined });
    try {
      const [projects, pinnedValue] = await Promise.all([
        invoke('project:list', undefined),
        invoke('settings:get', { key: PINNED_PROJECTS_SETTINGS_KEY }).catch(() => undefined),
      ]);
      const pinnedProjectIds = readPinnedIds(pinnedValue);
      const personal = get().projects.find((item) => item.id === PERSONAL_PROJECT_ID);
      const normalProjects = projects.filter((item) => item.id !== PERSONAL_PROJECT_ID);
      const visible = personal && get().currentProjectId === personal.id ? [...normalProjects, personal] : normalProjects;
      set({ projects: orderProjects(visible, pinnedProjectIds), pinnedProjectIds, loading: false });
      // Cargar recientes no abre una raíz en RuntimeHost. `currentProjectId` representa solamente
      // un `project:open` exitoso, nunca el primer elemento visual de la lista.
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  openPersonalProject: async () => {
    projectSelectionRevision += 1;
    const project = await invoke('project:personal', undefined);
    set((state) => ({ currentProjectId: project.id, error: undefined,
      projects: [project, ...state.projects.filter((item) => item.id !== project.id)] }));
    await invoke('settings:set', { key: LAST_PROJECT_SETTINGS_KEY, value: project.id });
    return project;
  },

  openProject: async (path) => {
    projectSelectionRevision += 1;
    set({ loading: true, error: undefined });
    try {
      const project = await invoke('project:open', { path });
      set((state) => ({
        loading: false,
        currentProjectId: project.id,
        projects: orderProjects(state.projects
          .filter((p) => p.id !== PERSONAL_PROJECT_ID && p.id !== project.id)
          .concat(project), state.pinnedProjectIds),
      }));
      await invoke('settings:set', { key: LAST_PROJECT_SETTINGS_KEY, value: project.id });
      return project;
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  createManagedProject: async (name) => {
    projectSelectionRevision += 1;
    set({ loading: true, error: undefined });
    try {
      const project = await invoke('project:createManaged', { name });
      set((state) => ({
        loading: false,
        currentProjectId: project.id,
        projects: orderProjects([...state.projects.filter((item) => item.id !== PERSONAL_PROJECT_ID), project], state.pinnedProjectIds),
      }));
      await invoke('settings:set', { key: LAST_PROJECT_SETTINGS_KEY, value: project.id });
      return project;
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  restoreLastProject: async () => {
    await get().loadProjects();
    const lastProjectId = await invoke('settings:get', { key: LAST_PROJECT_SETTINGS_KEY }).catch(() => undefined);
    if (lastProjectId === PERSONAL_PROJECT_ID) return get().openPersonalProject();
    const project = typeof lastProjectId === 'string'
      ? get().projects.find((item) => item.id === lastProjectId)
      : undefined;
    return project ? get().openProject(project.path) : undefined;
  },

  setCurrentProject: (projectId) => {
    projectSelectionRevision += 1;
    set({ currentProjectId: projectId });
    void invoke('settings:set', { key: LAST_PROJECT_SETTINGS_KEY, value: projectId });
  },

  toggleProjectPinned: async (projectId) => {
    if (projectId === PERSONAL_PROJECT_ID) throw new Error('El espacio Personal no se puede pinear.');
    const current = get().pinnedProjectIds;
    const pinnedProjectIds = current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : [...current, projectId];
    await invoke('settings:set', { key: PINNED_PROJECTS_SETTINGS_KEY, value: pinnedProjectIds });
    set((state) => ({ pinnedProjectIds, projects: orderProjects(state.projects, pinnedProjectIds) }));
  },

  renameProject: async (projectId, name) => {
    if (projectId === PERSONAL_PROJECT_ID) throw new Error('El espacio Personal no se puede renombrar.');
    const updated = await invoke('project:rename', { id: projectId, name });
    set((state) => ({ projects: state.projects.map((project) => project.id === projectId ? updated : project) }));
  },

  relocateProject: async (projectId) => {
    const revision = ++projectSelectionRevision;
    const updated = await invoke('project:relocate', { id: projectId });
    if (!updated) return;
    set((state) => ({
      currentProjectId: revision === projectSelectionRevision && state.currentProjectId === projectId ? undefined : state.currentProjectId,
      projects: state.projects.map((project) => project.id === projectId ? updated : project),
    }));
    if (revision === projectSelectionRevision) await get().openProject(updated.path);
  },

  removeProject: async (projectId) => {
    projectSelectionRevision += 1;
    if (projectId === PERSONAL_PROJECT_ID) throw new Error('El espacio Personal no se puede quitar.');
    await invoke('project:remove', { id: projectId });
    set((state) => ({
      projects: state.projects.filter((project) => project.id !== projectId),
      pinnedProjectIds: state.pinnedProjectIds.filter((id) => id !== projectId),
      currentProjectId: state.currentProjectId === projectId ? undefined : state.currentProjectId,
    }));
    const pinnedProjectIds = get().pinnedProjectIds;
    await invoke('settings:set', { key: PINNED_PROJECTS_SETTINGS_KEY, value: pinnedProjectIds });
  },
}));
