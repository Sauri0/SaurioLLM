// Carga y valida resources/model-catalog.json — packages/runtime/src/models/catalog.ts.
// Define: doc 13 §3 y §11 ("Nomenclatura agregada": esquema por entrada). El archivo vive en
// resources/ (recurso empaquetado, no una tabla SQL); el host (apps/desktop) resuelve la ruta
// absoluta real (junto al ejecutable empaquetado o en el repo en dev) y le pasa el texto ya leído a
// `loadModelCatalog`, así este módulo no depende de rutas relativas al proceso ni de Electron.
import { z } from 'zod';
import type { ModelCatalogEntry } from './types.js';

const ModelCapabilitiesSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  thinking: z.boolean(),
  embedding: z.boolean(),
});

const ModelCatalogEntrySchema = z.object({
  name: z.string(),
  tag: z.string(),
  sizeBytes: z.number().positive(),
  capabilities: ModelCapabilitiesSchema,
  contextMax: z.number().positive(),
  quantization: z.string().optional(),
  suggestedUse: z.array(z.enum(['coding', 'chat', 'analysis', 'vision'])),
  notes: z.string().optional(),
});

const ModelCatalogSchema = z.array(ModelCatalogEntrySchema);

/** Referencia relativa al repo (doc 13 §3); el host la resuelve contra `app.getAppPath()`/`__dirname`
 *  según esté empaquetado o en dev — este módulo no la usa para leer el archivo, solo la documenta. */
export const DEFAULT_CATALOG_PATH = 'resources/model-catalog.json';

/** Parsea y valida el JSON crudo del catálogo curado; lanza si una entrada no cumple el esquema
 *  (mejor fallar temprano en el arranque que mostrar una ficha a medio llenar en la UI). */
export function loadModelCatalog(jsonText: string): ModelCatalogEntry[] {
  const parsed: unknown = JSON.parse(jsonText);
  return ModelCatalogSchema.parse(parsed);
}
