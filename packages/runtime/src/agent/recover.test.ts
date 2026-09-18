// Test "cierre inesperado simulado + recover" (doc 10 §5). Simula un crash sembrando directamente
// los fakes de persistencia (sin pasar por RunController, como haría un proceso que murió a mitad de
// un tool call) y después corre `recover()` como lo haría un bootstrap nuevo.
import { describe, expect, it } from 'vitest';
import { recover } from './recover.js';
import {
  makeFakeClock, makeFakeEventStore, makeFakeMessageRepository, makeFakeRunRepository,
  makeFakeToolCallRepository, makeFakeCheckpointRepository,
} from './testSupport.js';
import type { ToolCallRecord } from './types.js';
import type { RunRecord } from './ports.js';

describe('recover() (doc 10 §5)', () => {
  it('runs en executing_tool -> interrupted; tool_calls running -> orphaned, pending/approved -> abandoned', async () => {
    const clock = makeFakeClock();
    const events = makeFakeEventStore();
    const runs = makeFakeRunRepository();
    const toolCalls = makeFakeToolCallRepository();
    const messages = makeFakeMessageRepository();
    const checkpoints = makeFakeCheckpointRepository();

    const crashedRun: RunRecord = {
      id: 'run_crash', chatId: 'chat_1', agentId: 'agent_1', mode: 'agent',
      state: 'executing_tool', iteration: 2, lastEventSeq: 5, createdAt: clock.now(),
    };
    await runs.create(crashedRun);

    const runningCall: ToolCallRecord = {
      id: 'tc_running', runId: 'run_crash', iteration: 2, toolName: 'edit_file', args: { path: 'src/a.ts' },
      argsHash: 'h1', category: 'write', risk: 'medium', transport: 'native', status: 'running',
      startedAt: clock.now(),
    };
    const pendingCall: ToolCallRecord = {
      id: 'tc_pending', runId: 'run_crash', iteration: 2, toolName: 'list_files', args: {},
      argsHash: 'h2', category: 'read', risk: 'low', transport: 'native', status: 'pending',
    };
    await toolCalls.upsert(runningCall);
    await toolCalls.upsert(pendingCall);

    const result = await recover({ runs, toolCalls, messages, checkpoints, events, clock });

    expect(result.orphaned.map((c) => c.id)).toEqual(['tc_running']);
    expect(result.abandoned.map((c) => c.id)).toEqual(['tc_pending']);

    const updatedRun = await runs.get('run_crash');
    expect(updatedRun?.state).toBe('interrupted');

    expect((await toolCalls.get('tc_running'))?.status).toBe('orphaned');
    expect((await toolCalls.get('tc_pending'))?.status).toBe('abandoned');

    // doc 10 §5.6: mensajes `tool` sintéticos para que run:continue herede un historial bien formado.
    const chatMessages = await messages.listByChat('chat_1');
    expect(chatMessages).toHaveLength(2);
    expect(chatMessages.every((m) => m.role === 'tool')).toBe(true);

    // doc 05 §1 / doc 10 §2: evento run.state(from executing_tool, to interrupted) + run.recovered.
    expect(events.all.some((e) => e.type === 'run.state' && e.to === 'interrupted')).toBe(true);
    expect(events.all.some((e) => e.type === 'run.recovered')).toBe(true);
  });

  it('runs en awaiting_permission sobreviven intactos (doc 05 §1, nota)', async () => {
    const clock = makeFakeClock();
    const events = makeFakeEventStore();
    const runs = makeFakeRunRepository();
    const toolCalls = makeFakeToolCallRepository();
    const messages = makeFakeMessageRepository();

    await runs.create({
      id: 'run_waiting', chatId: 'chat_2', agentId: 'agent_1', mode: 'agent',
      state: 'awaiting_permission', iteration: 1, lastEventSeq: 3, createdAt: clock.now(),
    });
    await toolCalls.upsert({
      id: 'tc_waiting', runId: 'run_waiting', iteration: 1, toolName: 'edit_file', args: {},
      argsHash: 'h3', category: 'write', risk: 'medium', transport: 'native', status: 'awaiting_permission',
    });

    const result = await recover({ runs, toolCalls, messages, events, clock });

    expect(result.orphaned).toHaveLength(0);
    expect(result.abandoned).toHaveLength(0);
    expect((await runs.get('run_waiting'))?.state).toBe('awaiting_permission');
    expect((await toolCalls.get('tc_waiting'))?.status).toBe('awaiting_permission');
  });

  it('runs ya terminales no se tocan', async () => {
    const clock = makeFakeClock();
    const events = makeFakeEventStore();
    const runs = makeFakeRunRepository();
    const toolCalls = makeFakeToolCallRepository();
    const messages = makeFakeMessageRepository();

    await runs.create({
      id: 'run_done', chatId: 'chat_3', agentId: 'agent_1', mode: 'agent',
      state: 'completed', iteration: 3, lastEventSeq: 9, createdAt: clock.now(),
    });

    const result = await recover({ runs, toolCalls, messages, events, clock });
    expect(result.orphaned).toHaveLength(0);
    expect(result.abandoned).toHaveLength(0);
    expect((await runs.get('run_done'))?.state).toBe('completed');
  });
});
