// Test de AgentRepository — packages/runtime/src/persistence/repositories/agent.test.ts.
// Cubre doc 19 §1.8 T03 ("identidades propias": dos `saurio.db` en directorios distintos, crear un
// agente en una, `agents:list`/`listProfiles` en la otra devuelve solo lo que le corresponde) y el
// CRUD de perfiles de E2a (§1.5): createProfile/listProfiles/updateProfile/archive/duplicate, más el
// filtro por defecto que nunca expone `owner_kind: 'worker'|'coordinator'` en la vitrina de "Mis
// agentes" (doc 19 §0).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDriver, type SqliteDriver } from '../driver.js';
import { runMigrations } from '../migrations/index.js';
import { createAgentRepository } from './agent.js';
import { createAgentMemoryRepository } from './agentMemory.js';
import type { AgentCreateInput } from '@saurio/shared';

function openTestDb(): { driver: SqliteDriver; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'saurio-agent-test-'));
  const driver = openDriver(path.join(dir, 'saurio.db'));
  runMigrations(driver);
  return { driver, dir };
}

function inputFor(name: string, overrides: Partial<AgentCreateInput> = {}): AgentCreateInput {
  return { name, role: 'custom', modelMode: 'fixed', permissionPreset: 'balanced', memoryScope: 'global', ...overrides };
}

