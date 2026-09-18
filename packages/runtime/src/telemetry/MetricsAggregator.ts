// MetricsAggregator: métricas por respuesta y por run, cache hit ratio — packages/runtime/src/telemetry/MetricsAggregator.ts.
// Define: doc 14 §5-6 (v_chat_stats/v_model_stats). Implementa la interfaz `MetricsAggregator` de
// ./types.ts (contrato, no se modifica). MVP: agregación en memoria (RingBuffer) — la persistencia
// real en `metrics_minute`/`runs.metrics_json`/`messages.response_metrics_json` es responsabilidad
// del host (Persistence, fuera de los directorios asignados a este módulo); esta clase expone
// `snapshotForPersistence()` para que el host la lea y la escriba donde corresponda, sin que
// Telemetry importe better-sqlite3 directamente.
import type { ResponseMetrics } from '@saurio/shared';
import type { MetricsAggregator as MetricsAggregatorContract, RunMetrics } from './types.js';
import { RingBuffer } from './ringBuffer.js';

interface ResponseRecord { chatId: string; runId: string; metrics: ResponseMetrics; recordedAt: number }

const DEFAULT_BUFFER_SIZE = 500;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const midValue = sorted[mid];
  const prevValue = sorted[mid - 1];
  if (midValue === undefined) return 0;
  return sorted.length % 2 !== 0 ? midValue : ((prevValue ?? midValue) + midValue) / 2;
}

function tokPerSec(metrics: ResponseMetrics): number | undefined {
  if (metrics.evalTokens === undefined || metrics.evalMs === undefined || metrics.evalMs <= 0) return undefined;
  return (metrics.evalTokens / metrics.evalMs) * 1000;
}

function cacheHit(metrics: ResponseMetrics): number | undefined {
  if (metrics.cachedPromptTokens === undefined || metrics.promptTokens === undefined || metrics.promptTokens <= 0) {
    return undefined;
  }
  return metrics.cachedPromptTokens / metrics.promptTokens;
}

/** `(providerId, modelName)` no viaja en `ResponseMetrics`/`RunMetrics` (esas interfaces son
 *  contrato de packages/runtime/src/telemetry/types.ts y no se modifican); el host asocia un run
 *  con su modelo llamando `registerRunModel` cuando lo sabe (al empezar el run, desde ChatContext/
 *  ModelRef), igual que llama `recordResponse`/`recordRun`. Es API adicional a la interfaz mínima,
 *  documentada como deviation. */
export class MetricsAggregator implements MetricsAggregatorContract {
  private readonly responsesByChat = new Map<string, RingBuffer<ResponseRecord>>();
  private readonly runsByChat = new Map<string, RingBuffer<RunMetrics>>();
  private readonly modelByRun = new Map<string, { providerId: string; modelName: string }>();
  private readonly responsesByModel = new Map<string, RingBuffer<ResponseRecord>>();

  constructor(private readonly bufferSize: number = DEFAULT_BUFFER_SIZE, private readonly now: () => number = Date.now) {}

  registerRunModel(runId: string, providerId: string, modelName: string): void {
    this.modelByRun.set(runId, { providerId, modelName });
  }

  recordResponse(chatId: string, runId: string, metrics: ResponseMetrics): void {
    const record: ResponseRecord = { chatId, runId, metrics, recordedAt: this.now() };
    this.bufferFor(this.responsesByChat, chatId).push(record);
    const model = this.modelByRun.get(runId);
    if (model) {
      this.bufferFor(this.responsesByModel, this.modelKey(model.providerId, model.modelName)).push(record);
    }
  }

  recordRun(metrics: RunMetrics): void {
    // RunMetrics no trae chatId (doc contrato); se indexa además por runId vía modelByRun cuando
    // el host lo registró, y siempre queda disponible a través de las respuestas ya grabadas para
    // ese run (mismo chatId que sus ResponseMetrics).
    const chatId = this.chatIdForRun(metrics.runId);
    if (chatId) this.bufferFor(this.runsByChat, chatId).push(metrics);
  }

  private chatIdForRun(runId: string): string | undefined {
    for (const [chatId, buffer] of this.responsesByChat) {
      if (buffer.toArray().some((r) => r.runId === runId)) return chatId;
    }
    return undefined;
  }

  private bufferFor<K, V>(map: Map<K, RingBuffer<V>>, key: K): RingBuffer<V> {
    let buffer = map.get(key);
    if (!buffer) {
      buffer = new RingBuffer<V>(this.bufferSize);
      map.set(key, buffer);
    }
    return buffer;
  }

  private modelKey(providerId: string, modelName: string): string {
    return `${providerId}::${modelName}`;
  }

  private statsFrom(records: ResponseRecord[]): { tokens: number; medianTps: number; avgCacheHit: number } {
    const tokens = records.reduce((sum, r) => sum + (r.metrics.evalTokens ?? 0), 0);
    const tpsValues = records.map((r) => tokPerSec(r.metrics)).filter((v): v is number => v !== undefined);
    const cacheValues = records.map((r) => cacheHit(r.metrics)).filter((v): v is number => v !== undefined);
    const avgCacheHit = cacheValues.length > 0 ? cacheValues.reduce((a, b) => a + b, 0) / cacheValues.length : 0;
    return { tokens, medianTps: median(tpsValues), avgCacheHit };
  }

  async chatStats(chatId: string): Promise<{ tokens: number; medianTps: number; avgCacheHit: number }> {
    const records = this.responsesByChat.get(chatId)?.toArray() ?? [];
    return this.statsFrom(records);
  }

  async modelStats(providerId: string, modelName: string): Promise<{ tokens: number; medianTps: number; avgCacheHit: number }> {
    const records = this.responsesByModel.get(this.modelKey(providerId, modelName))?.toArray() ?? [];
    return this.statsFrom(records);
  }

  /** Vuelco crudo para que el host lo persista en `metrics_minute`/`runs.metrics_json`/
   *  `messages.response_metrics_json` (fuera de este módulo); Telemetry no escribe SQLite. */
  snapshotForPersistence(): { chatId: string; runId: string; metrics: ResponseMetrics; recordedAt: number }[] {
    const all: ResponseRecord[] = [];
    for (const buffer of this.responsesByChat.values()) all.push(...buffer.toArray());
    return all;
  }
}
