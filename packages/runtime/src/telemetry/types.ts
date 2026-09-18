// Métricas y telemetría — packages/runtime/src/telemetry/types.ts.
// Define: doc 04 §14. Solo interfaces/tipos (sin implementación). MVP: métricas por respuesta y por
// run, /api/ps vía ModelManager, CPU/RAM, nvidia-smi bajo demanda. SystemSampler continuo y
// metrics_minute son v0.2; diagnósticos completos también v0.2. `Metric<T>`/`SystemSample`/
// `MetricsSnapshot` tienen su schema zod en @saurio/shared (domain.ts) porque cruzan IPC
// ('metrics:snapshot', evento 'metrics:tick') — doc 02 §3.
import type { Quality, ToolCallStatus, ResponseMetrics, SystemSample, SlotStatus, QueuedJob, LoadedModel, MetricsSnapshot, Metric } from '@saurio/shared';

export type { SystemSample, MetricsSnapshot, Metric };

export interface RunMetrics {
  runId: string; promptTokens: number; evalTokens: number; cacheHitRatio?: number;
  tokPerSecPrompt?: number; tokPerSecGen?: number; ttftMsAvg?: number;
  iterations: number; toolCallsByStatus: Partial<Record<ToolCallStatus, number>>;
  wallTimeMs: number; loadMs?: number;
  vramPeakBytes?: Metric<number>; vramBaselineBytes?: Metric<number>;
}

export interface Diagnostic {
  code: 'offload' | 'slow_generation' | 'low_vram' | 'cache_miss' | 'provider_down' | 'oom_load' | 'context_mismatch' | 'queue_backlog';
  message: string; evidence: Metric<unknown>[]; suggestedAction?: { label: string; opensSettings?: string };
}

/** Nunca cambia configuración por su cuenta (condición 11.B): solo diagnostica y sugiere. */
export interface Diagnostics { evaluate(snapshot: MetricsSnapshot, history: RunMetrics[]): Diagnostic[] }

export interface MetricsAggregator {
  recordResponse(chatId: string, runId: string, metrics: ResponseMetrics): void;
  recordRun(metrics: RunMetrics): void;
  chatStats(chatId: string): Promise<{ tokens: number; medianTps: number; avgCacheHit: number }>;   // v_chat_stats
  modelStats(providerId: string, modelName: string): Promise<{ tokens: number; medianTps: number; avgCacheHit: number }>; // v_model_stats
}

// Referencias que quedan disponibles para consumidores de este módulo sin un segundo import directo
// a @saurio/shared (SlotStatus/QueuedJob/LoadedModel son parte de MetricsSnapshot; Quality documenta
// la procedencia de cada Metric<T>).
export type { Quality, SlotStatus, QueuedJob, LoadedModel };
