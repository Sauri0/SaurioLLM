import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi.js';

describe('stripAnsi', () => {
  it('quita colores SGR simples', () => {
    expect(stripAnsi('[32mok[0m')).toBe('ok');
  });

  it('quita códigos combinados (negrita + color)', () => {
    expect(stripAnsi('[1;31mfalló[0m')).toBe('falló');
  });

  it('deja el texto sin secuencias intacto', () => {
    expect(stripAnsi('sin ansi\nsegunda línea')).toBe('sin ansi\nsegunda línea');
  });

  it('undefined/"" pasan igual', () => {
    expect(stripAnsi(undefined)).toBeUndefined();
    expect(stripAnsi('')).toBe('');
  });

  it('quita secuencias de cursor/borrado de pantalla', () => {
    expect(stripAnsi('[2K[1Gcargando...')).toBe('cargando...');
  });
});
