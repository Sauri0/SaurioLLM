// MetricsAggregator, Diagnostics, ringBuffer.ts (doc 02 §1: packages/runtime/src/telemetry/).
// Implementación MVP: ver doc 14-panel-de-rendimiento.md.
export type {
  RunMetrics,
  Diagnostic,
  Diagnostics as DiagnosticsContract,
  MetricsAggregator as MetricsAggregatorContract,
  SystemSample,
  MetricsSnapshot,
  Metric,
  Quality,
  SlotStatus,
  QueuedJob,
  LoadedModel,
} from './types.js';
export { RingBuffer } from './ringBuffer.js';
export { MetricsAggregator } from './MetricsAggregator.js';
export { Diagnostics } from './Diagnostics.js';
