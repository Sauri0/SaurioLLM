import { describe, expect, it } from 'vitest';
import type { Recommendation } from '@saurio/shared';
import { recommendationUse, topAgentRecommendations } from './agentRecommendations.js';

describe('agentRecommendations', () => {
  it('mapea roles de coordinación a usos con herramientas', () => {
    expect(recommendationUse('lead', 'director')).toBe('analysis');
    expect(recommendationUse('coder', 'programmer')).toBe('coding');
    expect(recommendationUse('custom', 'tester')).toBe('analysis');
    expect(recommendationUse('reviewer', 'reviewer')).toBe('analysis');
  });

  it('nunca muestra nube ni modelos sin tools y limita a tres', () => {
    const make = (name: string, tools = true, cloud = false): Recommendation => ({
      catalogEntry: { name, tag: 'x', sizeBytes: 1, contextMax: 8192, suggestedUse: ['analysis'], capabilities: { tools, thinking: false, vision: false, embedding: false }, ...(cloud ? { cloud: true } : {}) },
      fitClass: 'fits_gpu', locality: cloud ? 'cloud' : 'local', speedHint: 'fast', usesCpuOffload: false,
    });
    expect(topAgentRecommendations([make('a'), make('cloud', true, true), make('no-tools', false), make('b'), make('c'), make('d')]).map((item) => item.catalogEntry.name))
      .toEqual(['a', 'b', 'c']);
  });
});
