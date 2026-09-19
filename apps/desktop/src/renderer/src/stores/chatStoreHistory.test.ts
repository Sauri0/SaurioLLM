import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcOutput } from '@saurio/shared';

vi.mock('../ipc/client.js', () => ({ invoke: vi.fn() }));

const { invoke } = await import('../ipc/client.js');
const { useChatStore } = await import('./chatStore.js');
const { useRunStore } = await import('./runStore.js');
const invokeMock = vi.mocked(invoke);

type ChatHistory = IpcOutput<'chat:history'>;
const emptyHistory: ChatHistory = { messages: [], toolCalls: [], checkpoints: [], tasks: [] };

function resetStores(): void {
  useChatStore.setState({ historyLoaded: {}, loading: false, error: undefined });
  useRunStore.setState({
    runStates: {}, runChatIds: {}, errorsByRun: {}, lastSeqByRun: {},
    messagesByChat: {}, checkpointsByChat: {}, tasksByChat: {}, toolCalls: {}, toolCallOrderByRun: {},
    modelResolutionByChat: {},
  });
}

describe('chatStore — rehidratación del último run', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetStores();
  });

  it('restaura estado y error del último run fallido después de reabrir el chat', async () => {
    invokeMock.mockResolvedValue({
      ...emptyHistory,
      lastRun: {
        id: 'run_failed', state: 'failed',
        error: { code: 'format', message: 'Tool no habilitada: "write_file".' },
      },
    });

    await useChatStore.getState().loadHistory('chat_1');

    const run = useRunStore.getState();
    expect(run.runChatIds.run_failed).toBe('chat_1');
    expect(run.runStates.run_failed).toBe('failed');
    expect(run.errorsByRun.run_failed).toEqual([
      { code: 'format', message: 'Tool no habilitada: "write_file".' },
    ]);
  });

  it('un último run exitoso pasa a ser el actual sin heredar el error fallido anterior', async () => {
    useRunStore.setState({
      runChatIds: { run_failed: 'chat_1' },
      runStates: { run_failed: 'failed' },
      errorsByRun: { run_failed: [{ code: 'format', message: 'error anterior' }] },
    });
    invokeMock.mockResolvedValue({
      ...emptyHistory,
      lastRun: { id: 'run_completed', state: 'completed' },
    });

    await useChatStore.getState().loadHistory('chat_1');

    const run = useRunStore.getState();
    const chatRunIds = Object.entries(run.runChatIds)
      .filter(([, chatId]) => chatId === 'chat_1')
      .map(([runId]) => runId);
    expect(chatRunIds.at(-1)).toBe('run_completed');
    expect(run.runStates.run_completed).toBe('completed');
    expect(run.errorsByRun.run_completed).toBeUndefined();
  });

  it('una respuesta tardía no pisa ni reintroduce un run obsoleto si llegaron eventos live', async () => {
    let resolveHistory!: (history: ChatHistory) => void;
    const pendingHistory = new Promise<ChatHistory>((resolve) => { resolveHistory = resolve; });
    invokeMock.mockReturnValue(pendingHistory);

    const loading = useChatStore.getState().loadHistory('chat_1');
    useRunStore.getState().applyEvents([
      {
        type: 'run.state', runId: 'run_live', chatId: 'chat_1', seq: 1, ts: 10,
        from: 'created', to: 'generating',
      },
      {
        type: 'run.error', runId: 'run_live', chatId: 'chat_1', seq: 2, ts: 11,
        error: { code: 'format', message: 'error live' }, recoverable: false,
      },
      {
        type: 'run.state', runId: 'run_live', chatId: 'chat_1', seq: 3, ts: 12,
        from: 'generating', to: 'failed', reason: 'error live',
      },
    ]);
    resolveHistory({
      ...emptyHistory,
      lastRun: {
        id: 'run_stale', state: 'failed',
        error: { code: 'provider_down', message: 'foto persistida vieja' },
      },
    });
    await loading;

    const run = useRunStore.getState();
    expect(run.runStates.run_live).toBe('failed');
    expect(run.errorsByRun.run_live?.at(-1)?.message).toBe('error live');
    expect(run.runStates.run_stale).toBeUndefined();
    expect(run.errorsByRun.run_stale).toBeUndefined();
  });
});
