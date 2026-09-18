import { describe, expect, it } from 'vitest';
import { fitClassLabel, formatBytes, qualitySuffix } from './format.js';

describe('formatBytes', () => {
  it('formatea GB con un decimal', () => {
    expect(formatBytes(5.76 * 1024 ** 3)).toBe('5.8 GB');
  });
  it('formatea bytes chicos sin decimales', () => {
    expect(formatBytes(512)).toBe('512 B');
  });
  it('devuelve — para valores inválidos', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('fitClassLabel', () => {
  it('mapea las cuatro clases', () => {
    expect(fitClassLabel('fits_gpu')).toBe('entra en GPU');
    expect(fitClassLabel('no_fit')).toBe('no entra');
  });
});

describe('qualitySuffix', () => {
  it('etiqueta estimated y unavailable', () => {
    expect(qualitySuffix('estimated')).toBe('estimado');
    expect(qualitySuffix('unavailable')).toBe('no disponible');
  });
  it('measured sin fecha da "medido"; con fecha da "probado el ..."', () => {
    expect(qualitySuffix('measured')).toBe('medido');
    expect(qualitySuffix('measured', Date.UTC(2026, 8, 18))).toMatch(/probado el/);
  });
});
