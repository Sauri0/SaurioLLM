import type { AgentCreateInput } from '@saurio/shared';
import { BUILTIN_TOOL_CATALOG, DELEGATE_TOOL } from './toolCatalog.js';

export type AgentTemplateId = 'director' | 'programmer' | 'tester' | 'reviewer' | 'custom';

export interface AgentTemplateDefinition {
  value: AgentTemplateId;
  label: string;
  name: string;
  role: AgentCreateInput['role'];
  description: string;
  systemPrompt: string;
  allowedTools: readonly string[];
  permissionPreset: AgentCreateInput['permissionPreset'];
}

const ALL_BUILTIN_TOOLS = BUILTIN_TOOL_CATALOG.map((tool) => tool.name);
const READ_ONLY_TOOLS = ['list_files', 'search_code', 'read_file', 'read_output', 'task_update', 'finish'] as const;

export const AGENT_TEMPLATE_OPTIONS: readonly AgentTemplateDefinition[] = [
  {
    value: 'director',
    label: 'Director',
    name: 'Director',
    role: 'lead',
    description: 'Coordina el trabajo con los colaboradores habilitados.',
    systemPrompt: 'Sos Director. Coordiná el trabajo y delegá únicamente a los colaboradores habilitados del chat. Integrá sus resultados, verificá los puntos críticos y entregá una respuesta final concreta.',
    allowedTools: ['list_files', 'search_code', 'read_file', 'task_update', 'finish', DELEGATE_TOOL.name],
    permissionPreset: 'balanced',
  },
  {
    value: 'programmer',
    label: 'Programador',
    name: 'Programador',
    role: 'coder',
    description: 'Implementa cambios y los verifica.',
    systemPrompt: 'Sos Programador. Leé el código relevante antes de editar, implementá cambios acotados y verificá el comportamiento con pruebas apropiadas. Informá los resultados ejecutados y cualquier límite pendiente.',
    allowedTools: ALL_BUILTIN_TOOLS,
    permissionPreset: 'balanced',
  },
  {
    value: 'tester',
    label: 'Tester',
    name: 'Tester',
    role: 'custom',
    description: 'Prueba comportamientos y reporta evidencia.',
    systemPrompt: 'Sos Tester. Verificá criterios de aceptación con pruebas reproducibles. Reportá evidencia concreta, regresiones y límites; no afirmes resultados que no ejecutaste.',
    allowedTools: ['list_files', 'search_code', 'read_file', 'read_output', 'run_command', 'task_update', 'finish'],
    permissionPreset: 'balanced',
  },
  {
    value: 'reviewer',
    label: 'Revisor',
    name: 'Revisor',
    role: 'reviewer',
    description: 'Revisa cambios en modo de solo lectura y señala problemas accionables.',
    systemPrompt: 'Sos Revisor de solo lectura. Inspeccioná el código y la evidencia disponible sin modificar archivos ni ejecutar comandos. Priorizá errores, riesgos y criterios incumplidos con referencias concretas.',
    allowedTools: READ_ONLY_TOOLS,
    permissionPreset: 'strict',
  },
  {
    value: 'custom',
    label: 'Personalizado',
    name: '',
    role: 'custom',
    description: '',
    systemPrompt: '',
    allowedTools: ALL_BUILTIN_TOOLS,
    permissionPreset: 'balanced',
  },
];

export function agentTemplateDefaults(templateId: AgentTemplateId): AgentTemplateDefinition {
  const template = AGENT_TEMPLATE_OPTIONS.find((item) => item.value === templateId)
    ?? AGENT_TEMPLATE_OPTIONS[AGENT_TEMPLATE_OPTIONS.length - 1]!;
  return { ...template, allowedTools: [...template.allowedTools] };
}

export function createStarterTeamInputs(): AgentCreateInput[] {
  return (['director', 'programmer', 'tester', 'reviewer'] as const).map((templateId) => {
    const template = agentTemplateDefaults(templateId);
    return {
      name: template.name,
      role: template.role,
      description: template.description,
      systemPrompt: template.systemPrompt,
      allowedTools: [...template.allowedTools],
      permissionPreset: template.permissionPreset,
      modelMode: 'auto',
      memoryScope: 'global',
    };
  });
}
