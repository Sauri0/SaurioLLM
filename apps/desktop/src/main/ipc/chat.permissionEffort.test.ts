// Test de los handlers nuevos chat:setPermissionPreset/setEffort/rename/archive/delete (puntos
// 1a/1b/12 del encargo, feedback real v0.2.1) — apps/desktop/src/main/ipc/chat.permissionEffort.test.ts.
// Mismo patrón que providers.test.ts: `electron` mockeado, `RuntimeHost` reemplazado por un objeto
// falso mínimo.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@saurio/shared';

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const fakeFrame = {} as never;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

const { allowFrame } = await import('./registerHandler.js');
const { registerChatHandlers } = await import('./chat.js');
type RuntimeHost = import('../host/RuntimeHost.js').RuntimeHost;

function makeFakeHost() {
  const chats = new Map<string, Chat>();
  chats.set('chat_1', {
    id: 'chat_1', projectId: 'proj_1', agentId: 'agent_1', mode: 'agent',
    createdAt: 0, updatedAt: 0, archived: false,
  });
  const auditEntries: { kind: string; payload: unknown }[] = [];

  const host = {
    chatRepository: {
      create: async (chat: Chat) => { chats.set(chat.id, chat); return chat; },
      get: async (id: string) => chats.get(id),
      update: async (id: string, patch: Partial<Chat>) => {
        const current = chats.get(id);
        if (!current) throw new Error('no existe');
        const updated = { ...current, ...patch };
        chats.set(id, updated);
        return updated;
      },
      softDelete: async (id: string) => { chats.delete(id); },
    },
    auditLog: { record: (entry: { kind: string; payload: unknown }) => { auditEntries.push(entry); } },
    settingsRepository: undefined as undefined | {
      get(key: string, projectId?: string): Promise<unknown>;
      set(key: string, value: unknown, projectId?: string): Promise<void>;
    },
    listProviderConfigs: (): { id: string; label: string }[] => [],
    runsOfChat: async () => [],
    messageRepository: { listByChat: async () => [] },
    toolCallRepository: { listByRun: async () => [] },
    checkpointRepository: { listByChat: async () => [] },
    taskRepository: { listByChat: async () => [] },
  };
  return { host, chats, auditEntries };
}

async function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handle = handlers.get(channel);
  if (!handle) throw new Error(`canal no registrado: ${channel}`);
  return handle({ senderFrame: fakeFrame }, payload);
}