describe('AgentRepository — perfiles (doc 19 §1.5)', () => {
  let driver: SqliteDriver;
  let dir: string;

  beforeEach(() => {
    ({ driver, dir } = openTestDb());
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('createProfile crea un agente personal con owner_kind personal y defaults sensatos', async () => {
    const repo = createAgentRepository(driver);
    const profile = await repo.createProfile(inputFor('Revisor'));
    expect(profile.ownerKind).toBe('personal');
    expect(profile.name).toBe('Revisor');
    expect(profile.modelMode).toBe('fixed');
    expect(profile.permissionPreset).toBe('balanced');
    expect(profile.memoryScope).toBe('global');
    expect(profile.allowedTools).not.toContain('delegate');
    expect(profile.archivedAt).toBeUndefined();
  });

  it('rechaza crear memoria de proyecto sin un proyecto asociado', async () => {
    const repo = createAgentRepository(driver);
    await expect(repo.createProfile(inputFor('Incompleto', { memoryScope: 'project', projectId: undefined })))
      .rejects.toThrow(/proyecto asociado/);
  });

  it('listProfiles sin filtro devuelve solo personal, nunca worker/coordinator', async () => {
    const repo = createAgentRepository(driver);
    await repo.createProfile(inputFor('Personal 1'));
    await repo.createProfile(inputFor('Worker efímero'), 'worker');
    await repo.createProfile(inputFor('Coordinador'), 'coordinator');

    const visible = await repo.listProfiles();
    expect(visible).toHaveLength(1);
    expect(visible[0]!.name).toBe('Personal 1');
  });

  it('listProfiles con ownerKind explícito puede ver workers (uso interno de E3a)', async () => {
    const repo = createAgentRepository(driver);
    await repo.createProfile(inputFor('Worker efímero'), 'worker');
    const workers = await repo.listProfiles({ ownerKind: ['worker'] });
    expect(workers).toHaveLength(1);
  });

  it('archive marca archived_at y listProfiles lo excluye salvo includeArchived', async () => {
    const repo = createAgentRepository(driver);
    const created = await repo.createProfile(inputFor('A archivar'));
    await repo.archive(created.id);

    expect(await repo.listProfiles()).toHaveLength(0);
    const withArchived = await repo.listProfiles({ includeArchived: true });
    expect(withArchived).toHaveLength(1);
    expect(withArchived[0]!.archivedAt).toBeDefined();
    await repo.restore(created.id);
    expect((await repo.listProfiles()).map((profile) => profile.id)).toEqual([created.id]);
    expect((await repo.getProfile(created.id))?.archivedAt).toBeUndefined();
  });

  it('duplicate copia el agente con un id nuevo y nombre distinto', async () => {
    const repo = createAgentRepository(driver);
    const original = await repo.createProfile(inputFor('Original', { description: 'desc' }));
    const copy = await repo.duplicate(original.id);
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe('Original (copia)');
    expect(copy.description).toBe('desc');
    expect(await repo.listProfiles()).toHaveLength(2);
  });

  it('updateProfile aplica un patch parcial sin tocar el resto', async () => {
    const repo = createAgentRepository(driver);
    const created = await repo.createProfile(inputFor('Editable'));
    const updated = await repo.updateProfile(created.id, { description: 'nueva descripción' });
    expect(updated.description).toBe('nueva descripción');
    expect(updated.name).toBe('Editable');
  });

  it('permite borrar instrucciones explícitamente sin restaurar el valor anterior', async () => {
    const repo = createAgentRepository(driver);
    const created = await repo.createProfile(inputFor('Sin instrucciones', { systemPrompt: 'instrucción inicial' }));
    const updated = await repo.updateProfile(created.id, { systemPrompt: '' });
    expect(updated.systemPrompt).toBe('');
  });

  it('conserva el alcance de memoria del proyecto al listar, editar y duplicar', async () => {
    const repo = createAgentRepository(driver);
    const now = Date.now();
    driver.prepare('INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)')
      .run('project-memoria', 'N:/memoria', 'Memoria', now);

    const created = await repo.createProfile(inputFor('Del proyecto', {
      memoryScope: 'project', projectId: 'project-memoria',
    }));
    expect(created).toMatchObject({ memoryScope: 'project', projectId: 'project-memoria' });
    expect((await repo.listProfiles()).find((profile) => profile.id === created.id)).toMatchObject({
      memoryScope: 'project', projectId: 'project-memoria',
    });

    const updated = await repo.updateProfile(created.id, { description: 'sin cambiar el alcance' });
    expect(updated).toMatchObject({ memoryScope: 'project', projectId: 'project-memoria' });

    const reopened = await createAgentRepository(driver).getProfile(created.id);
    expect(reopened).toMatchObject({ memoryScope: 'project', projectId: 'project-memoria' });
    const copy = await repo.duplicate(created.id);
    expect(copy).toMatchObject({ memoryScope: 'project', projectId: 'project-memoria' });
  });

  it('cambiar alcance del perfil no convierte memorias privadas en globales', async () => {
    const repo = createAgentRepository(driver);
    const memories = createAgentMemoryRepository(driver);
    driver.prepare('INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)')
      .run('project-scope', '/scope', 'Scope', Date.now());
    const agent = await repo.createProfile(inputFor('Cambio de alcance', { memoryScope: 'project', projectId: 'project-scope' }));
    const memory = await memories.upsert({ agentId: agent.id, projectId: 'project-scope', content: 'Sólo proyecto' });
    const global = await repo.updateProfile(agent.id, { memoryScope: 'global' });
    expect(global.memoryScope).toBe('global');
    expect(global.projectId).toBeUndefined();
    expect(await memories.list(agent.id)).toEqual([]);
    expect((await memories.get(memory.id))?.projectId).toBe('project-scope');
    await expect(repo.updateProfile(agent.id, { memoryScope: 'project' })).rejects.toThrow('proyecto asociado');
    expect(await repo.updateProfile(agent.id, { memoryScope: 'project', projectId: 'project-scope' }))
      .toMatchObject({ memoryScope: 'project', projectId: 'project-scope' });
  });

  it('trata una política histórica ausente como desconocida y la conserva al editar', async () => {
    const repo = createAgentRepository(driver);
    const created = await repo.createProfile(inputFor('Histórico'));
    driver.prepare('UPDATE agents SET memory_policy_json = NULL, project_id = NULL WHERE id = ?').run(created.id);

    const legacy = await repo.getProfile(created.id);
    expect(legacy?.memoryScope).toBeUndefined();
    expect((await repo.listProfiles()).find((profile) => profile.id === created.id)?.memoryScope).toBeUndefined();
    const updated = await repo.updateProfile(created.id, { description: 'actualización segura' });
    expect(updated.memoryScope).toBeUndefined();
    expect(driver.prepare<{ memory_policy_json: string | null }>('SELECT memory_policy_json FROM agents WHERE id = ?')
      .get(created.id)?.memory_policy_json).toBeNull();
  });
});

describe('AgentRepository — T03 identidades propias (doc 19 §1.8)', () => {
  it('un agente creado en una instalación no aparece en otra instalación distinta', async () => {
    const a = openTestDb();
    const b = openTestDb();
    try {
      const repoA = createAgentRepository(a.driver);
      const repoB = createAgentRepository(b.driver);

      await repoA.createProfile(inputFor('Solo en A'));

      expect(await repoA.listProfiles()).toHaveLength(1);
      expect(await repoB.listProfiles()).toHaveLength(0);
    } finally {
      a.driver.close();
      b.driver.close();
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });
});
