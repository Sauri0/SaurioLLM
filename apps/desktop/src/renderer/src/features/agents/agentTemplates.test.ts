import { describe, expect, it } from 'vitest';
import { agentTemplateDefaults, createStarterTeamInputs } from './agentTemplates.js';

describe('agentTemplates', () => {
  it('configura al Revisor como estricto y de solo lectura', () => {
    const reviewer = agentTemplateDefaults('reviewer');
    expect(reviewer.permissionPreset).toBe('strict');
    expect(reviewer.systemPrompt).toContain('solo lectura');
    expect(reviewer.allowedTools).not.toEqual(expect.arrayContaining([
      'edit_file', 'write_file', 'delete_file', 'run_command', 'delegate',
    ]));
  });

  it('habilita delegate solamente en la plantilla Director', () => {
    expect(agentTemplateDefaults('director').allowedTools).toContain('delegate');
    for (const templateId of ['programmer', 'tester', 'reviewer', 'custom'] as const) {
      expect(agentTemplateDefaults(templateId).allowedTools).not.toContain('delegate');
    }
  });

  it('incluye instrucciones editables específicas para cada rol del equipo', () => {
    for (const templateId of ['director', 'programmer', 'tester', 'reviewer'] as const) {
      expect(agentTemplateDefaults(templateId).systemPrompt.trim().length).toBeGreaterThan(20);
    }
  });

  it('crea el equipo base desde las mismas configuraciones que el editor', () => {
    const team = createStarterTeamInputs();
    for (const templateId of ['director', 'programmer', 'tester', 'reviewer'] as const) {
      const template = agentTemplateDefaults(templateId);
      const member = team.find((item) => item.name === template.name);
      expect(member).toMatchObject({
        role: template.role,
        description: template.description,
        systemPrompt: template.systemPrompt,
        permissionPreset: template.permissionPreset,
        allowedTools: [...template.allowedTools],
      });
    }
  });
});
