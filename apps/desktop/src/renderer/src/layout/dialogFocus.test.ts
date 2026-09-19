import { describe, expect, it } from 'vitest';
import { focusTrapTarget, shouldRestoreOverlayFocus } from './dialogFocus.js';

describe('dialogFocus', () => {
  it('encierra Tab sólo en los extremos del diálogo', () => {
    const first = Symbol('first');
    const middle = Symbol('middle');
    const last = Symbol('last');
    expect(focusTrapTarget([first, middle, last], last, false)).toBe(first);
    expect(focusTrapTarget([first, middle, last], first, true)).toBe(last);
    expect(focusTrapTarget([first, middle, last], middle, false)).toBeUndefined();
    expect(focusTrapTarget([first, middle, last], Symbol('outside'), false)).toBe(first);
    expect(focusTrapTarget([first, middle, last], Symbol('outside'), true)).toBe(last);
  });

  it('devuelve foco sólo al cerrar con foco dentro del overlay o en body', () => {
    const body: symbol = Symbol('body');
    const inside: symbol = Symbol('inside');
    const outside: symbol = Symbol('outside');
    expect(shouldRestoreOverlayFocus(body, body, () => false)).toBe(true);
    expect(shouldRestoreOverlayFocus(inside, body, (target) => target === inside)).toBe(true);
    expect(shouldRestoreOverlayFocus(outside, body, (target) => target === inside)).toBe(false);
  });
});
