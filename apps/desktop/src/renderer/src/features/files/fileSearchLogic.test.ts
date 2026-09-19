import { describe, expect, it } from 'vitest';
import { fileSearchOffset } from './fileSearchLogic.js';

describe('fileSearchOffset', () => {
  it('calcula páginas de 20 sin permitir offsets inválidos', () => {
    expect(fileSearchOffset(0, 20)).toBe(0);
    expect(fileSearchOffset(1, 20)).toBe(20);
    expect(fileSearchOffset(-2, 20)).toBe(0);
    expect(fileSearchOffset(6000, 20)).toBe(100000);
  });
});
