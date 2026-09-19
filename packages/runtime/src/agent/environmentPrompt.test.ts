// Tests de environmentPrompt.ts — punto 3 del encargo (carpeta real/SO/shell reales en el prompt).
import { describe, expect, it } from 'vitest';
import { buildEnvironmentPrompt } from './environmentPrompt.js';

describe('buildEnvironmentPrompt', () => {
  it('menciona la carpeta de trabajo real y que tiene acceso ahí', () => {
    const text = buildEnvironmentPrompt('C:\\Users\\test\\Proyecto');
    expect(text).toContain('C:\\Users\\test\\Proyecto');
    expect(text).toContain('Tenés acceso de lectura y escritura');
    expect(text).toContain('NO es una carpeta externa');
  });

  it('agrega la línea de carpeta vacía solo cuando se pide explícitamente', () => {
    const withEmpty = buildEnvironmentPrompt('/tmp/proj', true);
    expect(withEmpty).toContain('La carpeta está vacía');

    const withoutInfo = buildEnvironmentPrompt('/tmp/proj');
    expect(withoutInfo).not.toContain('La carpeta está vacía');
  });

  it('menciona el sistema operativo real del proceso', () => {
    const text = buildEnvironmentPrompt('/tmp/proj');
    const expected = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    expect(text).toContain(`Sistema operativo: ${expected}`);
  });

  it('en Windows nunca sugiere `mkdir -p` (sintaxis inválida en PowerShell)', () => {
    const text = buildEnvironmentPrompt('/tmp/proj');
    if (process.platform === 'win32') {
      expect(text).toContain('NO uses `mkdir -p`');
      expect(text).toContain('make_dir');
    }
  });
});
