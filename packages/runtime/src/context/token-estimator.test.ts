// Tests de TokenEstimator: heurística chars/ratio y calibración EMA contra prompt_eval_count
// — packages/runtime/src/context/token-estimator.test.ts.
import { describe, expect, it } from 'vitest';
import {
  createInMemoryTokenCalibrationRepository, createTokenEstimator, INITIAL_RATIOS,
} from './token-estimator.js';

const MODEL_REF = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' as const };

describe('context/TokenEstimator', () => {
  it('estima chars/ratio por tipo antes de calibrar (factor 1)', () => {
    const repo = createInMemoryTokenCalibrationRepository();
    const estimator = createTokenEstimator(MODEL_REF, repo);
    const text = 'x'.repeat(38); // 38 / 3.8 = 10
    expect(estimator.estimate(text, 'prose')).toBe(10);
    expect(estimator.estimate('x'.repeat(32), 'code')).toBe(10);
  });

  it('ajusta el factor de corrección con EMA hacia prompt_eval_count real', () => {
    const repo = createInMemoryTokenCalibrationRepository();
    const estimator = createTokenEstimator(MODEL_REF, repo);

    const text = 'x'.repeat(Math.round(INITIAL_RATIOS.prose * 100)); // estimación cruda ~100
    const estimatedBefore = estimator.estimate(text, 'prose');
    expect(estimatedBefore).toBe(100);

    // El modelo real necesitó más tokens de los estimados -> el factor debe subir.
    estimator.calibrate(MODEL_REF, estimatedBefore, 130);
    const estimatedAfter = estimator.estimate(text, 'prose');
    expect(estimatedAfter).toBeGreaterThan(estimatedBefore);

    const stored = repo.get(MODEL_REF.providerId, MODEL_REF.name);
    expect(stored?.samples).toBe(1);
    expect(stored?.ratio).toBeGreaterThan(1);
  });

  it('no mezcla calibración de un modelo distinto al de la instancia', () => {
    const repo = createInMemoryTokenCalibrationRepository();
    const estimator = createTokenEstimator(MODEL_REF, repo);
    const otherModel = { providerId: 'ollama', name: 'qwen2.5-coder:7b', locality: 'local' as const };

    estimator.calibrate(otherModel, 100, 500);

    expect(repo.get(otherModel.providerId, otherModel.name)).toBeUndefined();
  });
});
