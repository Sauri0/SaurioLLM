import { describe, expect, it } from 'vitest';
import { classifyFsEvent } from './files.js';

describe('files watcher event classification', () => {
  it('trata rename de una ruta existente como modificación/creación', () => {
    expect(classifyFsEvent('rename', __filename)).toBe('modified');
  });

  it('trata rename de una ruta inexistente como borrado', () => {
    expect(classifyFsEvent('rename', `${__filename}.missing-${Date.now()}`)).toBe('removed');
  });

  it('mantiene change como modificación', () => {
    expect(classifyFsEvent('change', `${__filename}.missing`)).toBe('modified');
  });
});
