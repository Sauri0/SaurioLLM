// Helpers de formato puro para el Centro de modelos (doc 13 §4 "regla de UI": nunca mostrar un
// número sin su etiqueta de calidad measured/estimated/unavailable — principio 6 de la columna).
// apps/desktop/src/renderer/src/features/models/format.ts.
import type { MemoryEstimate } from '@saurio/shared';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

const FIT_LABELS: Record<MemoryEstimate['fitClass'], string> = {
  fits_gpu: 'entra en GPU',
  tight: 'justo',
  partial_offload: 'offload parcial',
  no_fit: 'no entra',
};

export function fitClassLabel(fitClass: MemoryEstimate['fitClass']): string {
  return FIT_LABELS[fitClass];
}

/** Doc 13 §4: la ficha nunca muestra un número sin "estimado" o "probado (fecha)" pegado. */
export function qualitySuffix(quality: MemoryEstimate['quality'], testedAt?: number): string {
  if (quality === 'measured') {
    return testedAt ? `probado el ${new Date(testedAt).toLocaleDateString('es-AR')}` : 'medido';
  }
  if (quality === 'estimated') return 'estimado';
  return 'no disponible';
}
