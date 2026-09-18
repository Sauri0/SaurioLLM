import { describe, expect, it } from 'vitest';
import { LoopDetector, type LoopVerdict } from './LoopDetector.js';

describe('LoopDetector (doc 05 §2.10, doc 10 caso 10)', () => {
  it('misma tool + mismo args_hash 3 veces -> nudge; si persiste hasta 6 -> abort', () => {
    const d = new LoopDetector();
    expect(d.recordToolCall('search_code', 'h1')).toBeNull();
    expect(d.recordToolCall('search_code', 'h1')).toBeNull();
    expect(d.recordToolCall('search_code', 'h1')).toBe('nudge');
    expect(d.recordToolCall('search_code', 'h1')).toBeNull();
    expect(d.recordToolCall('search_code', 'h1')).toBeNull();
    expect(d.recordToolCall('search_code', 'h1')).toBe('abort');
  });

  it('mismo código de error 3 veces seguidas -> nudge', () => {
    const d = new LoopDetector();
    expect(d.recordError('stream_cut')).toBeNull();
    expect(d.recordError('stream_cut')).toBeNull();
    expect(d.recordError('stream_cut')).toBe('nudge');
  });

  it('alternancia A-B seis veces -> abort directo, sin nudge previo', () => {
    const d = new LoopDetector();
    const seq: LoopVerdict[] = [];
    for (let i = 0; i < 6; i += 1) {
      seq.push(d.recordToolCall(i % 2 === 0 ? 'read_file' : 'search_code', `args_${i % 2}`));
    }
    expect(seq.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(seq[5]).toBe('abort');
  });

  it('3 turnos seguidos sin tool call -> force_final; se resetea después', () => {
    const d = new LoopDetector();
    expect(d.recordNoToolTurn()).toBeNull();
    expect(d.recordNoToolTurn()).toBeNull();
    expect(d.recordNoToolTurn()).toBe('force_final');
    expect(d.recordNoToolTurn()).toBeNull();
  });

  it('una tool call entre medio corta la racha de "sin tool"', () => {
    const d = new LoopDetector();
    d.recordNoToolTurn();
    d.recordNoToolTurn();
    d.recordToolCall('list_files', 'h1');
    expect(d.recordNoToolTurn()).toBeNull();
  });

  describe('recordToolResultError (doc 16 §4, robustez con modelos chicos)', () => {
    it('cuenta rachas de "mismo texto de error, misma tool", empezando en 1', () => {
      const d = new LoopDetector();
      expect(d.recordToolResultError('edit_file', 'ambiguo')).toBe(1);
      expect(d.recordToolResultError('edit_file', 'ambiguo')).toBe(2);
      expect(d.recordToolResultError('edit_file', 'ambiguo')).toBe(3);
    });

    it('un texto de error distinto reinicia la cuenta en 1, aunque sea la misma tool', () => {
      const d = new LoopDetector();
      expect(d.recordToolResultError('edit_file', 'ambiguo')).toBe(1);
      expect(d.recordToolResultError('edit_file', 'ambiguo')).toBe(2);
      expect(d.recordToolResultError('edit_file', 'ruta protegida')).toBe(1);
    });

    it('no exige args idénticos: dos llamadas con distintos args que fallan igual siguen contando', () => {
      const d = new LoopDetector();
      // recordToolCall (args-based) no interfiere: es un tracker separado.
      d.recordToolCall('edit_file', 'args-hash-1');
      expect(d.recordToolResultError('edit_file', 'mismo error')).toBe(1);
      d.recordToolCall('edit_file', 'args-hash-2');
      expect(d.recordToolResultError('edit_file', 'mismo error')).toBe(2);
    });

    it('tools distintas llevan cuentas independientes', () => {
      const d = new LoopDetector();
      expect(d.recordToolResultError('edit_file', 'x')).toBe(1);
      expect(d.recordToolResultError('write_file', 'x')).toBe(1);
      expect(d.recordToolResultError('edit_file', 'x')).toBe(2);
    });

    it('clearToolResultError reinicia la cuenta de esa tool', () => {
      const d = new LoopDetector();
      d.recordToolResultError('edit_file', 'ambiguo');
      d.recordToolResultError('edit_file', 'ambiguo');
      d.clearToolResultError('edit_file');
      expect(d.recordToolResultError('edit_file', 'ambiguo')).toBe(1);
    });
  });
});
