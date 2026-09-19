import { describe, expect, it } from 'vitest';
import {
  acceptsCollaboratorResponse, collaboratorControlsDisabled, collaboratorScope,
} from './ChatCollaborators.js';

describe('ChatCollaborators — aislamiento de cargas', () => {
  it('rechaza respuestas tardías de otro chat aunque compartan proyecto', () => {
    const chatA = collaboratorScope('project', 'chat-a');
    const chatB = collaboratorScope('project', 'chat-b');
    expect(acceptsCollaboratorResponse(2, 1, chatB, chatA)).toBe(false);
    expect(acceptsCollaboratorResponse(2, 2, chatB, chatA)).toBe(false);
    expect(acceptsCollaboratorResponse(2, 2, chatB, chatB)).toBe(true);
  });

  it('bloquea controles hasta una carga correcta y mientras guarda o el run está activo', () => {
    const scope = collaboratorScope('project', 'chat');
    expect(collaboratorControlsDisabled(undefined, scope, false, false)).toBe(true);
    expect(collaboratorControlsDisabled(collaboratorScope('project', 'otro'), scope, false, false)).toBe(true);
    expect(collaboratorControlsDisabled(scope, scope, true, false)).toBe(true);
    expect(collaboratorControlsDisabled(scope, scope, false, true)).toBe(true);
    expect(collaboratorControlsDisabled(scope, scope, false, false)).toBe(false);
  });
});
