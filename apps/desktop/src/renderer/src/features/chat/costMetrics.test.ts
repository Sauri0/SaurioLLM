import { describe, expect, it } from 'vitest';
import type { ResponseMetrics } from '@saurio/shared';
import { formatUsd, summarizeCosts } from './costMetrics.js';

function metric(overrides: Partial<ResponseMetrics>): ResponseMetrics {
  return { quality: 'estimated', ...overrides };
}

describe('costMetrics', () => {
  it('suma importes reportados, incluido USD 0, sin confundirlos con estimados', () => {
    expect(summarizeCosts([
      metric({ costUsd: 0, costSource: 'reported' }),
      metric({ costUsd: 0.0025, costSource: 'reported' }),
      metric({ costUsd: 0.1, costSource: 'estimated' }),
    ])).toEqual({ reportedUsd: 0.0025, estimatedUsd: 0.1, reportedResponses: 2, estimatedResponses: 1, unavailableResponses: 0 });
  });

  it('trata métricas legacy o sin costo como desconocidas, nunca como USD 0', () => {
    expect(summarizeCosts([
      metric({}),
      metric({ costSource: 'unavailable' }),
      metric({ costUsd: 12 }),
    ])).toMatchObject({ reportedUsd: 0, estimatedUsd: 0, unavailableResponses: 3 });
  });

  it('conserva importes pequeños al formatear USD', () => {
    expect(formatUsd(0)).toBe('USD 0');
    expect(formatUsd(0.00000001)).toBe('USD 0.00000001');
  });
});
