// Tests del reducer puro de runStore (doc 04 §6 RunEvent) — junto al código, vitest (regla de tests
// del módulo renderer-core).
import { describe, expect, it } from 'vitest';
import type { PermissionRequest, RunEvent } from '@saurio/shared';
import { reduceRunEvent, useRunStore, type RunStoreState } from './runStore.js';

function emptyState(): Omit<RunStoreState, 'applyEvents' | 'clearChat' | 'dismissInterrupted' | 'hydratePendingPermissions'> {
  return {
    runStates: {},
    runStartedAt: {},
    runChatIds: {},
    messagesByChat: {},
    metricsByMessage: {},
    streaming: {},
    toolCalls: {},
    toolCallOrderByRun: {},
    pendingPermissions: {},
    checkpointsByChat: {},
    tasksByChat: {},
    adjustmentsByRun: {},
    errorsByRun: {},
    interrupted: {},
    lastSeqByRun: {},
    childRunsByParent: {},
    childChatIdByRun: {},
    childChatIdByToolCall: {},
    activityByRun: {},
    smallModelWarningByRun: {},
    contextBudgetByChat: {},
    modelResolutionByChat: {},
  };
}

const base = { runId: 'run-1', chatId: 'chat-1', ts: 0 };

describe('reduceRunEvent', () => {
  it('recuerda el primer token después de message.done y lo separa del próximo run', () => {
    let state = emptyState() as RunStoreState;
    state = reduceRunEvent(state, { ...base, seq: 1, type: 'message.delta', messageId: 'm', field: 'thinking', text: 'Analizando' });
    state = reduceRunEvent(state, { ...base, seq: 2, type: 'message.done', message: { id: 'm', role: 'assistant', content: '' }, metrics: { quality: 'measured' } });
    state = reduceRunEvent(state, { ...base, seq: 3, type: 'run.state', from: 'queued', to: 'generating' });
    expect(state.streaming).toEqual({});
    expect(state.firstChunkByRun?.['run-1']).toBe(true);
    expect(state.firstChunkByRun?.['run-2']).toBeUndefined();
  });
  it('actualiza runStates con run.state', () => {
    const event: RunEvent = { ...base, seq: 1, type: 'run.state', from: 'created', to: 'generating' };
    const next = reduceRunEvent(emptyState() as RunStoreState, event);
    expect(next.runStates['run-1']).toBe('generating');
    expect(next.runChatIds['run-1']).toBe('chat-1');
  });

  it('guarda runStartedAt con el ts del PRIMER run.state visto de un run, sin pisarlo después (tarea "carga de modelo")', () => {
    const first: RunEvent = { ...base, ts: 1000, seq: 1, type: 'run.state', from: 'created', to: 'preparing' };
    let next = reduceRunEvent(emptyState() as RunStoreState, first);
    expect(next.runStartedAt['run-1']).toBe(1000);

    const later: RunEvent = { ...base, ts: 5000, seq: 2, type: 'run.state', from: 'preparing', to: 'generating' };
    next = reduceRunEvent(next, later);
    expect(next.runStartedAt['run-1']).toBe(1000); // no se pisa con la vuelta siguiente del mismo run
  });

  it('acumula message.delta de content y thinking por separado y limpia streaming en message.done', () => {
    const state = emptyState() as RunStoreState;
    const d1: RunEvent = { ...base, seq: 1, type: 'message.delta', messageId: 'm1', field: 'thinking', text: 'pensando' };
    const d2: RunEvent = { ...base, seq: 2, type: 'message.delta', messageId: 'm1', field: 'content', text: 'Hola ' };
    const d3: RunEvent = { ...base, seq: 3, type: 'message.delta', messageId: 'm1', field: 'content', text: 'mundo' };
    let next = reduceRunEvent(state, d1);
    next = reduceRunEvent(next, d2);
    next = reduceRunEvent(next, d3);
    expect(next.streaming.m1?.content).toBe('Hola mundo');
    expect(next.streaming.m1?.thinking).toBe('pensando');

    const done: RunEvent = {
      ...base, seq: 4, type: 'message.done',
      message: { id: 'm1', role: 'assistant', content: 'Hola mundo' },
      metrics: { quality: 'measured', evalTokens: 5 },
    };
    next = reduceRunEvent(next, done);
    expect(next.streaming.m1).toBeUndefined();
    expect(next.messagesByChat['chat-1']?.[0]?.content).toBe('Hola mundo');
    expect(next.metricsByMessage.m1?.quality).toBe('measured');
  });

  it('registra tool.registered y actualiza estado con tool.status', () => {
    const state = emptyState() as RunStoreState;
    const registered: RunEvent = {
      ...base, seq: 1, type: 'tool.registered',
      call: {
        id: 'tc1', runId: 'run-1', iteration: 0, toolName: 'edit_file', args: {}, argsHash: 'h',
        category: 'write', risk: 'medium', transport: 'native', status: 'pending',
      },
    };
    let next = reduceRunEvent(state, registered);
    expect(next.toolCalls.tc1?.status).toBe('pending');
    expect(next.toolCallOrderByRun['run-1']).toEqual(['tc1']);

    const status: RunEvent = {
      ...base, seq: 2, type: 'tool.status', toolCallId: 'tc1', status: 'done', resultPreview: 'ok',
    };
    next = reduceRunEvent(next, status);
    expect(next.toolCalls.tc1?.status).toBe('done');
    expect(next.toolCalls.tc1?.resultPreview).toBe('ok');
  });

  it('agrega y remueve permisos pendientes con tool.permission / tool.decision', () => {
    const state = emptyState() as RunStoreState;
    const request: RunEvent = {
      ...base, seq: 1, type: 'tool.permission',
      request: {
        toolCallId: 'tc1', toolName: 'run_command', category: 'terminal', risk: 'medium',
        summary: 'Ejecutar npm test', triggeredBy: 'preset balanced', rememberOptions: [],
      },
    };
    let next = reduceRunEvent(state, request);
    expect(next.pendingPermissions.tc1).toBeDefined();

    const decision: RunEvent = {
      ...base, seq: 2, type: 'tool.decision', toolCallId: 'tc1',
      decision: { toolCallId: 'tc1', answer: 'allow_once' },
    };
    next = reduceRunEvent(next, decision);
    expect(next.pendingPermissions.tc1).toBeUndefined();
  });

  it('reemplaza tasks.updated completo y acumula checkpoints', () => {
    const state = emptyState() as RunStoreState;
    const tasksEvent: RunEvent = {
      ...base, seq: 1, type: 'tasks.updated',
      tasks: [{ id: 't1', chatId: 'chat-1', ord: 0, title: 'Paso 1', status: 'pending' }],
    };
    let next = reduceRunEvent(state, tasksEvent);
    expect(next.tasksByChat['chat-1']).toHaveLength(1);

    const checkpointEvent: RunEvent = {
      ...base, seq: 2, type: 'checkpoint.created',
      checkpoint: {
        id: 'ck1', runId: 'run-1', chatId: 'chat-1', kind: 'tool', files: [],
        stats: { files: 1, added: 2, removed: 0 }, status: 'active',
      },
    };
    next = reduceRunEvent(next, checkpointEvent);
    expect(next.checkpointsByChat['chat-1']).toHaveLength(1);
  });

  it('guarda info de run.recovered para la tarjeta de run interrumpido', () => {
    const state = emptyState() as RunStoreState;
    const event: RunEvent = {
      ...base, seq: 1, type: 'run.recovered', orphaned: [], abandoned: [],
    };
    const next = reduceRunEvent(state, event);
    expect(next.interrupted['run-1']).toEqual({ runId: 'run-1', chatId: 'chat-1', orphaned: [], abandoned: [] });
  });

  it('acumula runs hijos y correlación exacta por toolCallId', () => {
    const state = emptyState() as RunStoreState;
    const event: RunEvent = {
      ...base, seq: 1, type: 'run.delegated',
      parentRunId: 'run-1', childRunId: 'run-2', childChatId: 'chat-2',
      targetAgentId: 'agent-x', task: 'revisar el módulo X', toolCallId: 'call-1',
    };
    const next = reduceRunEvent(state, event);
    expect(next.childRunsByParent['run-1']).toEqual(['run-2']);
    expect(next.childChatIdByRun['run-2']).toBe('chat-2');
    expect(next.childChatIdByToolCall['call-1']).toBe('chat-2');

    // Un segundo run.delegated del mismo padre se agrega, no reemplaza.
    const event2: RunEvent = { ...event, seq: 2, childRunId: 'run-3', childChatId: 'chat-3', toolCallId: undefined };
    const next2 = reduceRunEvent(next, event2);
    expect(next2.childRunsByParent['run-1']).toEqual(['run-2', 'run-3']);
  });

  it('guarda la última run.activity por run (rediseño del chat, línea viva de "Actividad")', () => {
    const state = emptyState() as RunStoreState;
    const first: RunEvent = { ...base, seq: 1, type: 'run.activity', phase: 'reading', label: 'Leyendo src/a.ts' };
    let next = reduceRunEvent(state, first);
    expect(next.activityByRun['run-1']).toEqual({ phase: 'reading', label: 'Leyendo src/a.ts', toolCallId: undefined, ts: 0 });

    const second: RunEvent = { ...base, ts: 10, seq: 2, type: 'run.activity', phase: 'running_command', label: 'Ejecutando: npm test', toolCallId: 'tc1' };
    next = reduceRunEvent(next, second);
    expect(next.activityByRun['run-1']).toEqual({ phase: 'running_command', label: 'Ejecutando: npm test', toolCallId: 'tc1', ts: 10 });
  });

  it('guarda context.built por chat con effectiveNumCtx y la resolución real del modelo', () => {
    const state = emptyState() as RunStoreState;
    const budget = {
      numCtx: 262144, effectiveNumCtx: 8192, reserveForResponse: 512,
      used: { system: 100, tools: 50, repoMap: 0, memory: 0, history: 200 }, totalUsed: 350, fits: true,
    };
    const modelResolution = {
      source: 'automatic_loaded' as const, contextMax: 32768,
      fitClass: 'tight' as const, fitQuality: 'estimated' as const,
    };
    const event: RunEvent = { ...base, seq: 1, type: 'context.built', budget, modelResolution };
    const next = reduceRunEvent(state, event);
    expect(next.contextBudgetByChat['chat-1']).toEqual(budget);
    expect(next.modelResolutionByChat['chat-1']).toEqual(modelResolution);

    const legacy = reduceRunEvent(next, { ...base, seq: 2, type: 'context.built', budget });
    expect(legacy.modelResolutionByChat['chat-1']).toBeUndefined();
  });

  it('guarda run.smallModelWarning una sola vez por run, sin pisarla en iteraciones siguientes', () => {
    const state = emptyState() as RunStoreState;
    const modelRef = { providerId: 'ollama' as const, name: 'qwen2.5:3b', locality: 'local' as const };
    const first: RunEvent = { ...base, seq: 1, type: 'run.smallModelWarning', modelRef, parameterSize: '3B' };
    let next = reduceRunEvent(state, first);
    expect(next.smallModelWarningByRun['run-1']).toEqual({ modelRef, parameterSize: '3B' });

    const second: RunEvent = {
      ...base, seq: 2, type: 'run.smallModelWarning',
      modelRef: { providerId: 'ollama', name: 'otro:1b', locality: 'local' }, parameterSize: '1B',
    };
    next = reduceRunEvent(next, second);
    // No se pisa: sigue siendo el primer aviso visto para este run.
    expect(next.smallModelWarningByRun['run-1']?.modelRef.name).toBe('qwen2.5:3b');
  });
});

