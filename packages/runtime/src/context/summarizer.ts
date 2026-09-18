// Summarizer inyectable + CompactionSummary — packages/runtime/src/context/summarizer.ts.
// Define: doc 07-context-manager.md §7.3 (resumen estructurado de nivel 2, `format` fijo) y doc 04,
// "Nomenclatura agregada" (`CompactionSummary` documentado en el doc 07, no en ./types.ts — se declara
// acá localmente, ver deviations). `Summarizer` tampoco está en ./types.ts (que no se modifica): es la
// interfaz de inyección que le permite a `Compactor` pedirle un resumen "al modelo" (doc de la tarea)
// sin acoplarse a `ModelGateway` (fuera de los directorios asignados a esta tarea).
import type { ChatMessage, ModelRef } from '@saurio/shared';

/** Esquema fijo del resumen de compactación de nivel 2 (doc 07 §7.3), verbatim. */
export interface CompactionSummary {
  objetivo: string;
  archivos_tocados: string[];
  decisiones: string[];
  descubrimientos: string[];
  pendientes: string[];
  ultimo_error: string | null;
}

/** JSON Schema del `format`/`argsSchema` para pedirle el resumen al modelo (doc 07 §7.3: "con format
 *  schema"). Se expresa como objeto plano (no zod) porque viaja tal cual en `ChatRequest.format`. */
export const COMPACTION_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    objetivo: { type: 'string' },
    archivos_tocados: { type: 'array', items: { type: 'string' } },
    decisiones: { type: 'array', items: { type: 'string' } },
    descubrimientos: { type: 'array', items: { type: 'string' } },
    pendientes: { type: 'array', items: { type: 'string' } },
    ultimo_error: { type: ['string', 'null'] },
  },
  required: [
    'objetivo', 'archivos_tocados', 'decisiones', 'descubrimientos', 'pendientes', 'ultimo_error',
  ],
  additionalProperties: false,
} as const;

/** Pide un `CompactionSummary` "al modelo del run" (doc 07 §7.2/§7.3: mismo modelo, `think: false`).
 *  La implementación real vive fuera de este módulo (habla con `ModelGateway.chat`, fuera del alcance
 *  de directorios asignados); acá solo se define el contrato que `Compactor` inyecta. */
export interface Summarizer {
  summarize(input: { candidates: ChatMessage[]; model: ModelRef }): Promise<CompactionSummary>;
}

/** Lanza siempre: usado cuando todavía no hay una implementación real conectada al `ModelGateway`.
 *  `Compactor` cae al "Plan B" de nivel 1 puro (doc 07 §7.3) cuando esto falla. */
export class UnavailableSummarizer implements Summarizer {
  async summarize(): Promise<CompactionSummary> {
    throw new Error('Summarizer no disponible: no hay ModelGateway conectado (doc 07 §7.3, Plan B).');
  }
}
