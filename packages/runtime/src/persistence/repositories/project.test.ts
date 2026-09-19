// Test de ProjectRepository — packages/runtime/src/persistence/repositories/project.test.ts.
// Punto 12 del encargo (feedback real v0.2.1 + pedido del director): "proyectos persistentes",
// project:recent/remove/rename.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDriver, type SqliteDriver } from '../driver.js';
import { runMigrations } from '../migrations/index.js';
import { createProjectRepository } from './project.js';
import { createChatRepository } from './chat.js';
import { createAgentRepository } from './agent.js';

describe('ProjectRepository — recientes/remove/rename', () => {
  let driver: SqliteDriver;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'saurio-project-test-'));
    driver = openDriver(path.join(dir, 'saurio.db'));
    runMigrations(driver);
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('listRecent devuelve más reciente primero, con la cantidad de chats de cada uno', async () => {
    const projects = createProjectRepository(driver);
    const chats = createChatRepository(driver);
    const agents = createAgentRepository(driver);
    const agent = await agents.createProfile({ name: 'A', role: 'custom', modelMode: 'fixed', permissionPreset: 'balanced', memoryScope: 'global' });

    await projects.create({ id: 'p1', path: '/fake/p1', name: 'P1', createdAt: 1, lastOpenedAt: 1 });
    await projects.create({ id: 'p2', path: '/fake/p2', name: 'P2', createdAt: 2, lastOpenedAt: 2 });
    await chats.create({ id: 'c1', projectId: 'p1', agentId: agent.id, mode: 'agent', createdAt: 1, updatedAt: 1, archived: false });
    await chats.create({ id: 'c2', projectId: 'p1', agentId: agent.id, mode: 'agent', createdAt: 2, updatedAt: 2, archived: false });

    const recent = await projects.listRecent();
    expect(recent.map((r) => r.project.id)).toEqual(['p2', 'p1']);
    expect(recent.find((r) => r.project.id === 'p1')?.chatCount).toBe(2);
    expect(recent.find((r) => r.project.id === 'p2')?.chatCount).toBe(0);
    const moved = await projects.relocate!('p1', '/fake/moved');
    expect(moved).toMatchObject({ id: 'p1', path: '/fake/moved', name: 'P1', createdAt: 1 });
    expect((await chats.listByProject('p1')).map((chat) => chat.id).sort()).toEqual(['c1', 'c2']);
    expect((await projects.listRecent()).find((row) => row.project.id === 'p1')?.chatCount).toBe(2);
    await expect(projects.relocate!('p1', '/fake/p2')).rejects.toThrow();
    expect((await projects.get('p1'))?.path).toBe('/fake/moved');
  });

  it('un chat soft-deleted no cuenta en chatCount', async () => {
    const projects = createProjectRepository(driver);
    const chats = createChatRepository(driver);
    const agents = createAgentRepository(driver);
    const agent = await agents.createProfile({ name: 'A', role: 'custom', modelMode: 'fixed', permissionPreset: 'balanced', memoryScope: 'global' });
    await projects.create({ id: 'p1', path: '/fake/p1', name: 'P1', createdAt: 1, lastOpenedAt: 1 });
    await chats.create({ id: 'c1', projectId: 'p1', agentId: agent.id, mode: 'agent', createdAt: 1, updatedAt: 1, archived: false });
    await chats.softDelete('c1', 5);

    const recent = await projects.listRecent();
    expect(recent[0]?.chatCount).toBe(0);
    const listed = await chats.listByProject('p1');
    expect(listed).toHaveLength(0);
  });

  it('setRemovedFromRecents saca el proyecto de listRecent sin borrar la fila', async () => {
    const projects = createProjectRepository(driver);
    await projects.create({ id: 'p1', path: '/fake/p1', name: 'P1', createdAt: 1, lastOpenedAt: 1 });
    await projects.setRemovedFromRecents('p1', true);

    expect(await projects.listRecent()).toEqual([]);
    expect(await projects.get('p1')).toBeDefined(); // no se borró

    await projects.setRemovedFromRecents('p1', false);
    expect((await projects.listRecent()).map((r) => r.project.id)).toEqual(['p1']);
  });

  it('rename cambia el nombre sin tocar el resto', async () => {
    const projects = createProjectRepository(driver);
    await projects.create({ id: 'p1', path: '/fake/p1', name: 'P1', createdAt: 1, lastOpenedAt: 1 });
    const renamed = await projects.rename('p1', 'Nuevo nombre');
    expect(renamed.name).toBe('Nuevo nombre');
    expect(renamed.path).toBe('/fake/p1');
  });
});
