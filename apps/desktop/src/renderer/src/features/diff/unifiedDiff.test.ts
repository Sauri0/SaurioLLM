import { describe, expect, it } from 'vitest';
import { splitUnifiedDiff } from './unifiedDiff.js';

describe('splitUnifiedDiff', () => {
  it('separa contexto, borrados y agregados en antes/después', () => {
    const unified = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' const c = a + b;',
    ].join('\n');
    const { before, after } = splitUnifiedDiff(unified);
    expect(before).toBe('const a = 1;\nconst b = 2;\nconst c = a + b;');
    expect(after).toBe('const a = 1;\nconst b = 3;\nconst c = a + b;');
  });

  it('devuelve strings vacíos para un diff vacío', () => {
    expect(splitUnifiedDiff('')).toEqual({ before: '', after: '' });
  });
});
