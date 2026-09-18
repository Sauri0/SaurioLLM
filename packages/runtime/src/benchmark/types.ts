// Banco de pruebas y perfiles — packages/runtime/src/benchmark/types.ts.
// Define: doc 04 §15. Todo v0.3 salvo `Profile` (perfil implícito por chat existe conceptualmente
// desde el MVP; `profiles` como tabla activa es v0.2). Solo interfaces/tipos (sin implementación).
// BenchmarkConfig/BenchmarkRun/Profile tienen su schema zod en @saurio/shared (domain.ts) porque
// cruzan IPC ('bench:*', 'profiles:*') — doc 02 §3.
import type { ModelRef, BenchmarkConfig, BenchmarkResult, BenchmarkRun, Profile } from '@saurio/shared';
import type { ModelGateway } from '../gateway/types.js';
import type { ModelManager } from '../models/types.js';
import type { ContextPolicy } from '../agent/types.js';
import type { PermissionPolicy } from '../permissions/types.js';
import type { ChatRequest } from '../gateway/types.js';

export type { BenchmarkConfig, BenchmarkResult, BenchmarkRun, Profile };

/** Única escritura de model_compat (columna §19: Benchmark no estima, solo mide). v0.3. */
export interface ModelCompat {
  id: string; providerId: string; modelName: string; modelDigest: string; hardwareFingerprint: string;
  numCtx: number; kvCacheType?: string; think: string; ollamaVersion?: string; driverVersion?: string;
  sizeBytes: number; sizeVramBytes: number; offloadRatio: number;
  loadMs: number; promptTps: number; genTps: number; ttftMs: number; peakVramMib: number; peakRamMib: number;
  qualityScore?: number; status: 'fits' | 'partial' | 'failed'; error?: string; testedAt: number;
}

export interface BenchmarkSuite {                        // v0.3
  id: string; kind: 'speed' | 'quality';
  run(model: ModelRef, gateway: ModelGateway, manager: ModelManager, config: BenchmarkConfig): Promise<BenchmarkRun>;
}

/** Extraída como interfaz propia (antes objeto anónimo embebido en `Profile.config`) para que
 *  packages/shared/src/domain.ts tenga una única forma de este dato en el borde IPC; el lado
 *  runtime (esta interfaz) es la versión completa y tipada que usa el resto de packages/runtime —
 *  ver doc 04, Desvíos §3, y la nota en Profile (@saurio/shared) sobre por qué `config` es
 *  `z.unknown()` en el schema zod. v0.2 salvo el concepto (implícito por chat) desde el MVP. */
export interface ProfileConfig {
  model: ModelRef; fallbackModel?: ModelRef; numCtx: number; temperature: number; topP?: number;
  think: ChatRequest['think']; numPredict: number; keepAlive: string | number;
  contextPolicy: ContextPolicy; maxIterations: number; permissionPreset: PermissionPolicy['preset'];
  timeouts: { commandMs: number };
  kvCacheType?: 'f16' | 'q8_0' | 'q4_0';   // solo managed
}

export interface BenchmarkResultRow {                     // v0.3: fila de un BenchmarkRun.perTask
  taskId: string; passed: boolean; detail?: string;
}

/** AutoAdjustment del brief = Adjustment (doc 04 §5) ya persistido como fila; alias documentado
 *  para que quede explícito que no hay dos formas de un ajuste — ver doc 04, Nomenclatura agregada. */
export type AutoAdjustment = import('@saurio/shared').Adjustment & { id: string; runId: string; revertedAt?: number };
