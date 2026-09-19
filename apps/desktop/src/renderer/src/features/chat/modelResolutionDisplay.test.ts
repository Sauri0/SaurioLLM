import { describe, expect, it } from 'vitest';
import { modelResolutionText } from './ContextInspector.js';

describe('modelResolutionText', () => {
  it('no inventa procedencia para runs legacy', () => {
    expect(modelResolutionText(undefined)).toMatch(/sin confirmar/i);
  });

  it('presenta fit automático como estimado y conserva la herencia', () => {
    const text = modelResolutionText({
      source: 'automatic_recommendation', contextMax: 32768,
      fitClass: 'tight', fitQuality: 'estimated', inheritedFromRunId: 'run_anterior',
    });
    expect(text).toContain('recomendaciones locales');
    expect(text).toContain('Ajuste estimado');
    expect(text).toContain('32.768');
    expect(text).toContain('Conservado al continuar');
  });
});
