// Esquema + fusión del snapshot completo de la biblioteca de Ollama — packages/runtime/src/models/
// ollamaLibrarySnapshot.ts. Define: punto 1/2 del encargo de doc 16 §12.6.
//
// `resources/model-catalog.snapshot.json` (generado por `scripts/build-model-catalog.mjs`, commiteado)
// es el volcado CRUDO de `ollama.com/library` completo (~240 familias reales, doc 16 §12.6): nombre,
// tag, tamaño, contexto, hints de capacidad, fecha — todo lo que el sitio publica sin necesitar
// instalar nada. `resources/model-catalog.json` (el catálogo curado ya existente) sigue siendo la capa
// de "uso sugerido/notas" verificada a mano (doc 13 §3: "mantenida a mano, actualizada en cada
// release") — este módulo la fusiona por nombre+tag con el snapshot en vez de reemplazarla, tal como
// pide el encargo ("el catálogo curado actual queda como capa de uso sugerido/notas que se fusiona por
// nombre").
import { z } from 'zod';
import type { ModelCatalogEntry } from './types.js';

export const OllamaLibrarySnapshotVariantSchema = z.object({
  tag: z.string(),
  sizeBytes: z.number().optional(),
  contextMax: z.number().optional(),
  vision: z.boolean(),
  updatedText: z.string().optional(),
});
export type OllamaLibrarySnapshotVariant = z.infer<typeof OllamaLibrarySnapshotVariantSchema>;

export const OllamaLibrarySnapshotFamilySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  capabilityHints: z.array(z.string()),
  sizeHints: z.array(z.string()),
  pulls: z.string().optional(),
  tagsCount: z.number().optional(),
  updatedText: z.string().optional(),
  variants: z.array(OllamaLibrarySnapshotVariantSchema),
  fetchError: z.string().optional(),
});
export type OllamaLibrarySnapshotFamily = z.infer<typeof OllamaLibrarySnapshotFamilySchema>;

export const OllamaLibrarySnapshotSchema = z.object({
  generatedAt: z.string(),
  source: z.string(),
  familyCount: z.number(),
  variantCount: z.number(),
  families: z.array(OllamaLibrarySnapshotFamilySchema),
});
export type OllamaLibrarySnapshot = z.infer<typeof OllamaLibrarySnapshotSchema>;

export const DEFAULT_SNAPSHOT_PATH = 'resources/model-catalog.snapshot.json';

export function loadOllamaLibrarySnapshot(jsonText: string): OllamaLibrarySnapshot {
  const parsed: unknown = JSON.parse(jsonText);
  return OllamaLibrarySnapshotSchema.parse(parsed);
}

/** Contexto por defecto cuando ni el snapshot ni el catálogo curado lo confirman — 4096 es el mínimo
 *  histórico de Ollama antes de que la mayoría de las familias declarara `context_length` real; nunca
 *  se muestra como "medido", el llamador es quien decide qué texto de calidad ponerle (esta capa solo
 *  arma el número). */
const FALLBACK_CONTEXT_MAX = 4096;

/** Heurística de `suggestedUse` a partir de los hints de la familia (`[HIPÓTESIS A PROBAR]`: es una
 *  primera aproximación editorial, no una medición — el catálogo curado la pisa en cuanto exista una
 *  entrada a mano para ese `name`+`tag`, igual que ya pasa con `notes`/`quantization`). */
function inferSuggestedUse(capabilityHints: string[]): ModelCatalogEntry['suggestedUse'] {
  const hints = new Set(capabilityHints.map((h) => h.toLowerCase()));
  if (hints.has('embedding')) return ['analysis'];
  const use: ModelCatalogEntry['suggestedUse'] = [];
  if (hints.has('vision')) use.push('vision');
  if (hints.has('tools')) use.push('coding');
  use.push('chat');
  if (hints.has('thinking')) use.push('analysis');
  return [...new Set(use)];
}

function capabilitiesFor(family: OllamaLibrarySnapshotFamily, variant: OllamaLibrarySnapshotVariant): ModelCatalogEntry['capabilities'] {
  const hints = new Set(family.capabilityHints.map((h) => h.toLowerCase()));
  return {
    tools: hints.has('tools'),
    thinking: hints.has('thinking'),
    embedding: hints.has('embedding'),
    // El hint de familia es una foto de la PRIMERA variante que el listado destacó (doc: una familia
    // puede tener variantes mixtas, ej. una versión "-vl" con visión y otras sin ella) — la señal por
    // variante (`vision` parseado de "Text, Image" en la fila de tags) es más precisa y manda si la
    // familia no la declaró explícitamente.
    vision: hints.has('vision') || variant.vision,
  };
}

/** Aplana el snapshot crudo a `ModelCatalogEntry[]` y fusiona por `name:tag` con el catálogo curado
 *  (doc 13 §3): una entrada curada existente gana su `notes`/`quantization`/`suggestedUse` verificados
 *  a mano; sin curación, se usa la heurística de `inferSuggestedUse` y sin `notes` (nunca se inventa
 *  una nota como si fuera verificada). El tamaño/contexto SIEMPRE viene del snapshot (más fresco que
 *  cualquier curación vieja) salvo que el snapshot no lo haya podido leer, en cuyo caso se cae al valor
 *  curado si existe. */
export function mergeSnapshotWithCuratedCatalog(
  snapshot: OllamaLibrarySnapshot,
  curated: ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const curatedByKey = new Map(curated.map((entry) => [`${entry.name}:${entry.tag}`, entry]));
  const seen = new Set<string>();
  const merged: ModelCatalogEntry[] = [];

  for (const family of snapshot.families) {
    for (const variant of family.variants) {
      const key = `${family.name}:${variant.tag}`;
      seen.add(key);
      const curatedEntry = curatedByKey.get(key);
      const sizeBytes = variant.sizeBytes ?? curatedEntry?.sizeBytes;
      if (sizeBytes === undefined) continue; // sin tamaño confirmado en ninguna fuente: no se agrega (nunca inventar).
      merged.push({
        name: family.name,
        tag: variant.tag,
        sizeBytes,
        contextMax: variant.contextMax ?? curatedEntry?.contextMax ?? FALLBACK_CONTEXT_MAX,
        capabilities: curatedEntry?.capabilities ?? capabilitiesFor(family, variant),
        quantization: curatedEntry?.quantization,
        suggestedUse: curatedEntry?.suggestedUse ?? inferSuggestedUse(family.capabilityHints),
        notes: curatedEntry?.notes,
      });
    }
  }

  // Entradas curadas cuyo name:tag el snapshot no trajo (familia nueva no relevada todavía, o un tag
  // que el sitio ya no lista pero que el usuario puede seguir teniendo instalado) — se conservan tal
  // cual, la curación manual nunca desaparece por un scrape incompleto.
  for (const entry of curated) {
    const key = `${entry.name}:${entry.tag}`;
    if (!seen.has(key)) merged.push(entry);
  }

  return merged;
}
