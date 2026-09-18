import { describe, expect, it } from 'vitest';
import { formatPct, metricBadgeClass } from './format.js';

describe('formatPct', () => {
  it('formatea con un decimal y %', () => {
    expect(formatPct(12.345)).toBe('12.3%');
    expect(formatPct(0)).toBe('0.0%');
  });
});

describe('metricBadgeClass', () => {
  it('devuelve la calidad tal cual para usar como className', () => {
    expect(metricBadgeClass('measured')).toBe('measured');
    expect(metricBadgeClass('unavailable')).toBe('unavailable');
  });
});
