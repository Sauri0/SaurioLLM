import { describe, expect, it } from 'vitest';
import type { Chat, ChatMessage, ModelRef } from '@saurio/shared';
import { statusContextLabel, statusModelRef } from './StatusBar.js';

const draft: ModelRef = { providerId: 'ollama', name: 'borrador:3b', locality: 'local' };
const active: ModelRef = { providerId: 'openrouter', name: 'modelo-remoto', locality: 'cloud' };
const chat: Chat = {
  id: 'chat-activo', projectId: 'project-1', agentId: 'agent_builtin_lead', mode: 'agent', modelRef: active,
  createdAt: 1, updatedAt: 1, archived: false,
};

describe('StatusBar', () => {
  it('muestra el modelo persistido del chat abierto, no el borrador del proyecto', () => {
    expect(statusModelRef('chat-activo', [chat], draft)).toEqual(active);
  });

  it('solo usa el borrador cuando todavía no hay un chat activo', () => {
    expect(statusModelRef(null, [chat], draft)).toEqual(draft);
  });

  it('en auto no muestra el borrador y usa el modelo efectivo del ultimo mensaje asistente', () => {
    const autoChat: Chat = { ...chat, modelRef: undefined, modelSelection: 'auto' };
    const earlier: ChatMessage = { id: 'm1', role: 'assistant', content: 'uno', truncated: false, modelRef: draft };
    const latest: ChatMessage = { id: 'm2', role: 'assistant', content: 'dos', truncated: false, modelRef: active };
    expect(statusModelRef(autoChat.id, [autoChat], draft, [])).toBeUndefined();
    expect(statusModelRef(autoChat.id, [autoChat], draft, [earlier, latest])).toEqual(active);
  });

  it('muestra un límite reportado sin advertencia provisional', () => {
    expect(statusContextLabel({ totalUsed: 3900, effectiveNumCtx: 8192, numCtx: 40960, contextLimitSource: 'reported' }, 1200))
      .toBe('Contexto ≈ 3.9k / 8k tokens');
  });

  it('marca el límite provisional aunque conserve el par efectivo de contexto', () => {
    expect(statusContextLabel({ totalUsed: 3900, effectiveNumCtx: 8192, numCtx: 40960, contextLimitSource: 'provisional' }, 1200))
      .toBe('Contexto ≈ 3.9k / 8k tokens (provisional; límite sin confirmar)');
  });

  it('trata los eventos viejos sin fuente como límite sin confirmar', () => {
    expect(statusContextLabel({ totalUsed: 3900, effectiveNumCtx: 8192, numCtx: 40960 }, 1200))
      .toBe('Contexto ≈ 3.9k / 8k tokens (límite sin confirmar)');
  });

  it('indica que el contexto todavía se calcula antes del primer envío', () => {
    expect(statusContextLabel(undefined, undefined)).toBe('Contexto: se calcula al enviar');
  });
});