describe('ipc/chat — preset de permisos, effort, rename/archive/delete', () => {
  beforeEach(() => {
    handlers.clear();
    allowFrame(fakeFrame);
  });

  it('chat:setPermissionPreset guarda el preset', async () => {
    const { host } = makeFakeHost();
    registerChatHandlers(host as unknown as RuntimeHost);
    const updated = await invoke('chat:setPermissionPreset', { chatId: 'chat_1', preset: 'edit_in_folder' }) as Chat;
    expect(updated.permissionPreset).toBe('edit_in_folder');
  });

  it('chat:setPermissionPreset a "unrestricted" sin confirmed falla y no queda auditado', async () => {
    const { host, auditEntries } = makeFakeHost();
    registerChatHandlers(host as unknown as RuntimeHost);
    await expect(invoke('chat:setPermissionPreset', { chatId: 'chat_1', preset: 'unrestricted' }))
      .rejects.toThrow(/confirmación explícita/);
    expect(auditEntries).toHaveLength(0);
  });

  it('chat:setPermissionPreset a "unrestricted" con confirmed:true lo aplica y audita', async () => {
    const { host, auditEntries } = makeFakeHost();
    registerChatHandlers(host as unknown as RuntimeHost);
    const updated = await invoke('chat:setPermissionPreset', { chatId: 'chat_1', preset: 'unrestricted', confirmed: true }) as Chat;
    expect(updated.permissionPreset).toBe('unrestricted');
    expect(auditEntries).toEqual([{ kind: 'permission.unrestricted_enabled', payload: { chatId: 'chat_1', projectId: 'proj_1' } }]);
  });

  it('chat:setEffort guarda el effort', async () => {
    const { host } = makeFakeHost();
    registerChatHandlers(host as unknown as RuntimeHost);
    const updated = await invoke('chat:setEffort', { chatId: 'chat_1', effort: 'deep' }) as Chat;
    expect(updated.effort).toBe('deep');
  });

  it('chat:history recupera la razón persistida de la última selección de modelo', async () => {
    const { host } = makeFakeHost();
    Object.assign(host, {
      runsOfChat: async () => [{
        id: 'run_1',
        state: 'completed',
        effectiveConfig: {
          modelResolution: {
            source: 'automatic_loaded', contextMax: 32768,
            fitClass: 'tight', fitQuality: 'estimated',
          },
        },
      }],
    });
    registerChatHandlers(host as unknown as RuntimeHost);

    await expect(invoke('chat:history', { chatId: 'chat_1' })).resolves.toMatchObject({
      modelResolution: {
        source: 'automatic_loaded', contextMax: 32768,
        fitClass: 'tight', fitQuality: 'estimated',
      },
    });
  });

  it('chat:history deja el origen sin confirmar para runs legacy', async () => {
    const { host } = makeFakeHost();
    Object.assign(host, { runsOfChat: async () => [{ id: 'run_legacy', state: 'completed' }] });
    registerChatHandlers(host as unknown as RuntimeHost);

    await expect(invoke('chat:history', { chatId: 'chat_1' })).resolves.not.toHaveProperty('modelResolution');
  });

  it('chat:history devuelve el error real persistido del último run fallido', async () => {
    const { host } = makeFakeHost();
    Object.assign(host, {
      runsOfChat: async () => [{
        id: 'run_failed', state: 'failed',
        error: { code: 'format', message: 'El modelo intentó usar "write_file" sin habilitación.' },
      }],
    });
    registerChatHandlers(host as unknown as RuntimeHost);

    await expect(invoke('chat:history', { chatId: 'chat_1' })).resolves.toMatchObject({
      lastRun: {
        id: 'run_failed', state: 'failed',
        error: { code: 'format', message: 'El modelo intentó usar "write_file" sin habilitación.' },
      },
    });
  });

  it('chat:history no arrastra el error de un run viejo si el último terminó bien', async () => {
    const { host } = makeFakeHost();
    Object.assign(host, {
      runsOfChat: async () => [
        { id: 'run_failed', state: 'failed', error: { code: 'format', message: 'error anterior' } },
        { id: 'run_completed', state: 'completed' },
      ],
    });
    registerChatHandlers(host as unknown as RuntimeHost);

    const history = await invoke('chat:history', { chatId: 'chat_1' }) as { lastRun?: unknown };
    expect(history.lastRun).toEqual({ id: 'run_completed', state: 'completed' });
  });

  it('chat:rename cambia el título', async () => {
    const { host } = makeFakeHost();
    registerChatHandlers(host as unknown as RuntimeHost);
    const updated = await invoke('chat:rename', { chatId: 'chat_1', title: 'Nuevo título' }) as Chat;
    expect(updated.title).toBe('Nuevo título');
  });

  it('chat:archive marca archived', async () => {
    const { host } = makeFakeHost();
    registerChatHandlers(host as unknown as RuntimeHost);
    const updated = await invoke('chat:archive', { chatId: 'chat_1', archived: true }) as Chat;
    expect(updated.archived).toBe(true);
  });

  it('chat:delete llama softDelete', async () => {
    const { host, chats } = makeFakeHost();
    registerChatHandlers(host as unknown as RuntimeHost);
    await invoke('chat:delete', { chatId: 'chat_1' });
    expect(chats.has('chat_1')).toBe(false);
  });

  it('chat:create automático no persiste un modelo provisional', async () => {
    const { host } = makeFakeHost();
    registerChatHandlers(host as unknown as RuntimeHost);
    const created = await invoke('chat:create', {
      projectId: 'proj_1', agentId: 'agent_auto', mode: 'agent', modelSelection: 'auto',
    }) as Chat;
    expect(created.modelSelection).toBe('auto');
    expect(created.modelRef).toBeUndefined();
  });

  it('chat:setModel convierte auto en explícito aun si el modelo coincide con el recomendado', async () => {
    const { host, chats } = makeFakeHost();
    chats.set('chat_1', { ...chats.get('chat_1')!, modelSelection: 'auto' });
    registerChatHandlers(host as unknown as RuntimeHost);
    const modelRef = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' as const };
    const updated = await invoke('chat:setModel', { chatId: 'chat_1', modelRef }) as Chat;
    expect(updated).toMatchObject({ modelRef, modelSelection: 'explicit' });
  });

  it('una selección explícita cloud conserva el gate de consentimiento', async () => {
    const { host } = makeFakeHost();
    const settings = new Map<string, unknown>();
    host.settingsRepository = {
      get: async (key: string, projectId?: string) => settings.get(`${projectId ?? ''}:${key}`),
      set: async (key: string, value: unknown, projectId?: string) => { settings.set(`${projectId ?? ''}:${key}`, value); },
    };
    host.listProviderConfigs = () => [{ id: 'cloud-one', label: 'Cloud Uno' }];
    registerChatHandlers(host as unknown as RuntimeHost);
    const modelRef = { providerId: 'cloud-one', name: 'modelo', locality: 'cloud' as const };
    await expect(invoke('chat:create', {
      projectId: 'proj_1', agentId: 'agent_1', mode: 'agent', modelRef, modelSelection: 'explicit',
    })).rejects.toThrow(/CLOUD_CONFIRMATION_REQUIRED:Cloud Uno/);
    const created = await invoke('chat:create', {
      projectId: 'proj_1', agentId: 'agent_1', mode: 'agent', modelRef, modelSelection: 'explicit', confirmed: true,
    }) as Chat;
    expect(created).toMatchObject({ modelRef, modelSelection: 'explicit' });
  });
});
