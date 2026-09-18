// modelPolicy: resuelve el ModelRef efectivo de un agente personal — packages/runtime/src/agent/modelPolicy.ts.
// Doc 19 §1.5 (E2a "Mis agentes"): si `modelMode==='fixed'`, comportamiento actual sin cambios
// (`chat.modelRef ?? agent.model`). Si `'auto'`: [HIPÓTESIS A PROBAR] heurística mínima — preferir el
// modelo ya cargado (`ModelGateway.status()`/`ModelManager.listLoaded()`) si cabe en el `numCtx`
// pedido (`MemoryEstimator.fits()`), si no, caer al modelo del agente (o al builtin). No hay selección
// "inteligente" por tarea todavía; se mide antes de sofisticar (doc 19 §5).
import type { ModelMode, ModelRef } from '@saurio/shared';
import { DEFAULT_MODEL_REF } from './defaults.js';

export type FitClass = 'fits_gpu' | 'tight' | 'partial_offload' | 'no_fit';

/** Vistas mínimas de `ModelManager` que esta heurística necesita (packages/runtime/src/models, fuera
 *  de esta zona) — se inyectan acá en vez de importar el tipo completo, mismo criterio que
 *  `agent/ports.ts` (`ModelContextProbe`, `LastReadHashes`). */
export interface ModelPolicyDeps {
  /** Nombres de los modelos actualmente cargados en el/los provider(s) locales, en orden de
   *  preferencia (típicamente el más reciente primero). `undefined`/ausente: sin información de
   *  modelos cargados, se cae directo al modelo del agente. */
  listLoadedRefs?: () => Promise<ModelRef[]> | ModelRef[];
  /** `undefined`: se asume que cualquier modelo cargado "entra" (no hay forma de verificarlo). */
  fits?: (ref: ModelRef, numCtx: number) => Promise<{ fitClass: FitClass }> | { fitClass: FitClass };
  numCtx?: number;
}

const ACCEPTABLE_FIT: ReadonlySet<FitClass> = new Set(['fits_gpu', 'tight']);

export interface ModelModeAgent {
  modelMode: ModelMode;
  model?: ModelRef;
}

/** `chatModelRef`: el modelo que el chat/run ya trae elegido explícitamente (el usuario lo fijó para
 *  ESTE chat) — con `modelMode: 'auto'` igual se respeta si está presente, porque "automático" decide
 *  únicamente cuando nadie eligió nada todavía (mismo criterio que el flujo `fixed` existente). */
export async function resolveModelRef(
  agent: ModelModeAgent, chatModelRef: ModelRef | undefined, deps: ModelPolicyDeps = {},
): Promise<ModelRef> {
  if (agent.modelMode !== 'auto') return chatModelRef ?? agent.model ?? DEFAULT_MODEL_REF;
  if (chatModelRef) return chatModelRef;

  if (deps.listLoadedRefs) {
    try {
      const loaded = await deps.listLoadedRefs();
      for (const ref of loaded) {
        if (!deps.fits) return ref;
        const estimate = await deps.fits(ref, deps.numCtx ?? 8192);
        if (ACCEPTABLE_FIT.has(estimate.fitClass)) return ref;
      }
    } catch {
      // Provider caído/no disponible en este boot: se cae al modelo del agente de abajo, nunca
      // rompe la resolución del run por esto (doc 10 §1 "nunca perder trabajo" pesa más acá).
    }
  }
  return agent.model ?? DEFAULT_MODEL_REF;
}
