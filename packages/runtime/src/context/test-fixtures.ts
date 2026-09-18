// Fixtures sintéticas compartidas por los tests de este módulo — packages/runtime/src/context/test-fixtures.ts.
// No es *.test.ts a propósito (helper reutilizado por varios archivos de test del módulo).
import type { ChatMessage } from '@saurio/shared';
import type { AgentConfig, ContextPolicy } from '../agent/types.js';

export function makeContextPolicy(overrides: Partial<ContextPolicy> = {}): ContextPolicy {
  return {
    numCtx: 16_384,
    reserveForResponse: 2_200,
    repoMapTokens: 1_800,
    historyBudgetRatio: 0.5,
    maxReadLines: 250,
    maxSearchResults: 50,
    maxCommandLines: 100,
    compactAtRatio: 0.75,
    compactEveryTurns: 25,
    keepLastTurns: 4,
    fewShot: false,
    ...overrides,
  };
}

export function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'coder',
    role: 'coder',
    model: { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' },
    systemPrompt: 'Sos un agente de codificación de SaurioLLM. Respondé en español, código en inglés.',
    systemPromptHash: 'hash-1',
    allowedTools: ['list_files', 'search_code', 'read_file', 'read_output'],
    permissions: { preset: 'balanced', rules: [], terminalAllowlist: [] },
    workingDir: '/tmp/saurio-project',
    contextPolicy: makeContextPolicy(),
    memory: { readProjectMemory: true, writeProjectMemory: false },
    maxIterations: 25,
    temperature: 0.2,
    thinking: 'off',
    toolTransport: 'auto',
    defaultMode: 'agent',
    ...overrides,
  };
}

export function makeChatMessage(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return { role: 'user', content: 'mensaje sintético', ...overrides };
}

/** Genera N turnos user/assistant intercalados, con algunos mensajes 'tool' viejos para ejercitar
 *  la compactación de nivel 1 (stubs de tool results). */
export function makeSyntheticHistory(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push(makeChatMessage({ id: `user-${i}`, role: 'user', content: `pregunta del turno ${i} sobre el repo` }));
    messages.push(makeChatMessage({
      id: `tool-${i}`,
      role: 'tool',
      content: `salida de read_file en el turno ${i}: `.padEnd(400, 'x'),
      toolCallId: `call-${i}`,
      toolName: 'read_file',
    }));
    messages.push(makeChatMessage({ id: `assistant-${i}`, role: 'assistant', content: `respuesta del turno ${i}` }));
  }
  return messages;
}
