import { describe, expect, it } from 'vitest';
import type { Adjustment } from '@saurio/shared';
import { adjustmentsForRun } from './RunAdjustments.js';

const adjustment = (param: string): Adjustment => ({
  param, requested: 'auto', applied: 0,
  reason: `${param} ajustado`, source: 'auto',
});

describe('adjustmentsForRun', () => {
  it('devuelve sólo los ajustes del run seleccionado', () => {
    const runAdjustments = {
      run_a: [adjustment('numGpu')],
      run_b: [adjustment('numCtx')],
    };

    expect(adjustmentsForRun(runAdjustments, 'run_a')).toEqual(runAdjustments.run_a);
    expect(adjustmentsForRun(runAdjustments, 'run_a')).not.toEqual(runAdjustments.run_b);
  });
});
