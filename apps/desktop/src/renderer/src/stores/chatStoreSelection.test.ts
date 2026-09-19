import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@saurio/shared';

vi.mock('../ipc/client.js', () => ({ invoke: vi.fn() }));
const { invoke } = await import('../ipc/client.js');
const { useChatStore } = await import('./chatStore.js');
const mock = vi.mocked(invoke);
const chat = (id: string, projectId: string, archived = false): Chat => ({ id, projectId, archived, agentId: 'agent_builtin_lead', mode: 'ask', createdAt: 1, updatedAt: 1 });

describe('restauración de selección de chats', () => {
  beforeEach(() => {
    mock.mockReset();
    useChatStore.setState({ chatsByProject: {}, currentChatId: undefined, loading: false, error: undefined, pinnedChatIdsByProject: {} });
  });

  it('una lista tardía de A no reemplaza la selección restaurada de B', async () => {
    let resolveA!: (chats: Chat[]) => void;
    const pending = new Promise<Chat[]>((resolve) => { resolveA = resolve; });
    mock.mockImplementation(async (channel, input) => {
      if (channel === 'chat:list') return (input as { projectId: string }).projectId === 'A' ? pending : [chat('B-chat', 'B')];
      if (channel === 'settings:get') return (input as { key: string }).key === 'ui.projects.lastChatId' ? 'B-chat' : [];
      return undefined;
    });
    const first = useChatStore.getState().loadChats('A');
    await useChatStore.getState().loadChats('B');
    resolveA([chat('A-chat', 'A')]);
    await first;
    expect(useChatStore.getState().currentChatId).toBe('B-chat');
    expect(useChatStore.getState().loading).toBe(false);
  });

  it('no reabre el último chat si está archivado', async () => {
    mock.mockImplementation(async (channel, input) => {
      if (channel === 'chat:list') return [chat('archived', 'A', true)];
      if (channel === 'settings:get') return (input as { key: string }).key === 'ui.projects.lastChatId' ? 'archived' : [];
      return undefined;
    });
    await useChatStore.getState().loadChats('A');
    expect(useChatStore.getState().currentChatId).toBeUndefined();
    expect(useChatStore.getState().chatsByProject.A).toHaveLength(1);
  });

  it('respeta una selección humana hecha mientras se restauraba la lista', async () => {
    let resolveList!: (chats: Chat[]) => void;
    const pending = new Promise<Chat[]>((resolve) => { resolveList = resolve; });
    mock.mockImplementation(async (channel, input) => {
      if (channel === 'chat:list') return pending;
      if (channel === 'settings:get') return (input as { key: string }).key === 'ui.projects.lastChatId' ? 'old' : [];
      return undefined;
    });
    const restoring = useChatStore.getState().loadChats('A');
    useChatStore.getState().setCurrentChat('chosen');
    resolveList([chat('old', 'A'), chat('chosen', 'A')]);
    await restoring;
    expect(useChatStore.getState().currentChatId).toBe('chosen');
  });
});
