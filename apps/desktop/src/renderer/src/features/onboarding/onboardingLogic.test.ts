import { describe, expect, it } from 'vitest';
import { reduceOnboarding, isTerminal, type OnboardingStep } from './onboardingLogic.js';

describe('onboardingLogic.reduceOnboarding', () => {
  it('health_checked con Ollama corriendo va a recommendations', () => {
    expect(reduceOnboarding('checking', { type: 'health_checked', ollamaOk: true })).toBe('recommendations');
  });

  it('health_checked sin Ollama va a ollama_missing', () => {
    expect(reduceOnboarding('checking', { type: 'health_checked', ollamaOk: false })).toBe('ollama_missing');
  });

  it('camino "Modelos en mi PC": ollama_missing -> confirm_download -> done', () => {
    let step: OnboardingStep = 'ollama_missing';
    step = reduceOnboarding(step, { type: 'choose_pc_models' });
    expect(step).toBe('confirm_download');
    step = reduceOnboarding(step, { type: 'confirm_download' });
    expect(step).toBe('done');
    expect(isTerminal(step)).toBe(true);
  });

  it('cancelar la descarga vuelve a ollama_missing (no queda a mitad de camino)', () => {
    let step: OnboardingStep = 'ollama_missing';
    step = reduceOnboarding(step, { type: 'choose_pc_models' });
    step = reduceOnboarding(step, { type: 'cancel_download' });
    expect(step).toBe('ollama_missing');
  });

  it('camino "Tengo una clave de API": ollama_missing -> api_key_redirect', () => {
    const step = reduceOnboarding('ollama_missing', { type: 'choose_api_key' });
    expect(step).toBe('api_key_redirect');
  });

  it('recommendations_seen cierra el asistente', () => {
    expect(reduceOnboarding('recommendations', { type: 'recommendations_seen' })).toBe('done');
  });

  it('skip cierra el asistente desde cualquier paso', () => {
    expect(reduceOnboarding('ollama_missing', { type: 'skip' })).toBe('done');
    expect(reduceOnboarding('recommendations', { type: 'skip' })).toBe('done');
    expect(reduceOnboarding('confirm_download', { type: 'skip' })).toBe('done');
  });

  it('un evento que no aplica al paso actual no lo mueve (evita saltos inválidos)', () => {
    expect(reduceOnboarding('recommendations', { type: 'choose_pc_models' })).toBe('recommendations');
    expect(reduceOnboarding('done', { type: 'confirm_download' })).toBe('done');
  });
});
