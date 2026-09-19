// Tests puros de FilesPanel (sin renderizar React: no hay @testing-library en el monorepo —
// missingDeps). apps/desktop/src/renderer/src/features/files/FilesPanel.test.ts.
//
// Integración: `files:tree` ahora es un canal tipado (packages/shared/src/ipc.ts) validado por zod
// en `invoke()`, así que ya no hace falta un type guard manual (`isFileTreeArray`) en este módulo —
// se cubre acá el único helper puro que le queda a FilesPanel: `formatSize`.
import { describe, expect, it } from 'vitest';
import { acceptsFileResponse, fileTreeRowKey, formatSize } from './FilesPanel.js';

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

describe('respuestas asincrónicas del panel', () => {
  it('descarta árbol o contenido que pertenece a otro proyecto/selección', () => {
    expect(acceptsFileResponse('project-b', 'project-a', null)).toBe(false);
    expect(acceptsFileResponse('project-a', 'project-a', 'a.ts', 'b.ts')).toBe(false);
    expect(acceptsFileResponse('project-a', 'project-a', 'a.ts', 'a.ts')).toBe(true);
  });

  it('aísla las claves de filas entre proyectos para no heredar expansión', () => {
    expect(fileTreeRowKey('project-a', 'src')).not.toBe(fileTreeRowKey('project-b', 'src'));
  });
});
