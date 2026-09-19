import type { AgentRole, Recommendation } from '@saurio/shared';
import type { AgentTemplateId } from './agentTemplates.js';

export type { AgentTemplateId } from './agentTemplates.js';
export type AgentRecommendationUse = 'coding' | 'chat' | 'analysis' | 'vision';

export function recommendationUse(role: AgentRole, template: AgentTemplateId): AgentRecommendationUse {
  if (template === 'programmer' || role === 'coder') return 'coding';
  if (template === 'director' || template === 'tester' || template === 'reviewer') return 'analysis';
  if (role === 'lead' || role === 'reviewer' || role === 'explorer') return 'analysis';
  return 'chat';
}

/** Los agentes que ejecutan trabajo necesitan tools. Filtra antes de mostrar, aun cuando el uso
 * `analysis` del catálogo también contiene modelos puramente conversacionales. */
export function topAgentRecommendations(items: Recommendation[]): Recommendation[] {
  return items
    .filter((item) => item.locality === 'local' && !item.catalogEntry.cloud && item.catalogEntry.capabilities.tools)
    .slice(0, 3);
}
