// PRIORIDAD CERO punto 5 (bloqueo real: la cabecera mostraba "Chat sin título" / el id crudo del
// chat en vez de algo legible). Test de la lógica pura de `deriveDisplayTitle`, sin montar React
// (no hay infraestructura de render de componentes en apps/desktop/src/renderer todavía).
import { describe, expect, it } from 'vitest';
import { deriveDisplayTitle } from './ChatHeader.js';
import type { Chat } from '@saurio/shared';

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
