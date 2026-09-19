import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@saurio/shared';

vi.mock('../ipc/client.js', () => ({ invoke: vi.fn() }));

const { invoke } = await import('../ipc/client.js');
const { useChatStore } = await import('./chatStore.js');
const invokeMock = vi.mocked(invoke);

const chat = (id: string, projectId = 'project_1'): Chat => ({
  id, projectId, agentId: 'agent_builtin_lead', mode: 'agent', createdAt: 1, updatedAt: 2, archived: false,
});

function settingKey(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('key' in input)) return undefined;
  const key = (input as { key?: unknown }).key;
  return typeof key === 'string' ? key : undefined;
}

function resetStore(): void {
  useChatStore.setState({
    chatsByProject: {}, currentChatId: undefined, modeByChat: {}, draftModelRefByProject: {}, draftModeByProject: {},
    pinnedChatIdsByProject: {}, historyLoaded: {}, loading: false, error: undefined,
  });
}

describe('pines de chats', () => {
  beforeEach(() => { resetStore(); invokeMock.mockReset(); });

  it('rehidrata los pines del proyecto junto con los chats y descarta ids obsoletos', async () => {
    const chats = [chat('chat_pineado'), chat('chat_normal')];
    invokeMock.mockImplementation(async (channel, input) => {
      if (channel === 'chat:list') return chats;
      if (channel === 'settings:get' && settingKey(input) === 'ui.chats.pinnedIds') return ['chat_pineado', 'borrado'];
      if (channel === 'settings:get') return undefined;
      throw new Error(`IPC inesperado: ${channel}`);
    });

    await useChatStore.getState().loadChats('project_1');
    expect(useChatStore.getState().pinnedChatIdsByProject).toEqual({ project_1: ['chat_pineado'] });
  });

  it('persiste pinear y despegar dentro del proyecto del chat', async () => {
    useChatStore.setState({ chatsByProject: { project_1: [chat('chat_1')] } });
    invokeMock.mockResolvedValue(undefined);

    await useChatStore.getState().toggleChatPinned('chat_1');
    expect(invokeMock).toHaveBeenLastCalledWith('settings:set', {
      key: 'ui.chats.pinnedIds', value: ['chat_1'], projectId: 'project_1',
    });
    await useChatStore.getState().toggleChatPinned('chat_1');
    expect(invokeMock).toHaveBeenLastCalledWith('settings:set', {
      key: 'ui.chats.pinnedIds', value: [], projectId: 'project_1',
    });
  });

  it('eliminar un chat también persiste la limpieza de su pin', async () => {
    useChatStore.setState({ chatsByProject: { project_1: [chat('chat_1')] }, pinnedChatIdsByProject: { project_1: ['chat_1'] } });
    invokeMock.mockResolvedValue(undefined);

    await useChatStore.getState().deleteChat('chat_1');
    expect(invokeMock).toHaveBeenCalledWith('chat:delete', { chatId: 'chat_1' });
    expect(invokeMock).toHaveBeenCalledWith('settings:set', {
      key: 'ui.chats.pinnedIds', value: [], projectId: 'project_1',
    });
    expect(useChatStore.getState().pinnedChatIdsByProject.project_1).toEqual([]);
  });
});
