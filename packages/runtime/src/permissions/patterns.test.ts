// Tests de patrones (glob de paths y prefijo de tokens de comandos) — doc 06 §4.
import { describe, expect, it } from 'vitest';
import {
  matchCommandPattern, matchGlob, normalizeRelPath, suggestCommandPattern, suggestPathPattern, tokenize,
} from './patterns.js';

describe('normalizeRelPath', () => {
  it('convierte separadores de Windows y quita el prefijo ./', () => {
    expect(normalizeRelPath('src\\app\\router.ts')).toBe('src/app/router.ts');
    expect(normalizeRelPath('./src/app.ts')).toBe('src/app.ts');
  });
});

describe('matchGlob', () => {
  const cases: [pattern: string, path: string, expected: boolean][] = [
    ['src/**', 'src/app/router.ts', true],
    ['src/**', 'src/app.ts', true],
    ['src/**', 'test/app.ts', false],
    ['.env*', '.env', true],
    ['.env*', '.env.local', true],
    ['.env*', 'config/.env', false],
    ['*.pem', 'server.pem', true],
    ['*.pem', 'certs/server.pem', false],
    ['!.env*', '.env', true],   // matching ignora el '!' (semántica de deny vive en el engine)
  ];
  it.each(cases)('matchGlob(%s, %s) === %s', (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected);
  });
});

describe('matchCommandPattern', () => {
  const cases: [pattern: string, tokens: string[], expected: boolean][] = [
    ['npm test', ['npm', 'test'], true],
    ['npm test', ['npm', 'test', '--', '--watch'], false],
    ['npm run *', ['npm', 'run', 'build'], true],
    ['npm run *', ['npm', 'run', 'lint'], true],
    ['npm run *', ['npm', 'test'], false],
    ['git status', ['git', 'status'], true],
    ['git status', ['git', 'status', '-s'], false],
  ];
  it.each(cases)('matchCommandPattern(%s, %j) === %s', (pattern, tokens, expected) => {
    expect(matchCommandPattern(pattern, tokens)).toBe(expected);
  });
});

describe('tokenize', () => {
  it('respeta comillas simples y dobles', () => {
    expect(tokenize('git commit -m "fix: bug"')).toEqual(['git', 'commit', '-m', 'fix: bug']);
    expect(tokenize("echo 'hello world'")).toEqual(['echo', 'hello world']);
  });
});

describe('suggestCommandPattern', () => {
  it('sugiere el comando exacto, sin comodines (doc §4)', () => {
    expect(suggestCommandPattern(['npm', 'test'])).toBe('npm test');
  });
  it('cita tokens con espacios', () => {
    expect(suggestCommandPattern(['git', 'commit', '-m', 'fix: bug'])).toBe('git commit -m "fix: bug"');
  });
});

describe('suggestPathPattern', () => {
  it('sugiere el directorio contenedor + /** (doc §4)', () => {
    expect(suggestPathPattern('src/app/router.ts')).toBe('src/app/**');
  });
  it('usa el propio nombre exacto para un archivo en la raíz del workspace', () => {
    expect(suggestPathPattern('README.md')).toBe('README.md');
  });
});
