// Tests puros de FilesPanel (sin renderizar React: no hay @testing-library en el monorepo —
// missingDeps). apps/desktop/src/renderer/src/features/files/FilesPanel.test.ts.
//
// Integración: `files:tree` ahora es un canal tipado (packages/shared/src/ipc.ts) validado por zod
// en `invoke()`, así que ya no hace falta un type guard manual (`isFileTreeArray`) en este módulo —
// se cubre acá el único helper puro que le queda a FilesPanel: `formatSize`.
import { describe, expect, it } from 'vitest';
import { formatSize } from './FilesPanel.js';

describe('formatSize', () => {
  it('devuelve cadena vacía sin tamaño', () => {
    expect(formatSize(undefined)).toBe('');
  });

  it('formatea bytes, KB y MB', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
