// Implementación real de scripts/build-model-catalog.mjs — recorre la biblioteca completa de Ollama
// (listado + página de cada familia) y genera resources/model-catalog.snapshot.json.
// Define: punto 1 del encargo de doc 16 §12.6 ("scraper tolerante... genera un snapshot con TODAS las
// familias y variantes"). Vive como .ts separado (en vez de todo en el .mjs) para poder importar el
// parser tolerante de `packages/runtime/src/models/ollamaLibraryParser.ts` sin duplicar su lógica —
// "mismo parser" para el script y para `OllamaLibraryClient` (punto 2 del encargo).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseLibraryListHtml, parseTagsPageHtml,
  type OllamaLibraryFamilySummary, type OllamaLibraryVariant,
} from '../packages/runtime/src/models/ollamaLibraryParser.js';
import {
  OllamaLibrarySnapshotSchema,
  type OllamaLibrarySnapshot, type OllamaLibrarySnapshotFamily,
} from '../packages/runtime/src/models/ollamaLibrarySnapshot.js';

export type { OllamaLibrarySnapshot, OllamaLibrarySnapshotFamily };

const LIBRARY_URL = 'https://ollama.com/library';
/** Cortesía con el servidor: no todas las familias en paralelo (doc 13 §3 ya avisa que no hay un
 *  endpoint de catálogo pensado para esto — es HTML público de un sitio, no una API con rate limit
 *  documentado). 6 en vuelo + timeout individual generoso; un fallo en una familia no aborta el resto. */
const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = 'SaurioLLM-catalog-builder/0.1 (+https://github.com/Sauri0/SaurioLLM)';

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status} para ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

/** Semáforo simple (sin dependencias nuevas, ADR-2): a lo sumo `limit` tareas en vuelo a la vez. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function fetchFamily(summary: OllamaLibraryFamilySummary): Promise<OllamaLibrarySnapshotFamily> {
  try {
    const html = await fetchText(`${LIBRARY_URL}/${summary.name}`);
    const variants: OllamaLibraryVariant[] = parseTagsPageHtml(html, summary.name);
    return {
      name: summary.name,
      description: summary.description,
      capabilityHints: summary.capabilityHints,
      sizeHints: summary.sizeHints,
      pulls: summary.pulls,
      tagsCount: summary.tagsCount,
      updatedText: summary.updatedText,
      variants: variants.map((v) => ({
        tag: v.tag, sizeBytes: v.sizeBytes, contextMax: v.contextMax, vision: v.vision, updatedText: v.updatedText,
      })),
    };
  } catch (error) {
    return {
      name: summary.name,
      description: summary.description,
      capabilityHints: summary.capabilityHints,
      sizeHints: summary.sizeHints,
      pulls: summary.pulls,
      tagsCount: summary.tagsCount,
      updatedText: summary.updatedText,
      variants: [],
      fetchError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function buildSnapshot(
  log: (msg: string) => void = console.log,
  /** Solo para verificación manual rápida (`scripts/build-model-catalog.impl.ts` no expone CLI flags
   *  todavía): corta la lista de familias antes de pedir cada página de tags, para no tener que
   *  esperar la corrida completa al iterar sobre el parser. `main()` nunca lo pasa. */
  opts: { limit?: number } = {},
): Promise<OllamaLibrarySnapshot> {
  log(`Descargando listado de familias: ${LIBRARY_URL}`);
  const listHtml = await fetchText(LIBRARY_URL);
  let summaries = parseLibraryListHtml(listHtml);
  log(`Familias encontradas: ${summaries.length}`);
  if (opts.limit !== undefined) summaries = summaries.slice(0, opts.limit);
  if (summaries.length === 0) {
    throw new Error('parseLibraryListHtml no encontró ninguna familia — el layout de ollama.com/library pudo haber cambiado; no se genera un snapshot vacío para no pisar uno bueno anterior.');
  }

  let done = 0;
  const families = await mapWithConcurrency(summaries, CONCURRENCY, async (summary) => {
    const family = await fetchFamily(summary);
    done += 1;
    if (done % 20 === 0 || done === summaries.length) log(`  ${done}/${summaries.length} familias procesadas`);
    if (family.fetchError) log(`  [aviso] "${family.name}": ${family.fetchError}`);
    return family;
  });

  const variantCount = families.reduce((sum, f) => sum + f.variants.length, 0);
  const failedCount = families.filter((f) => f.fetchError).length;
  log(`Variantes totales: ${variantCount} (familias con error de red: ${failedCount}/${summaries.length})`);

  return {
    generatedAt: new Date().toISOString(),
    source: LIBRARY_URL,
    familyCount: families.length,
    variantCount,
    families,
  };
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export async function main(): Promise<void> {
  const snapshot = await buildSnapshot();
  // Red de seguridad barata: valida la propia salida contra el mismo esquema que después va a leer
  // `OllamaLibraryClient` (`ollamaLibrarySnapshot.ts`) — si algo del parser cambia de forma sin
  // actualizar el esquema, el script falla acá en vez de commitear un snapshot que el cliente no puede
  // leer.
  OllamaLibrarySnapshotSchema.parse(snapshot);
  const outPath = path.join(repoRoot(), 'resources', 'model-catalog.snapshot.json');
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
  console.log(`Escrito ${outPath} (${snapshot.familyCount} familias, ${snapshot.variantCount} variantes).`);
}