describe('hydratePendingPermissions (punto 5 del encargo, tarjeta de permiso rehidratada)', () => {
  const request: PermissionRequest = {
    toolCallId: 'call-1', toolName: 'write_file', category: 'write', risk: 'medium',
    summary: 'Escribir src/a.ts', triggeredBy: 'reanudado tras reinicio', rememberOptions: [],
  };

  it('siembra runChatIds/runStates/toolCalls/pendingPermissions sin depender de un evento en vivo', () => {
    useRunStore.setState({ runStates: {}, runChatIds: {}, toolCalls: {}, pendingPermissions: {} });

    useRunStore.getState().hydratePendingPermissions([{ runId: 'run-1', chatId: 'chat-1', request }]);

    const state = useRunStore.getState();
    expect(state.runChatIds['run-1']).toBe('chat-1');
    expect(state.runStates['run-1']).toBe('awaiting_permission');
    expect(state.toolCalls['call-1']?.runId).toBe('run-1');
    expect(state.pendingPermissions['call-1']).toEqual(request);
  });

  it('no pisa un runState más específico si ya había uno vivo en memoria', () => {
    useRunStore.setState({
      runStates: { 'run-1': 'executing_tool' }, runChatIds: {}, toolCalls: {}, pendingPermissions: {},
    });

    useRunStore.getState().hydratePendingPermissions([{ runId: 'run-1', chatId: 'chat-1', request }]);

    expect(useRunStore.getState().runStates['run-1']).toBe('executing_tool');
  });

  it('lista vacía es un no-op (no dispara un set() innecesario)', () => {
    useRunStore.setState({ runChatIds: {} });
    useRunStore.getState().hydratePendingPermissions([]);
    expect(useRunStore.getState().runChatIds).toEqual({});
  });
});
