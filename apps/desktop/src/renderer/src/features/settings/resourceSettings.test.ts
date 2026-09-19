import { describe, expect, it } from 'vitest';
import {
  defaultLocalInferencePreference, hardwareQualityLabel, parseLocalInferencePreference, presetThreads, threadLimit,
  type ResourceHardware,
} from './resourceSettingsLogic.js';

const HARDWARE: ResourceHardware = {
  cpu: { name: 'CPU de prueba', threads: 12 },
  ram: { totalBytes: 32 * 1024 ** 3, freeBytes: 16 * 1024 ** 3 },
  gpu: { vendor: 'intel', vramTotalBytes: 18 * 1024 ** 3, integrated: true, quality: 'measured', source: 'test' },
  sampledAt: 1,
};

describe('resourceSettings', () => {
  it('deriva presets dentro del límite de hilos detectado', () => {
    expect(threadLimit(HARDWARE)).toBe(12);
    expect(presetThreads('low-power', 12)).toBe(6);
    expect(presetThreads('balanced', 12)).toBe(9);
    expect(presetThreads('max-performance', 12)).toBe(12);
    expect(defaultLocalInferencePreference(HARDWARE)).toEqual({ preset: 'balanced', computeMode: 'auto', numThreads: 9 });
  });

  it('sanea preferencias persistidas sin exceder los hilos del equipo', () => {
    expect(parseLocalInferencePreference({ preset: 'max-performance', computeMode: 'cpu', numThreads: 99 }, HARDWARE))
      .toEqual({ preset: 'max-performance', computeMode: 'cpu', numThreads: 12 });
    expect(parseLocalInferencePreference({ preset: 'ajeno', numThreads: 0 }, HARDWARE))
      .toEqual({ preset: 'balanced', computeMode: 'auto', numThreads: 9 });
  });

  it('traduce la calidad medida para la interfaz', () => {
    expect(hardwareQualityLabel('measured')).toBe('Medido');
    expect(hardwareQualityLabel('estimated')).toBe('Estimado');
    expect(hardwareQualityLabel('unavailable')).toBe('No disponible');
  });
});
