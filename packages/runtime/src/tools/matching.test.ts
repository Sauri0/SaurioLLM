// Test del matching en cascada exact/eol/indent/whitespace/fuzzy — doc 09 §"Imprescindible para el MVP".
import { describe, expect, it } from 'vitest';
import { matchCascade, replaceAtCascade } from './matching.js';

describe('tools/matching', () => {
  it('no reemplaza una cabecera por confundirla con una función completa aproximada', () => {
    const content = 'export function suma(a: number, b: number): number {\n  return a - b; // BUG\n}\n';
    const result = replaceAtCascade(content,
      'export function suma(a: number, b: number): number { return a - b; }',
      'function suma(a: number, b: number): number { return a + b; }', false);
    expect(result.level).toBeNull();
    if (result.level === null) {
      expect(result.reason).toContain('no se modificó');
      expect(result.candidates?.[0]?.line).toBe(1);
    }
    const corrected = replaceAtCascade(content, 'return a - b;', 'return a + b;', false);
    expect(corrected.level).toBe('exact');
    if (corrected.level) expect(corrected.content).toBe(content.replace('a - b', 'a + b'));
  });

  it('una sugerencia fuzzy no autoriza sustituir otro identificador o literal', () => {
    const result = replaceAtCascade('function greet(name) {\n  return "hello " + name;\n}\n',
      'function greet(name) {\n  return "hi " + name;\n}', 'wrong block', false);
    expect(result.level).toBeNull();
  });
  it('exact: encuentra una única ocurrencia', () => {
    const content = 'const a = 1;\nconst b = 2;\n';
    const r = matchCascade(content, 'const a = 1;');
    expect(r.level).toBe('exact');
  });

  it('exact: ambiguo con más de una ocurrencia', () => {
    const content = 'x\nfoo\ny\nfoo\n';
    const r = matchCascade(content, 'foo');
    expect(r.level).toBeNull();
  });

  it('exact: ambiguo devuelve las coincidencias numeradas con línea y preview (doc 16 §4 ítem 6)', () => {
    const content = 'const a = 1;\nfoo\nconst b = 2;\nfoo\nconst c = 3;\n';
    const r = matchCascade(content, 'foo');
    expect(r.level).toBeNull();
    if (r.level === null) {
      expect(r.candidates).toBeDefined();
      expect(r.candidates?.length).toBe(2);
      expect(r.candidates?.[0]).toEqual({ line: 2, preview: 'foo' });
      expect(r.candidates?.[1]).toEqual({ line: 4, preview: 'foo' });
    }
  });

  it('eol: matchea aunque el archivo tenga CRLF y el needle LF', () => {
    const content = 'a\r\nb\r\nc\r\n';
    const r = matchCascade(content, 'b\nc');
    expect(r.level).toBe('eol');
  });

  it('indent: matchea bloques con indentación distinta a la del needle', () => {
    const content = 'function f() {\n    if (x) {\n        return 1;\n    }\n}\n';
    const needle = 'if (x) {\n    return 1;\n}';
    const r = matchCascade(content, needle);
    expect(r.level).toBe('indent');
  });

  it('whitespace: matchea con espacios internos distintos', () => {
    const content = 'const   x   =   1;\n';
    const r = matchCascade(content, 'const x = 1;');
    expect(r.level).toBe('whitespace');
  });

  it('fuzzy: matchea un bloque casi idéntico con una palabra distinta', () => {
    const content = 'function greet(name) {\n  return "hello " + name;\n}\n';
    const needle = 'function greet(name) {\n  return "hi " + name;\n}';
    const r = matchCascade(content, needle);
    expect(r.level).toBe('fuzzy');
  });

  it('no encuentra nada completamente distinto', () => {
    const content = 'totalmente distinto\n';
    const needle = 'function foo() { return bar(); }\nmás líneas\nque no matchean\n';
    const r = matchCascade(content, needle);
    expect(r.level).toBeNull();
  });

  it('replaceAtCascade aplica el reemplazo en el offset correcto', () => {
    const content = 'uno\ndos\ntres\n';
    const res = replaceAtCascade(content, 'dos', 'DOS', false);
    expect(res.level).toBe('exact');
    if (res.level) expect(res.content).toBe('uno\nDOS\ntres\n');
  });

  it('replaceAtCascade con replace_all reemplaza todas las ocurrencias exactas', () => {
    const content = 'foo bar foo baz foo\n';
    const res = replaceAtCascade(content, 'foo', 'X', true);
    expect(res.level).toBe('exact');
    if (res.level) {
      expect(res.content).toBe('X bar X baz X\n');
      expect(res.count).toBe(3);
    }
  });
});
