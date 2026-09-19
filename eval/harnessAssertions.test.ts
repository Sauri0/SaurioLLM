import { describe, expect, it } from 'vitest';
import { checkExportedSumFunction } from './harnessAssertions.js';

describe('checkExportedSumFunction', () => {
  it('acepta la corrección directa y su forma con operandos conmutados', () => {
    const direct = checkExportedSumFunction(
      'export function suma(a: number, b: number): number { return a + b; }',
    );
    const commuted = checkExportedSumFunction(
      'export function suma(a: number, b: number): number { return (b + a); }',
    );

    expect(direct.ok).toBe(true);
    expect(commuted.ok).toBe(true);
    expect(direct.examples).toEqual([
      'suma(2, 3) = 5',
      'suma(-4, 7) = 3',
      'suma(-4, -6) = -10',
    ]);
  });

  it('rechaza el bug original y un valor constante que sólo acertaría un ejemplo', () => {
    expect(checkExportedSumFunction(
      'export function suma(a: number, b: number): number { return a - b; }',
    ).ok).toBe(false);
    expect(checkExportedSumFunction(
      'export function suma(a: number, b: number): number { return 5; }',
    ).ok).toBe(false);
  });

  it('rechaza la edición observada: deja la exportación rota y agrega otra suma duplicada', () => {
    const observed = [
      'export function suma(a: number, b: number): number {',
      '  return a - b;',
      '}',
      'function suma(a: number, b: number): number {',
      '  return a + b;',
      '}',
    ].join('\n');

    const result = checkExportedSumFunction(observed);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('una única función suma');
  });

  it('rechaza perder la exportación o cambiar la firma numérica original', () => {
    expect(checkExportedSumFunction(
      'function suma(a: number, b: number): number { return a + b; }',
    ).reason).toContain('dejó de estar exportada');
    expect(checkExportedSumFunction(
      'export function suma(a: string, b: string): string { return a + b; }',
    ).reason).toContain('firma original');
  });
});
