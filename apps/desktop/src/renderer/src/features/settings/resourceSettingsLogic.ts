export const LOCAL_INFERENCE_SETTING_KEY = 'resources.localInference';

export type ResourcePreset = 'balanced' | 'low-power' | 'max-performance';
export type ComputeMode = 'auto' | 'cpu';

export interface LocalInferencePreference {
  preset: ResourcePreset;
  computeMode: ComputeMode;
  numThreads: number;
}

export interface ResourceHardware {
  cpu: { name: string; threads: number; physicalCores?: number };
  ram: { totalBytes: number; freeBytes: number };
  gpu?: {
    vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';
    vramTotalBytes: number;
    vramUsedBytes?: number;
    integrated?: boolean;
    quality: 'measured' | 'estimated' | 'unavailable';
    source: string;
  };
  sampledAt: number;
}

export function hardwareQualityLabel(quality: NonNullable<ResourceHardware['gpu']>['quality']): string {
  const labels = { measured: 'Medido', estimated: 'Estimado', unavailable: 'No disponible' } as const;
  return labels[quality];
}

export function threadLimit(hardware: ResourceHardware | undefined): number {
  return Math.max(1, Math.floor(hardware?.cpu.threads ?? 1));
}

export function presetThreads(preset: ResourcePreset, limit: number): number {
  switch (preset) {
    case 'low-power': return Math.max(1, Math.floor(limit / 2));
    case 'max-performance': return limit;
    case 'balanced': return Math.max(1, Math.floor(limit * 0.75));
  }
}

export function defaultLocalInferencePreference(hardware: ResourceHardware | undefined): LocalInferencePreference {
  const limit = threadLimit(hardware);
  return { preset: 'balanced', computeMode: 'auto', numThreads: presetThreads('balanced', limit) };
}

export function parseLocalInferencePreference(value: unknown, hardware: ResourceHardware | undefined): LocalInferencePreference {
  const fallback = defaultLocalInferencePreference(hardware);
  if (!value || typeof value !== 'object') return fallback;
  const record = value as Record<string, unknown>;
  const preset: ResourcePreset = record.preset === 'low-power' || record.preset === 'max-performance' || record.preset === 'balanced'
    ? record.preset
    : fallback.preset;
  const computeMode: ComputeMode = record.computeMode === 'cpu' || record.computeMode === 'auto'
    ? record.computeMode
    : fallback.computeMode;
  const limit = threadLimit(hardware);
  const numThreads = typeof record.numThreads === 'number' && Number.isInteger(record.numThreads) && record.numThreads > 0
    ? Math.min(record.numThreads, limit)
    : presetThreads(preset, limit);
  return { preset, computeMode, numThreads };
}

export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toLocaleString('es-AR', { maximumFractionDigits: 1 })} GiB`;
}
