// Diagnostics MVP: offload detectado y Ollama no responde — packages/runtime/src/telemetry/Diagnostics.ts.
// Define: doc 14 §7 (tabla de diagnósticos) y §"Imprescindible para el MVP". Implementa la interfaz
// `Diagnostics` de ./types.ts (contrato, no se modifica). Nunca cambia configuración por su cuenta
// (condición 11.B doc 14): solo diagnostica y sugiere `suggestedAction`.
import type { Metric, QueuedJob } from '@saurio/shared';
import type { Diagnostics as DiagnosticsContract, Diagnostic, RunMetrics } from './types.js';
import type { MetricsSnapshot, ProviderHealth } from '@saurio/shared';

export class Diagnostics implements DiagnosticsContract {
  evaluate(snapshot: MetricsSnapshot, _history: RunMetrics[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const model of snapshot.loaded) {
      if (model.sizeVram < model.size) {
        const evidence: Metric<unknown>[] = [
          { value: model.size, quality: 'measured', source: 'api/ps', sampledAt: this.now() },
          { value: model.sizeVram, quality: 'measured', source: 'api/ps', sampledAt: this.now() },
        ];
        diagnostics.push({
          code: 'offload',
          message: `El modelo "${model.name}" está parcialmente en CPU (medido): size ${model.size} bytes vs size_vram ${model.sizeVram} bytes.`,
          evidence,
          suggestedAction: { label: 'Ver detalle en el Centro de modelos', opensSettings: 'models' },
        });
      }
    }

    return diagnostics;
  }

  /** No forma parte de la interfaz `Diagnostics` (que solo declara `evaluate(snapshot, history)`,
   *  sin lugar para el resultado de `Provider.health()`); se agrega como método adicional porque
   *  el diagnóstico "Ollama no responde" (doc 14 MVP: "el Model Manager mide y cataloga; nadie
   *  estima lo que otro ya midió", y doc 08 tabla §1: `health()` es del Provider) necesita ese dato
   *  y `MetricsSnapshot` no lo incluye. */
  evaluateProviderHealth(health: ProviderHealth[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const h of health) {
      if (!h.ok) {
        diagnostics.push({
          code: 'provider_down',
          message: `Ollama no responde (provider "${h.providerId}")${h.error ? `: ${h.error}` : '.'}`,
          evidence: [{ value: h.error ?? 'sin detalle', quality: 'measured', source: 'provider.health', sampledAt: this.now() }],
          suggestedAction: { label: 'Verificar que Ollama esté corriendo' },
        });
      }
    }
    return diagnostics;
  }

  /** Diagnóstico "contexto no coincidente" (doc 14 §7, punto 7): compara el `numCtx` pedido contra
   *  `/api/ps.context_length`. Tampoco cabe en `evaluate(snapshot, history)` solo (requiere el
   *  numCtx *pedido*, que no viaja en `LoadedModel`), así que es otro método adicional explícito. */
  evaluateContextMismatch(requested: { modelName: string; numCtx: number }, loaded: MetricsSnapshot['loaded']): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const match = loaded.find((m) => m.name === requested.modelName);
    if (match && match.contextLength !== requested.numCtx) {
      diagnostics.push({
        code: 'context_mismatch',
        message: `El servidor asignó un contexto distinto al pedido (pedido ${requested.numCtx}, /api/ps.context_length ${match.contextLength}): revisá la variable OLLAMA_CONTEXT_LENGTH del servidor.`,
        evidence: [
          { value: requested.numCtx, quality: 'measured', source: 'request.options.numCtx', sampledAt: this.now() },
          { value: match.contextLength, quality: 'measured', source: 'api/ps', sampledAt: this.now() },
        ],
      });
    }
    return diagnostics;
  }

  /** Doc 14 §7 punto 3: "Poca VRAM libre antes de un run" — VRAM libre (línea base, SystemSampler)
   *  < 500 MiB. `system.vramUsedBytes` es lo único que muestrea `SystemSampler` (doc 14 §3.4); el
   *  total lo da el `HardwareProbe` (nvidia-smi, `HardwareProfile.gpu.vramTotalBytes`, ya usado por
   *  `MemoryEstimator`) — se recibe inyectado en vez de que Telemetry vuelva a llamar nvidia-smi por
   *  su cuenta (doc 14 §2: "no consulta Ollama/hardware por su cuenta"). */
  evaluateLowVram(system: MetricsSnapshot['system'], vramTotalBytes?: number): Diagnostic[] {
    if (!system.vramUsedBytes || vramTotalBytes === undefined) return [];
    if (system.vramUsedBytes.quality !== 'measured') return [];
    const freeBytes = vramTotalBytes - system.vramUsedBytes.value;
    const freeMib = freeBytes / (1024 * 1024);
    if (freeMib >= 500) return [];
    return [{
      code: 'low_vram',
      message: `Poca VRAM libre para cargar un modelo: ${freeMib.toFixed(0)} MiB libres (medido). Cerrá aplicaciones que usan la GPU.`,
      evidence: [system.vramUsedBytes, { value: freeBytes, quality: 'measured', source: 'nvidia_smi', sampledAt: this.now() }],
      suggestedAction: { label: 'Ver uso de GPU en el panel de sistema' },
    }];
  }

  /** Doc 14 §7 punto 6: "Cola larga" — N jobs esperando el mismo modelo (default 3) o el primero de
   *  la cola lleva más de `waitThresholdMs` (default 30 s) esperando. No es un error: informa por qué
   *  un chat "no arrancó" (con 1 slot, doc 08 §7.1, se ejecuta una corrida por vez). */
  evaluateQueueBacklog(queue: QueuedJob[], now = Date.now(), jobThreshold = 3, waitThresholdMs = 30_000): Diagnostic[] {
    if (queue.length === 0) return [];
    const byModel = new Map<string, QueuedJob[]>();
    for (const job of queue) {
      const key = job.ref.name;
      const list = byModel.get(key) ?? [];
      list.push(job);
      byModel.set(key, list);
    }
    const diagnostics: Diagnostic[] = [];
    for (const [modelName, jobs] of byModel) {
      const oldest = Math.min(...jobs.map((j) => j.enqueuedAt));
      const waitedMs = now - oldest;
      if (jobs.length < jobThreshold && waitedMs < waitThresholdMs) continue;
      diagnostics.push({
        code: 'queue_backlog',
        message: `Hay ${jobs.length} tarea(s) esperando el modelo "${modelName}" (la más vieja lleva ${Math.round(waitedMs / 1000)}s en cola). Con 1 slot se ejecutan una por una.`,
        evidence: [
          { value: jobs.length, quality: 'measured', source: 'gateway_status', sampledAt: now },
          { value: waitedMs, quality: 'measured', source: 'gateway_status', sampledAt: now },
        ],
      });
    }
    return diagnostics;
  }

  private now(): number {
    return Date.now();
  }
}
