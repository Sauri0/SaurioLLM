import { describe, expect, it } from 'vitest';
import { regenerateRunIdForMessage } from './messageActions.js';

describe('regenerateRunIdForMessage', () => {
  it('habilita regenerar únicamente una respuesta cerrada con procedencia real', () => {
    expect(regenerateRunIdForMessage({ id: 'assistant-1', role: 'assistant', content: 'Listo.', originRunId: 'run-1' }, false))
      .toBe('run-1');
  });

  it('no ofrece regenerar a mensajes sin run, de otro rol ni durante streaming', () => {
    expect(regenerateRunIdForMessage({ id: 'old', role: 'assistant', content: 'Histórico' }, false)).toBeUndefined();
    expect(regenerateRunIdForMessage({ id: 'user-1', role: 'user', content: 'Hola', originRunId: 'run-1' }, false)).toBeUndefined();
    expect(regenerateRunIdForMessage({ id: 'live', role: 'assistant', content: 'Escribiendo', originRunId: 'run-1' }, true)).toBeUndefined();
  });
});
