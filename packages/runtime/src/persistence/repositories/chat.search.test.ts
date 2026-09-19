import { afterEach, describe, expect, it } from 'vitest';
import { openDriver, type SqliteDriver } from '../driver.js';
import { runMigrations } from '../migrations/index.js';
import { createProjectRepository } from './project.js';
import { createAgentRepository } from './agent.js';
import { createChatRepository } from './chat.js';
import { createMessageRepository } from './message.js';

describe('búsqueda de chats persistidos', () => {
  const drivers: SqliteDriver[] = [];
  afterEach(() => drivers.splice(0).forEach((driver) => driver.close()));
  async function setup() {
    const driver = openDriver(':memory:');
    drivers.push(driver);
    runMigrations(driver);
    for (const id of ['A', 'B']) await createProjectRepository(driver).create({ id, name: id, path: `/${id}`, createdAt: 1, lastOpenedAt: 1 });
    const agent = await createAgentRepository(driver).createProfile({ name: 'Test', role: 'custom', modelMode: 'auto', permissionPreset: 'balanced' });
    const chats = createChatRepository(driver);
    const messages = createMessageRepository(driver);
    async function add(id: string, projectId = 'A', text = 'El diagnóstico de la conexión funciona', archived = false, at = 100) {
      await chats.create({ id, projectId, title: `Informe ${id}`, agentId: agent.id, mode: 'agent', archived, createdAt: 1, updatedAt: at });
      await messages.append(id, { id: `m-${id}`, role: 'user', content: text });
      driver.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(at, `m-${id}`);
    }
    return { driver, chats, messages, add };
  }

  it('encuentra contenido indexado por palabras/prefijos con fragmento, sin cruzar proyectos ni duplicar chats', async () => {
    const { chats, messages, add } = await setup();
    await add('c-a');
    await add('c-b', 'B');
    await messages.append('c-a', { id: 'm-a-2', role: 'assistant', content: 'También confirmé el diagnóstico.' });
    const result = await chats.search({ projectId: 'A', query: 'diagnos' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ chatId: 'c-a', projectId: 'A', messageId: 'm-a-2' });
    expect(result.items[0]?.snippet).toContain('diagnóstico');
    expect(result.hasMore).toBe(false);
  });

  it('excluye eliminados, archivados por defecto y mensajes de herramientas', async () => {
    const { driver, chats, messages, add } = await setup();
    await add('archived', 'A', 'aguacate', true);
    await add('deleted', 'A', 'aguacate');
    await chats.softDelete('deleted', 200);
    await add('tool', 'A', 'otro');
    await messages.append('tool', { id: 'tool-message', role: 'tool', content: 'aguacate', toolCallId: 'x' });
    expect((await chats.search({ projectId: 'A', query: 'aguacate' })).items).toEqual([]);
    expect((await chats.search({ projectId: 'A', query: 'aguacate', includeArchived: true })).items.map((item) => item.chatId)).toEqual(['archived']);
    driver.prepare('UPDATE chats SET archived = 0 WHERE id = ?').run('archived');
    expect((await chats.search({ projectId: 'A', query: 'aguacate' })).items).toHaveLength(1);
  });

  it('aplica fechas a mensajes y títulos, y no carga contenido completo en resultados', async () => {
    const { chats, add } = await setup();
    await add('old', 'A', 'aguacate', false, 99);
    await add('recent', 'A', `${'prefijo '.repeat(200)}aguacate${' final'.repeat(200)}`, false, 150);
    const result = await chats.search({ projectId: 'A', query: 'aguacate', since: 100, until: 200 });
    expect(result.items.map((item) => item.chatId)).toEqual(['recent']);
    expect(result.items[0]?.snippet.length).toBeLessThanOrEqual(400);
    expect(result.items[0]?.snippet).toContain('aguacate');
    expect((await chats.search({ projectId: 'A', query: 'Informe', since: 100, until: 200 })).items.map((item) => item.chatId)).toEqual(['recent']);
    await expect(chats.search({ projectId: 'A', query: 'x', since: 200, until: 100 })).rejects.toThrow('fecha');
  });

  it('pagina chats con orden estable y no interpreta operadores FTS o comodines de SQL', async () => {
    const { chats, add } = await setup();
    for (let index = 0; index < 45; index++) await add(`page-${String(index).padStart(2, '0')}`, 'A', 'paginación');
    const first = await chats.search({ projectId: 'A', query: 'paginación', limit: 20 });
    const second = await chats.search({ projectId: 'A', query: 'paginación', limit: 20, offset: 20 });
    const last = await chats.search({ projectId: 'A', query: 'paginación', limit: 20, offset: 40 });
    expect([first.items.length, second.items.length, last.items.length]).toEqual([20, 20, 5]);
    expect([first.hasMore, second.hasMore, last.hasMore]).toEqual([true, true, false]);
    expect(new Set([...first.items, ...second.items, ...last.items].map((item) => item.chatId)).size).toBe(45);
    expect((await chats.search({ projectId: 'A', query: '%' })).items).toEqual([]);
    expect((await chats.search({ projectId: 'A', query: 'paginación OR secreto' })).items).toEqual([]);
    await expect(chats.search({ projectId: 'A', query: '"' })).resolves.toEqual({ items: [], hasMore: false });
  });
});
