// Test de personalProject — packages/runtime/src/agent/personalProject.test.ts.
// Doc 19 §0: proyecto sintético fijo, creado una sola vez, idempotente entre arranques.
import { describe, expect, it } from 'vitest';
import { ensurePersonalProject, isPersonalProject, PERSONAL_PROJECT_ID } from './personalProject.js';
import type { ProjectRepository } from '../persistence/types.js';
import type { Project } from '@saurio/shared';

function fakeProjectRepository(): ProjectRepository {
  const store = new Map<string, Project>();
  return {
    async create(project) { store.set(project.id, project); return project; },
    async get(id) { return store.get(id); },
    async list() { return [...store.values()]; },
    async touchLastOpened() {},
    async listRecent() { return [...store.values()].map((project) => ({ project, chatCount: 0 })); },
    async setRemovedFromRecents() {},
    async rename(id, name) {
      const current = store.get(id);
      if (!current) throw new Error('proyecto inexistente');
      const updated = { ...current, name };
      store.set(id, updated);
      return updated;
    },
  };
}

describe('ensurePersonalProject', () => {
  it('crea el proyecto personal si no existe', async () => {
    const repo = fakeProjectRepository();
    const project = await ensurePersonalProject(repo, () => 1000);
    expect(project.id).toBe(PERSONAL_PROJECT_ID);
    expect(project.name).toBe('Personal');
  });

  it('es idempotente: una segunda llamada devuelve la misma fila sin recrearla', async () => {
    const repo = fakeProjectRepository();
    const first = await ensurePersonalProject(repo, () => 1000);
    const second = await ensurePersonalProject(repo, () => 2000);
    expect(second).toEqual(first);
  });

  it('isPersonalProject identifica el id fijo', () => {
    expect(isPersonalProject(PERSONAL_PROJECT_ID)).toBe(true);
    expect(isPersonalProject('otro-proyecto')).toBe(false);
  });
});
