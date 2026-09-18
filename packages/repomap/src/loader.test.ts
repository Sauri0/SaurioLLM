// Test de humo del loader; se salta si no hay grammars en resources/grammars (doc 02 §5).
import { afterEach, describe, expect, it } from 'vitest';
import { getGrammarsDir, hasGrammar, loadGrammar, setGrammarsDir } from './loader.js';

const hasTypescriptGrammar = hasGrammar('typescript');

describe.skipIf(!hasTypescriptGrammar)('repomap/loader', () => {
  it('carga la grammar de typescript desde resources/grammars', async () => {
    const language = await loadGrammar('typescript');
    expect(language).not.toBeNull();
  });
});

describe('repomap/loader (siempre)', () => {
  it('resuelve getGrammarsDir() de forma determinística por default (sin setGrammarsDir)', () => {
    expect(getGrammarsDir()).toContain('resources');
    expect(getGrammarsDir()).toContain('grammars');
  });

  // Punto 5 del encargo (doc 16): apps/desktop inyecta la carpeta real en vez de derivarla de
  // import.meta.url (se rompe una vez que electron-vite bundlea main en un único archivo).
  describe('setGrammarsDir', () => {
    afterEach(() => setGrammarsDir(undefined)); // vuelve al default entre tests

    it('hasGrammar()/loadGrammar() usan la carpeta inyectada en vez del default', () => {
      setGrammarsDir('/una/carpeta/que/no/existe');
      expect(hasGrammar('typescript')).toBe(false);
    });
  });
});
