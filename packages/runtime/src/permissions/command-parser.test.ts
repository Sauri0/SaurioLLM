// Tests de CommandParser (pwsh) — doc 06 §3.
import { describe, expect, it } from 'vitest';
import { commandParser } from './command-parser.js';

describe('CommandParser pwsh: clasificación de un solo subcomando', () => {
  const cases: [raw: string, category: string][] = [
    ['Remove-Item .\\dist -Recurse', 'delete'],
    ['rm -rf dist', 'delete'],
    ['del file.txt', 'delete'],
    ['git commit -m "fix"', 'git_commit'],
    ['git push origin main', 'git_push'],
    ['curl https://api.example.com', 'network'],
    ['Invoke-WebRequest https://api.example.com', 'network'],
    ['npm test', 'terminal'],
    ['pnpm build', 'terminal'],
  ];
  it.each(cases)('%s -> %s', (raw, category) => {
    const parsed = commandParser.parse(raw, 'pwsh');
    expect(parsed.subcommands).toHaveLength(1);
    expect(parsed.subcommands[0]?.category).toBe(category);
    expect(parsed.confident).toBe(true);
  });
});

describe('CommandParser pwsh: separadores', () => {
  it('separa por ;', () => {
    const parsed = commandParser.parse('npm test; npm run build', 'pwsh');
    expect(parsed.subcommands.map((s) => s.tokens[0])).toEqual(['npm', 'npm']);
    expect(parsed.subcommands).toHaveLength(2);
  });

  it('separa por &&', () => {
    const parsed = commandParser.parse('npm install && npm test', 'pwsh');
    expect(parsed.subcommands).toHaveLength(2);
    expect(parsed.subcommands[1]?.tokens).toEqual(['npm', 'test']);
  });

  it('separa por ||', () => {
    const parsed = commandParser.parse('npm test || echo fail', 'pwsh');
    expect(parsed.subcommands).toHaveLength(2);
  });

  it('separa por |', () => {
    const parsed = commandParser.parse('git log | Select-Object -First 5', 'pwsh');
    expect(parsed.subcommands).toHaveLength(2);
  });

  it('categoría más restrictiva agregada: delete + terminal', () => {
    const parsed = commandParser.parse('npm test; rm -rf dist', 'pwsh');
    const categories = parsed.subcommands.map((s) => s.category);
    expect(categories).toEqual(['terminal', 'delete']);
  });

  it('separa por salto de línea (hallazgo #2: multilínea colapsaba en un subcomando)', () => {
    const parsed = commandParser.parse('npm test\nRemove-Item -Recurse dist', 'pwsh');
    expect(parsed.subcommands).toHaveLength(2);
    const categories = parsed.subcommands.map((s) => s.category);
    expect(categories).toEqual(['terminal', 'delete']);
  });

  it('separa por \\r\\n sin dejar un subcomando vacío', () => {
    const parsed = commandParser.parse('npm install\r\nnpm test', 'pwsh');
    expect(parsed.subcommands).toHaveLength(2);
    expect(parsed.subcommands.map((s) => s.tokens[0])).toEqual(['npm', 'npm']);
  });

  it('tres líneas: el rm oculto en la última línea se detecta como delete', () => {
    const parsed = commandParser.parse('npm install\nnpm run build\nrm -rf dist', 'pwsh');
    expect(parsed.subcommands).toHaveLength(3);
    expect(parsed.subcommands[2]?.category).toBe('delete');
  });

  it('separa por & de fondo (pero no por el & de "& { ... }")', () => {
    const parsed = commandParser.parse('npm test &', 'pwsh');
    expect(parsed.subcommands).toHaveLength(1);
    expect(parsed.subcommands[0]?.tokens).toEqual(['npm', 'test']);
  });

  it('& { npm test } sigue tratándose como invocación, no separador', () => {
    const parsed = commandParser.parse('& { npm test }', 'pwsh');
    expect(parsed.subcommands).toHaveLength(1);
    expect(parsed.subcommands[0]?.tokens).toEqual(['npm', 'test']);
  });
});

describe('CommandParser pwsh: alias de borrado (hallazgo #3)', () => {
  const cases: [raw: string, category: string][] = [
    ['ri -Recurse dist', 'delete'],
    ['rd /s /q C:\\tmp', 'delete'],
    ['rmdir /s /q C:\\tmp', 'delete'],
    ['erase /s /q C:\\tmp', 'delete'],
  ];
  it.each(cases)('%s -> %s', (raw, category) => {
    const parsed = commandParser.parse(raw, 'pwsh');
    expect(parsed.subcommands[0]?.category).toBe(category);
  });
});

describe('CommandParser pwsh: confianza', () => {
  it('Invoke-Expression fuerza confident: false', () => {
    const parsed = commandParser.parse('Invoke-Expression "rm -rf dist"', 'pwsh');
    expect(parsed.confident).toBe(false);
  });

  it('-Command fuerza confident: false', () => {
    const parsed = commandParser.parse('powershell -Command "Remove-Item dist"', 'pwsh');
    expect(parsed.confident).toBe(false);
  });

  it('& { ... } (operador de invocación) fuerza confident: false', () => {
    const parsed = commandParser.parse('& { npm test }', 'pwsh');
    expect(parsed.confident).toBe(false);
    expect(parsed.subcommands[0]?.tokens).toEqual(['npm', 'test']);
  });

  it('comilla sin cerrar fuerza confident: false', () => {
    const parsed = commandParser.parse('git commit -m "fix', 'pwsh');
    expect(parsed.confident).toBe(false);
  });

  it('comando vacío no es confiable', () => {
    const parsed = commandParser.parse('   ', 'pwsh');
    expect(parsed.confident).toBe(false);
    expect(parsed.subcommands).toHaveLength(0);
  });
});

describe('CommandParser bash (no implementado en el MVP, doc §12/Desvíos #4)', () => {
  it('devuelve confident: false en vez de lanzar', () => {
    const parsed = commandParser.parse('npm test && npm run build', 'bash');
    expect(parsed.confident).toBe(false);
    expect(parsed.shell).toBe('bash');
  });
});
