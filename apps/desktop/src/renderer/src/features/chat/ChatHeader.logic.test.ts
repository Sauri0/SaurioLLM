// PRIORIDAD CERO punto 5 (bloqueo real: la cabecera mostraba "Chat sin título" / el id crudo del
// chat en vez de algo legible). Test de la lógica pura de `deriveDisplayTitle`, sin montar React
// (no hay infraestructura de render de componentes en apps/desktop/src/renderer todavía).
import { describe, expect, it } from 'vitest';
import { deriveDisplayTitle, displayedModelForChat } from './ChatHeader.js';
import { isModelInstalled } from './effectiveChatModel.js';
import type { Chat, ChatMessage, ModelRef } from '@saurio/shared';

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat_1', projectId: 'proj_1', agentId: 'agent_1', mode: 'agent',
    createdAt: 0, updatedAt: 0, archived: false, ...overrides,
  };
}

describe('deriveDisplayTitle', () => {
  it('usa chat.title si ya existe, sin tocar el primer mensaje', () => {
    expect(deriveDisplayTitle(makeChat({ title: 'Mi título' }), 'otra cosa')).toBe('Mi título');
  });

  it('sin título, deriva del primer mensaje del usuario (una sola línea)', () => {
    expect(deriveDisplayTitle(makeChat(), 'arreglá\nel bug de suma')).toBe('arreglá el bug de suma');
  });

  it('trunca mensajes largos con elipsis', () => {
    const long = 'a'.repeat(80);
    const title = deriveDisplayTitle(makeChat(), long);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThan(60);
  });

  it('sin chat ni mensaje -> "Chat nuevo" (nunca el id crudo del chat)', () => {
    expect(deriveDisplayTitle(undefined, undefined)).toBe('Chat nuevo');
    expect(deriveDisplayTitle(makeChat(), undefined)).toBe('Chat nuevo');
    expect(deriveDisplayTitle(makeChat(), '   ')).toBe('Chat nuevo');
  });
});

describe('displayedModelForChat', () => {
  const selected: ModelRef = { providerId: 'ollama', name: 'seleccionado', locality: 'local' };
  const effective: ModelRef = { providerId: 'ollama', name: 'efectivo-por-hardware', locality: 'local' };
  const assistant = (modelRef: ModelRef): ChatMessage => ({
    id: `m-${modelRef.name}`, role: 'assistant', content: 'ok', truncated: false, modelRef,
  });

  it('auto no muestra un placeholder antes del primer run y luego muestra el efectivo real', () => {
    const chat = makeChat({ modelSelection: 'auto', modelRef: undefined });
    expect(displayedModelForChat(chat, [])).toBeUndefined();
    expect(displayedModelForChat(chat, [assistant(effective)])).toEqual(effective);
  });

  it('explicit conserva la elección aunque haya mensajes de otro modelo', () => {
    expect(displayedModelForChat(makeChat({ modelSelection: 'explicit', modelRef: selected }), [assistant(effective)]))
      .toEqual(selected);
  });

  it('valida instalación por proveedor y nombre, no sólo por el tag', () => {
    const sameNameOtherProvider: ModelRef = { providerId: 'lan', name: selected.name, locality: 'local' };
    expect(isModelInstalled(selected, [{
      ref: sameNameOtherProvider, digest: 'sha256:x', sizeBytes: 1,
      family: 'test', parameterSize: '1B', quantization: 'Q4',
      capabilities: { tools: true, thinking: false, vision: false, embedding: false },
    }])).toBe(false);
  });
});
