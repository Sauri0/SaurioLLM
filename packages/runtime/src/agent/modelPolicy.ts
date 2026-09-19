// modelPolicy: resuelve el ModelRef efectivo de un agente personal — packages/runtime/src/agent/modelPolicy.ts.
// Doc 19 §1.5 (E2a "Mis agentes"): si `modelMode==='fixed'`, comportamiento actual sin cambios
// (`chat.modelRef ?? agent.model`). Si `'auto'`: usa primero candidatos locales ordenados por
// rol/hardware, verificados al máximo confirmado; después prueba modelos cargados con la misma
// condición y finalmente cae al modelo local del agente (o al builtin).
import type { AgentRole, ModelMode, ModelRef, ModelResolution } from '@saurio/shared';
import { DEFAULT_MODEL_REF } from './defaults.js';

export type FitClass = 'fits_gpu' | 'tight' | 'partial_offload' | 'no_fit';

/** Vistas mínimas de `ModelManager` que esta heurística necesita (packages/runtime/src/models, fuera
 *  de esta zona) — se inyectan acá en vez de importar el tipo completo, mismo criterio que
 *  `agent/ports.ts` (`ModelContextProbe`, `LastReadHashes`). */
export interface ModelPolicyDeps {
  /** Candidatos instalados ya ordenados por rol/hardware. Cada uno trae el máximo que el run debe
   * poder sostener; si está presente, es la fuente principal de `auto`. */
  listRecommendedRefs?: (agent: ModelModeAgent) => Promise<{ ref: ModelRef; contextMax: number }[]> | { ref: ModelRef; contextMax: number }[];
  /** Nombres de los modelos actualmente cargados en el/los provider(s) locales, en orden de
   *  preferencia (típicamente el más reciente primero). `undefined`/ausente: sin información de
   *  modelos cargados, se cae directo al modelo del agente. */
  listLoadedRefs?: () => Promise<ModelRef[]> | ModelRef[];
  /** Sin este puerto no se selecciona implícitamente ningún candidato: no se puede verificar fit. */
  fits?: (ref: ModelRef, numCtx: number) => Promise<{ fitClass: FitClass }> | { fitClass: FitClass };
  /** Máximo confirmado por modelo para el fallback de modelos cargados. Sin este dato (o `numCtx`
   * explícito) no se declara que el modelo entra usando un valor reducido inventado. */
  contextMaxForRef?: (ref: ModelRef) => Promise<number | undefined> | number | undefined;
  numCtx?: number;
}

// `partial_offload` incluye GPU+RAM y CPU-only. Es más lento, pero sigue siendo una ejecución local
// válida; descartarlo dejaba sin modelo a cualquier PC sin GPU aunque tuviera RAM suficiente.
type AcceptableFitClass = Exclude<FitClass, 'no_fit'>;
const ACCEPTABLE_FIT: ReadonlySet<FitClass> = new Set(['fits_gpu', 'tight', 'partial_offload']);

function isAcceptableFit(value: FitClass): value is AcceptableFitClass {
  return ACCEPTABLE_FIT.has(value);
}

export interface ModelModeAgent {
  modelMode?: ModelMode;
  model?: ModelRef;
  role?: AgentRole;
  systemPrompt?: string;
}

export interface ResolvedModelSelection {
  ref: ModelRef;
  resolution: ModelResolution;
}

/** `chatModelRef`: el modelo que el chat/run ya trae elegido explícitamente (el usuario lo fijó para
 *  ESTE chat) — con `modelMode: 'auto'` igual se respeta si está presente, porque "automático" decide
 *  únicamente cuando nadie eligió nada todavía (mismo criterio que el flujo `fixed` existente). */
export async function resolveModelSelection(
  agent: ModelModeAgent, chatModelRef: ModelRef | undefined, deps: ModelPolicyDeps = {},
): Promise<ResolvedModelSelection> {
  if (chatModelRef) return { ref: chatModelRef, resolution: { source: 'chat_override' } };
  if (agent.modelMode !== 'auto') {
    return agent.model
      ? { ref: agent.model, resolution: { source: 'agent_fixed' } }
      : { ref: DEFAULT_MODEL_REF, resolution: { source: 'builtin_fallback' } };
  }

  if (deps.listRecommendedRefs) {
    try {
      for (const candidate of await deps.listRecommendedRefs(agent)) {
        if (candidate.ref.locality !== 'local') continue;
        if (!deps.fits) continue;
        try {
          const estimate = await deps.fits(candidate.ref, candidate.contextMax);
          if (isAcceptableFit(estimate.fitClass)) return {
            ref: candidate.ref,
            resolution: {
              source: 'automatic_recommendation', contextMax: candidate.contextMax,
              fitClass: estimate.fitClass, fitQuality: 'estimated',
            },
          };
        } catch {
          // Un candidato roto no invalida los siguientes del ranking.
        }
      }
    } catch {
      // El inventario/recomendador es best-effort. Se conserva el fallback local de abajo.
    }
  }

  if (deps.listLoadedRefs) {
    try {
      const loaded = await deps.listLoadedRefs();
      for (const ref of loaded) {
        if (ref.locality !== 'local') continue;
        if (!deps.fits) continue;
        try {
          const confirmedContext = deps.contextMaxForRef ? await deps.contextMaxForRef(ref) : deps.numCtx;
          if (confirmedContext === undefined || confirmedContext <= 0) continue;
          const estimate = await deps.fits(ref, confirmedContext);
          if (isAcceptableFit(estimate.fitClass)) return {
            ref,
            resolution: {
              source: 'automatic_loaded', contextMax: confirmedContext,
              fitClass: estimate.fitClass, fitQuality: 'estimated',
            },
          };
        } catch {
          // Igual que arriba: se sigue con el próximo modelo local.
        }
      }
    } catch {
      // Provider caído/no disponible en este boot: se cae al modelo del agente de abajo, nunca
      // rompe la resolución del run por esto (doc 10 §1 "nunca perder trabajo" pesa más acá).
    }
  }
  // El modelo guardado en el perfil es un último candidato, no un fallback ciego. También se valida
  // al máximo confirmado para no convertir un perfil legacy en una promesa falsa de compatibilidad.
  if (agent.model?.locality === 'local' && deps.fits) {
    try {
      const confirmedContext = deps.contextMaxForRef ? await deps.contextMaxForRef(agent.model) : deps.numCtx;
      if (confirmedContext !== undefined && confirmedContext > 0) {
        const estimate = await deps.fits(agent.model, confirmedContext);
        if (isAcceptableFit(estimate.fitClass)) return {
          ref: agent.model,
          resolution: {
            source: 'automatic_profile', contextMax: confirmedContext,
            fitClass: estimate.fitClass, fitQuality: 'estimated',
          },
        };
      }
    } catch {
      // Se informa el mismo error accionable que para inventario/recomendador no disponible.
    }
  }

  throw new Error(
    'saurio: el modo automático no encontró un modelo local que entre en la memoria disponible ' +
    'al máximo contexto confirmado. Instalá un modelo local más chico o elegí uno explícitamente.',
  );
}

/** API histórica: conserva el ModelRef plano para callers que no necesitan persistir procedencia. */
export async function resolveModelRef(
  agent: ModelModeAgent, chatModelRef: ModelRef | undefined, deps: ModelPolicyDeps = {},
): Promise<ModelRef> {
  return (await resolveModelSelection(agent, chatModelRef, deps)).ref;
}
