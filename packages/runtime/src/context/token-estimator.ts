// TokenEstimator heurístico (chars/ratio por tipo) con calibración EMA por modelo — packages/runtime/src/context/token-estimator.ts.
// Define: doc 07-context-manager.md §9 (heurística inicial + EMA contra prompt_eval_count) y doc 04 §8
// (interfaz `TokenCounter`, ya declarada en ./types.ts — no se modifica). La tabla `token_calibration`
// (provider_id, model_name, ratio, samples, updated_at) vive en packages/runtime/src/persistence, pero
// esa tarea no define todavía un repositorio para ella (persistence/types.ts no la nombra): se declara
// acá localmente `TokenCalibrationRepository` como interfaz de inyección mínima, anotado en deviations.
import type { ModelRef } from '@saurio/shared';
import type { TokenCounter } from './types.js';

export type TokenKind = 'prose' | 'code' | 'json' | 'path';

/** Ratios iniciales chars/token por tipo de contenido (doc 07 §9): sin calibrar todavía. */
export const INITIAL_RATIOS: Record<TokenKind, number> = {
  prose: 3.8,
  code: 3.2,
  json: 2.8,
  path: 2.5,
};

/** Peso de la media móvil exponencial usado para el factor de corrección por modelo (doc 07 §9). */
export const CALIBRATION_ALPHA = 0.2;

/** Fila de `token_calibration`: un único factor de corrección por modelo, no uno por `kind`
 *  (doc 07 §9 solo nombra una columna `ratio` en la tabla). */
export interface TokenCalibrationRow {
  providerId: string;
  modelName: string;
  ratio: number;      // factor de corrección multiplicativo sobre la estimación heurística
  samples: number;
  updatedAt: number;
}

/** Repositorio mínimo sobre `token_calibration`, inyectado en `createTokenEstimator`.
 *  Local a este módulo (ver cabecera): la tarea de persistencia no define este contrato todavía. */
export interface TokenCalibrationRepository {
  get(providerId: string, modelName: string): TokenCalibrationRow | undefined;
  save(row: TokenCalibrationRow): void;
}

/** Repositorio en memoria; usado como valor por defecto y en tests (no persiste entre procesos). */
export function createInMemoryTokenCalibrationRepository(): TokenCalibrationRepository {
  const rows = new Map<string, TokenCalibrationRow>();
  const key = (providerId: string, modelName: string): string => `${providerId}::${modelName}`;
  return {
    get(providerId, modelName) {
      return rows.get(key(providerId, modelName));
    },
    save(row) {
      rows.set(key(row.providerId, row.modelName), row);
    },
  };
}

function clampChars(text: string): number {
  return text.length;
}

/** `TokenCounter` heurístico ligado a UN modelo (doc 04 §8: `calibrate` no recibe `modelRef` en
 *  `estimate`, así que el factor aprendido se aplica internamente para el modelo con el que se
 *  construyó esta instancia — ver deviations). */
class HeuristicTokenEstimator implements TokenCounter {
  private factor: number;
  private samples: number;

  constructor(
    private readonly modelRef: ModelRef,
    private readonly repository: TokenCalibrationRepository,
  ) {
    const stored = repository.get(modelRef.providerId, modelRef.name);
    this.factor = stored?.ratio ?? 1;
    this.samples = stored?.samples ?? 0;
  }

  estimate(text: string, kind: TokenKind): number {
    const chars = clampChars(text);
    const raw = chars / INITIAL_RATIOS[kind];
    return Math.max(0, Math.round(raw * this.factor));
  }

  calibrate(modelRef: ModelRef, estimated: number, measured: number): void {
    if (modelRef.providerId !== this.modelRef.providerId || modelRef.name !== this.modelRef.name) {
      // Instancia ligada a otro modelo: no corresponde mezclar calibraciones (doc 07 §9, "por modelo").
      return;
    }
    if (estimated <= 0 || measured <= 0) return;
    const observedFactor = measured / estimated;
    this.factor = this.samples === 0
      ? observedFactor
      : CALIBRATION_ALPHA * observedFactor + (1 - CALIBRATION_ALPHA) * this.factor;
    this.samples += 1;
    this.repository.save({
      providerId: this.modelRef.providerId,
      modelName: this.modelRef.name,
      ratio: this.factor,
      samples: this.samples,
      updatedAt: Date.now(),
    });
  }
}

export function createTokenEstimator(
  modelRef: ModelRef,
  repository: TokenCalibrationRepository = createInMemoryTokenCalibrationRepository(),
): TokenCounter {
  return new HeuristicTokenEstimator(modelRef, repository);
}
