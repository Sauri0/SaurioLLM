import { describe, expect, it } from 'vitest';
import { recommendedModelTarget } from './onboardingSelection.js';

describe('recommendedModelTarget', () => {
  it('prioriza el chat activo por sobre el borrador del proyecto', () => {
    expect(recommendedModelTarget('chat_actual', 'proyecto_actual')).toEqual({ kind: 'chat', chatId: 'chat_actual' });
  });

  it('usa el borrador del proyecto activo si todavía no hay chat', () => {
    expect(recommendedModelTarget(undefined, 'proyecto_actual')).toEqual({ kind: 'project-draft', projectId: 'proyecto_actual' });
  });

  it('abre el chat personal sin elegir un proyecto reciente arbitrariamente', () => {
    expect(recommendedModelTarget(undefined, undefined)).toEqual({ kind: 'personal-chat' });
  });
});
