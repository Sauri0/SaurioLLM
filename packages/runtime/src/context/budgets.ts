// Presupuestos por bloque a partir de ContextPolicy — packages/runtime/src/context/budgets.ts.
// Define: doc 07-context-manager.md §5 (tabla de presupuestos, columna 16k = MVP) y doc 04 §8
// (interfaz `ContextBudget`, en ./types.ts, no se modifica). Los números de la tabla del doc 07 son
// puntos de partida "[HIPÓTESIS A PROBAR]", no mediciones (doc 07 §5): esta función interpola esos
// puntos de partida proporcionalmente a `numCtx` en vez de fijarlos en duro para 16k únicamente, para
// no romper si `ContextPolicy.numCtx` cambia manualmente en Settings (doc 07 §10, ajuste manual).
import type { ContextPolicy } from '../agent/types.js';
import type { ContextBudget } from './types.js';

/** Puntos medios de la columna 16k de la tabla del doc 07 §5 (system+fewshot, tools, memoria+tasks,
 *  margen); `repoMap` NO se interpola acá porque ya es un campo explícito de `ContextPolicy`. */
const BASELINE_NUM_CTX = 16_384;
const BASELINE_SYSTEM_AND_FEWSHOT = 1_600;
const BASELINE_TOOL_DEFS = 850;
const BASELINE_MEMORY_AND_TASKS = 400;
const BASELINE_MARGIN = 1_250;

function scale(value: number, numCtx: number): number {
  return Math.round((value * numCtx) / BASELINE_NUM_CTX);
}

/** Deriva un `ContextBudget` de la `ContextPolicy` vigente. `history` es lo que sobra después de los
 *  demás bloques y del margen (doc 07 §5, invariante "nunca se manda más que numCtx − reserve"). */
export function computeBudget(policy: ContextPolicy): ContextBudget {
  const total = Math.max(0, policy.numCtx - policy.reserveForResponse);
  const systemAndFewShot = scale(BASELINE_SYSTEM_AND_FEWSHOT, policy.numCtx);
  const toolDefs = scale(BASELINE_TOOL_DEFS, policy.numCtx);
  const repoMap = policy.repoMapTokens;
  const memoryAndTasks = scale(BASELINE_MEMORY_AND_TASKS, policy.numCtx);
  const margin = scale(BASELINE_MARGIN, policy.numCtx);
  const fixed = systemAndFewShot + toolDefs + repoMap + memoryAndTasks + margin;
  const history = Math.max(0, total - fixed);

  return {
    numCtx: policy.numCtx,
    reserveForResponse: policy.reserveForResponse,
    perBlock: { systemAndFewShot, toolDefs, repoMap, memoryAndTasks, history, margin },
  };
}
