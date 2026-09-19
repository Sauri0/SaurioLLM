// Test de AgentMemoryRepository — packages/runtime/src/persistence/repositories/agentMemory.test.ts.
// Cubre doc 19 §1.8 T09 ("contexto privado"): `list(agentId, 'proj-B')` con una fila `project_id:
// 'proj-A'` nunca la devuelve — el único filtro de privacidad de doc 19 §1.7 vive acá.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDriver, type SqliteDriver } from '../driver.js';
import { runMigrations } from '../migrations/index.js';
import { createAgentRepository } from './agent.js';
import { createAgentMemoryRepository } from './agentMemory.js';

describe('AgentMemoryRepository — privacidad por proyecto (T09)', () => {
  let driver: SqliteDriver;
  let dir: string;
  let agentId: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'saurio-agent-memory-test-'));
    driver = openDriver(path.join(dir, 'saurio.db'));
    runMigrations(driver);
    const agents = createAgentRepository(driver);
    const profile = await agents.createProfile({
      name: 'Con memoria', role: 'custom', modelMode: 'fixed', permissionPreset: 'balanced', memoryScope: 'global',
    });
    agentId = profile.id;
    // `agent_memories.project_id` tiene FK a `projects(id)` (foreign_keys=ON, driver.ts) — se siembran
    // las dos filas de proyecto que usan los tests de abajo.
    const now = Date.now();
    driver.prepare('INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)').run('proj-A', '/fake/a', 'A', now);
    driver.prepare('INSERT INTO projects (id, path, name, created_at) VALUES (?, ?, ?, ?)').run('proj-B', '/fake/b', 'B', now);
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('una memoria de proyecto A nunca aparece al listar para el proyecto B', async () => {
    const repo = createAgentMemoryRepository(driver);
    await repo.upsert({ agentId, projectId: 'proj-A', content: 'mi apodo es X', sourceKind: 'user_stated', confidence: 'confirmed' });

    const forB = await repo.list(agentId, 'proj-B');
    expect(forB).toHaveLength(0);

    const forA = await repo.list(agentId, 'proj-A');
    expect(forA).toHaveLength(1);
    expect(forA[0]!.content).toBe('mi apodo es X');
  });

  it('una memoria global (project_id NULL) es visible desde cualquier proyecto', async () => {
    const repo = createAgentMemoryRepository(driver);
    await repo.upsert({ agentId, content: 'siempre responde en español', sourceKind: 'user_stated', confidence: 'confirmed' });

    expect(await repo.list(agentId, 'proj-A')).toHaveLength(1);
    expect(await repo.list(agentId, 'proj-B')).toHaveLength(1);
    expect(await repo.list(agentId)).toHaveLength(1);
  });

  it('sin projectId devuelve solo las memorias globales, no las de cualquier proyecto', async () => {
    const repo = createAgentMemoryRepository(driver);
    await repo.upsert({ agentId, projectId: 'proj-A', content: 'privada de A', sourceKind: 'inferred', confidence: 'hypothesis' });
    await repo.upsert({ agentId, content: 'global', sourceKind: 'user_stated', confidence: 'confirmed' });

    const withoutProject = await repo.list(agentId);
    expect(withoutProject).toHaveLength(1);
    expect(withoutProject[0]!.content).toBe('global');
  });

  it('upsert con id existente actualiza en vez de duplicar; delete la quita', async () => {
    const repo = createAgentMemoryRepository(driver);
    const created = await repo.upsert({ agentId, projectId: 'proj-A', content: 'v1', sourceKind: 'user_stated', confidence: 'hypothesis' });
    const updated = await repo.upsert({ id: created.id, agentId, projectId: 'proj-A', content: 'v2', confidence: 'confirmed' });
    expect(updated.id).toBe(created.id);
    expect((await repo.list(agentId, 'proj-A'))).toHaveLength(1);
    expect((await repo.list(agentId, 'proj-A'))[0]!.content).toBe('v2');

    await repo.delete(created.id);
    expect(await repo.list(agentId, 'proj-A')).toHaveLength(0);
  });

  it('el alcance de proyecto puede excluir memorias globales del mismo agente', async () => {
    const repo = createAgentMemoryRepository(driver);
    await repo.upsert({ agentId, content: 'global', sourceKind: 'user_stated', confidence: 'confirmed' });
    await repo.upsert({ agentId, projectId: 'proj-A', content: 'sólo A', sourceKind: 'user_stated', confidence: 'confirmed' });

    expect((await repo.list(agentId, 'proj-A', { includeGlobal: false })).map((memory) => memory.content)).toEqual(['sólo A']);
  });

  it('una memoria expirada no aparece en list()', async () => {
    const repo = createAgentMemoryRepository(driver);
    await repo.upsert({
      agentId, projectId: 'proj-A', content: 'ya no válida', sourceKind: 'user_stated', confidence: 'confirmed',
      expiresAt: Date.now() - 1,
    });
    expect(await repo.list(agentId, 'proj-A')).toEqual([]);
  });

  it('una memoria invalidada no aparece en list()', async () => {
    const repo = createAgentMemoryRepository(driver);
    const created = await repo.upsert({ agentId, projectId: 'proj-A', content: 'obsoleta', sourceKind: 'user_stated', confidence: 'confirmed' });
    await repo.upsert({ id: created.id, agentId, projectId: 'proj-A', content: 'obsoleta', invalidatedAt: Date.now() });
    expect(await repo.list(agentId, 'proj-A')).toHaveLength(0);
  });
});
