import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Chat } from '@saurio/shared';
import { openDriver } from '../driver.js';
import { runMigrations } from '../migrations/index.js';
import { createProjectRepository } from './project.js';
import { createAgentRepository } from './agent.js';
import { createChatRepository } from './chat.js';

describe('ChatRepository — origen de selección de modelo', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  async function seed(dbPath: string) {
    const driver = openDriver(dbPath);
    runMigrations(driver);
    await createProjectRepository(driver).create({ id: 'p1', path: '/p1', name: 'P1', createdAt: 1, lastOpenedAt: 1 });
    const agent = await createAgentRepository(driver).createProfile({
      name: 'Auto', role: 'custom', modelMode: 'auto', permissionPreset: 'balanced', memoryScope: 'global',
    });
    return { driver, chats: createChatRepository(driver), agentId: agent.id };
  }

  it('persiste un chat auto sin modelRef y lo recupera después de reabrir SQLite', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'saurio-chat-model-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'saurio.db');
    const first = await seed(dbPath);
    const chat: Chat = {
      id: 'c-auto', projectId: 'p1', agentId: first.agentId, mode: 'agent', modelSelection: 'auto',
      createdAt: 1, updatedAt: 1, archived: false,
    };
    await first.chats.create(chat);
    first.driver.close();

    const reopened = openDriver(dbPath);
    const restored = await createChatRepository(reopened).get(chat.id);
    expect(restored).toMatchObject({ id: chat.id, modelSelection: 'auto' });
    expect(restored?.modelRef).toBeUndefined();
    reopened.close();
  });

  it('un override explícito puede fijar el mismo modelo y preserva otras claves de override_json', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'saurio-chat-model-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'saurio.db');
    const seeded = await seed(dbPath);
    await seeded.chats.create({
      id: 'c-explicit', projectId: 'p1', agentId: seeded.agentId, mode: 'agent', modelSelection: 'auto',
      createdAt: 1, updatedAt: 1, archived: false,
    });
    seeded.driver.prepare('UPDATE chats SET override_json = ? WHERE id = ?')
      .run(JSON.stringify({ modelSelection: 'auto', futureSetting: 7 }), 'c-explicit');
    const modelRef = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' as const };
    const updated = await seeded.chats.update('c-explicit', { modelRef, modelSelection: 'explicit' });
    expect(updated).toMatchObject({ modelRef, modelSelection: 'explicit' });
    const raw = seeded.driver.prepare<{ override_json: string }>('SELECT override_json FROM chats WHERE id = ?').get('c-explicit');
    expect(JSON.parse(raw!.override_json)).toEqual({ modelSelection: 'explicit', futureSetting: 7 });
    seeded.driver.close();
  });
});
