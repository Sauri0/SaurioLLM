import { describe, expect, it } from 'vitest';
import { DegenerationDetector } from './DegenerationDetector.js';

describe('DegenerationDetector (doc 05 §2.4 paso 18)', () => {
  it('no dispara con texto normal', () => {
    const d = new DegenerationDetector();
    expect(d.push('Voy a leer el archivo src/index.ts para entender la estructura del proyecto. ')).toBe(false);
    expect(d.push('Ahora voy a buscar la función principal usando search_code con el término "main".')).toBe(false);
  });

  it('dispara cuando una ventana de 50 caracteres se repite 4+ veces seguidas', () => {
    const d = new DegenerationDetector();
    const window = 'x'.repeat(50);
    expect(d.push(window)).toBe(false);
    expect(d.push(window)).toBe(false);
    expect(d.push(window)).toBe(false);
    expect(d.push(window)).toBe(true);
  });

  it('3 repeticiones no alcanzan (mínimo 4)', () => {
    const d = new DegenerationDetector();
    const window = 'y'.repeat(50);
    d.push(window);
    d.push(window);
    expect(d.push(window)).toBe(false);
  });

  it('reset() limpia el buffer acumulado', () => {
    const d = new DegenerationDetector();
    const window = 'z'.repeat(50);
    d.push(window);
    d.push(window);
    d.push(window);
    d.reset();
    expect(d.push(window)).toBe(false);
  });
});
