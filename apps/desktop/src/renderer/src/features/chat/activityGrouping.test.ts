import { describe, expect, it } from 'vitest';
import type { ChatMessage, Checkpoint, ToolCallRecord } from '@saurio/shared';
import { countTurnSteps, groupMessagesIntoTurns, turnElapsedMs } from './activityGrouping.js';

function toolCall(overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, 'id' | 'runId' | 'messageId'>): ToolCallRecord {
  return {
    iteration: 0, toolName: 'read_file', args: {}, argsHash: 'h',
    category: 'read', risk: 'low', transport: 'native', status: 'done',
    ...overrides,
  } as ToolCallRecord;
}

function userMsg(id: string, content: string): ChatMessage {
  return { id, role: 'user', content };
}
function assistantMsg(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content: '', ...overrides };
}

describe('groupMessagesIntoTurns', () => {
  it('un turno de solo texto (sin tool calls) no tiene runId ni steps, y el texto es el final', () => {
    const messages = [userMsg('u1', 'hola'), assistantMsg('a1', { content: 'hola, ¿en qué ayudo?' })];
    const turns = groupMessagesIntoTurns(messages, {}, []);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.steps).toEqual([]);
    expect(turns[0]!.runId).toBeUndefined();
    expect(turns[0]!.finalMessage?.content).toBe('hola, ¿en qué ayudo?');
  });

  it('un mensaje assistant vacío (solo tool calls) no queda como bubble propia: sus tool calls van a steps', () => {
    const messages = [
      userMsg('u1', 'leé el archivo'),
      assistantMsg('a1', { content: '' }), // "burbuja AGENTE vacía" que el rediseño elimina
      assistantMsg('a2', { content: 'Ya lo leí, dice X.' }),
    ];
    const toolCalls: Record<string, ToolCallRecord> = {
      tc1: toolCall({ id: 'tc1', runId: 'run-1', messageId: 'a1', startedAt: 10, finishedAt: 20 }),
    };
    const turns = groupMessagesIntoTurns(messages, toolCalls, []);
    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0]).toMatchObject({ kind: 'tool', toolCall: { id: 'tc1' } });
    expect(turn.finalMessage?.content).toBe('Ya lo leí, dice X.');
    expect(turn.runId).toBe('run-1');
  });

  it('el thinking de CUALQUIER mensaje del turno (incluido el final) se agrega como paso interno', () => {
    const messages = [
      userMsg('u1', 'explicame X'),
      assistantMsg('a1', { content: 'X es así.', thinking: 'razonando sobre X' }),
    ];
    const turns = groupMessagesIntoTurns(messages, {}, []);
    expect(turns[0]!.steps).toEqual([{ kind: 'thinking', messageId: 'a1', text: 'razonando sobre X' }]);
    expect(turns[0]!.finalMessage?.content).toBe('X es así.');
  });

  it('separa turnos por cada mensaje de usuario, cada uno con sus propios checkpoints por runId', () => {
    const messages = [
      userMsg('u1', 'primero'),
      assistantMsg('a1', { content: 'hecho 1' }, ),
      userMsg('u2', 'segundo'),
      assistantMsg('a2', { content: '' }),
      assistantMsg('a3', { content: 'hecho 2' }),
    ];
    const toolCalls: Record<string, ToolCallRecord> = {
      tc1: toolCall({ id: 'tc1', runId: 'run-2', messageId: 'a2', category: 'write' }),
    };
    const checkpoints: Checkpoint[] = [
      { id: 'cp1', runId: 'run-2', chatId: 'c1', kind: 'tool', files: [], stats: { files: 1, added: 1, removed: 0 }, status: 'active' },
      { id: 'cp-other', runId: 'run-other', chatId: 'c1', kind: 'tool', files: [], stats: { files: 1, added: 1, removed: 0 }, status: 'active' },
    ];
    const turns = groupMessagesIntoTurns(messages, toolCalls, checkpoints);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.checkpoints).toEqual([]);
    expect(turns[1]!.checkpoints.map((c) => c.id)).toEqual(['cp1']);
  });

  it('turno en curso (mensaje vacío al final) queda sin finalMessage — el llamador sabe que sigue vivo', () => {
    const messages = [userMsg('u1', 'hacé algo'), assistantMsg('a1', { content: '' })];
    const turns = groupMessagesIntoTurns(messages, {}, []);
    expect(turns[0]!.finalMessage).toBeUndefined();
    // El mensaje vacío queda registrado como paso de texto (vacío) en vez de perderse.
    expect(turns[0]!.steps).toEqual([{ kind: 'text', messageId: 'a1', text: '' }]);
  });

  it('ignora mensajes role system/tool para armar turnos (no generan bubble propia)', () => {
    const messages: ChatMessage[] = [
      { id: 's1', role: 'system', content: 'contexto' },
      userMsg('u1', 'hola'),
      assistantMsg('a1', { content: 'listo' }),
    ];
    const turns = groupMessagesIntoTurns(messages, {}, []);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userMessage?.id).toBe('u1');
  });
});

describe('countTurnSteps', () => {
  it('cuenta lecturas, comandos y ediciones por separado, y detecta uso de thinking', () => {
    const steps = [
      { kind: 'thinking' as const, messageId: 'a1', text: 'pensando' },
      { kind: 'tool' as const, toolCall: toolCall({ id: 't1', runId: 'r1', messageId: 'a1', category: 'read' }) },
      { kind: 'tool' as const, toolCall: toolCall({ id: 't2', runId: 'r1', messageId: 'a1', category: 'terminal' }) },
      { kind: 'tool' as const, toolCall: toolCall({ id: 't3', runId: 'r1', messageId: 'a1', category: 'write' }) },
    ];
    const counts = countTurnSteps(steps);
    expect(counts).toEqual({ reads: 1, commands: 1, edits: 1, other: 0, toolCallCount: 3, usedThinking: true });
  });
});

describe('turnElapsedMs', () => {
  it('calcula el rango entre el primer startedAt y el último finishedAt', () => {
    const steps = [
      { kind: 'tool' as const, toolCall: toolCall({ id: 't1', runId: 'r1', messageId: 'a1', startedAt: 1000, finishedAt: 1200 }) },
      { kind: 'tool' as const, toolCall: toolCall({ id: 't2', runId: 'r1', messageId: 'a1', startedAt: 1300, finishedAt: 1900 }) },
    ];
    expect(turnElapsedMs(steps)).toBe(900);
  });

  it('undefined si ningún step tiene timestamps', () => {
    expect(turnElapsedMs([{ kind: 'thinking', messageId: 'a1', text: 'x' }])).toBeUndefined();
  });
});
