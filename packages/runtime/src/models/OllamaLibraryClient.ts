// Cliente en vivo de la biblioteca completa de Ollama, con caché y fallback al snapshot empaquetado —
// packages/runtime/src/models/OllamaLibraryClient.ts.
// Define: punto 2 del encargo de doc 16 §12.6: "mismo parser, caché en userData con TTL de 24 h, botón
// 'Actualizar catálogo', fallback al snapshot incluido si no hay red; tamaños exactos por tag resueltos
// de forma perezosa con RegistryClient al abrir la ficha (incluida la capa mmproj para visión)".
//
// Mismo parser que `scripts/build-model-catalog.mjs` (`./ollamaLibraryParser.ts`) — un solo lugar con
// la lógica de parseo de HTML. Este cliente en cambio corre DENTRO de la app (Electron main, doc 02
// §1): nunca decide dónde vive el archivo de caché ni cómo se lee el snapshot empaquetado — eso lo
// inyecta el host (apps/desktop), mismo patrón que `ManifestFetcher`/`BlobStoreProbe` de
// `DownloadManager` (packages/runtime no toca `fs`/rutas de `userData` directamente para esto, así se
// puede testear con fakes sin disco ni red real).
import { parseLibraryListHtml, parseTagsPageHtml } from './ollamaLibraryParser.js';
import type { OllamaLibrarySnapshot, OllamaLibrarySnapshotFamily } from './ollamaLibrarySnapshot.js';
import type { ManifestFetcher } from './types.js';

const LIBRARY_URL = 'https://ollama.com/library';
export const DEFAULT_LIBRARY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h, tal como pide el encargo.
const DEFAULT_CONCURRENCY = 6;

/** Puerto hacia el archivo de caché en `userData` (doc 02 §1: `apps/desktop` es quien sabe dónde vive
 *  `userData`, `packages/runtime` no importa `electron`). El host implementa esto con un JSON simple
 *  en disco, igual criterio que `SecureKeyStore`/`LocalSettingsStore`. */
export interface LibraryCachePort {
  read(): Promise<{ snapshot: OllamaLibrarySnapshot; cachedAt: number } | undefined>;
  write(snapshot: OllamaLibrarySnapshot, cachedAt: number): Promise<void>;
}

export interface OllamaLibraryClientOptions {
  fetchImpl?: typeof fetch;
  cache?: LibraryCachePort;
  ttlMs?: number;
  now?: () => number;
  concurrency?: number;
  /** Snapshot empaquetado (`resources/model-catalog.snapshot.json`, ya leído y parseado por el host) —
   *  último recurso si no hay red y no hay ninguna caché (ni vencida) en `userData`. */
  bundledSnapshot?: OllamaLibrarySnapshot;
}

export type LibraryCatalogSource = 'cache' | 'network' | 'bundled';

export interface LibraryCatalogResult {
  snapshot: OllamaLibrarySnapshot;
  source: LibraryCatalogSource;
  /** `cachedAt`/`generatedAt` del snapshot devuelto — la UI lo muestra ("Catálogo actualizado hace
   *  X"/"catálogo incluido con la app, sin conexión") en vez de fingir que siempre está fresco. */
  cachedAt?: number;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Cliente de la biblioteca completa de Ollama: sincroniza en vivo (`getCatalog`), cachea con TTL de
 *  24 h y cae al snapshot empaquetado sin red — nunca deja el Centro de modelos sin catálogo alguno. */
export class OllamaLibraryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly concurrency: number;

  constructor(private readonly opts: OllamaLibraryClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_LIBRARY_CACHE_TTL_MS;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.fetchImpl(url, { headers: { 'user-agent': 'SaurioLLM/0.1' } });
    if (!response.ok) throw new Error(`HTTP ${response.status} para ${url}`);
    return response.text();
  }

  /** Recorre `ollama.com/library` completo (listado + página de cada familia) usando el MISMO parser
   *  que `scripts/build-model-catalog.mjs` — nunca se llama automáticamente sin que el usuario lo pida
   *  (botón "Actualizar catálogo", `forceRefresh`) o la caché de 24 h haya vencido. */
  async fetchFullCatalog(): Promise<OllamaLibrarySnapshot> {
    const listHtml = await this.fetchText(LIBRARY_URL);
    const summaries = parseLibraryListHtml(listHtml);
    if (summaries.length === 0) {
      throw new Error('No se encontró ninguna familia en ollama.com/library (¿cambió el layout del sitio?)');
    }
    const families: OllamaLibrarySnapshotFamily[] = await mapWithConcurrency(summaries, this.concurrency, async (summary) => {
      try {
        const html = await this.fetchText(`${LIBRARY_URL}/${summary.name}`);
        const variants = parseTagsPageHtml(html, summary.name);
        return {
          name: summary.name, description: summary.description, capabilityHints: summary.capabilityHints,
          sizeHints: summary.sizeHints, pulls: summary.pulls, tagsCount: summary.tagsCount, updatedText: summary.updatedText,
          variants: variants.map((v) => ({ tag: v.tag, sizeBytes: v.sizeBytes, contextMax: v.contextMax, vision: v.vision, updatedText: v.updatedText })),
        };
      } catch (error) {
        return {
          name: summary.name, description: summary.description, capabilityHints: summary.capabilityHints,
          sizeHints: summary.sizeHints, pulls: summary.pulls, tagsCount: summary.tagsCount, updatedText: summary.updatedText,
          variants: [], fetchError: error instanceof Error ? error.message : String(error),
        };
      }
    });
    return {
      generatedAt: new Date(this.now()).toISOString(),
      source: LIBRARY_URL,
      familyCount: families.length,
      variantCount: families.reduce((sum, f) => sum + f.variants.length, 0),
      families,
    };
  }

  /** Punto 2 del encargo: caché en `userData` con TTL de 24 h, "Actualizar catálogo" fuerza el
   *  refresco (`forceRefresh: true`, salteando la caché aunque no haya vencido), y si la red falla se
   *  cae primero a la caché (aunque esté vencida — "algo" es mejor que nada) y por último al snapshot
   *  empaquetado si no hay ninguna caché todavía (primera vez que se abre la app sin red). */
  async getCatalog(opts: { forceRefresh?: boolean } = {}): Promise<LibraryCatalogResult> {
    const now = this.now();
    if (!opts.forceRefresh && this.opts.cache) {
      const cached = await this.opts.cache.read();
      if (cached && now - cached.cachedAt < this.ttlMs) {
        return { snapshot: cached.snapshot, source: 'cache', cachedAt: cached.cachedAt };
      }
    }
    try {
      const snapshot = await this.fetchFullCatalog();
      await this.opts.cache?.write(snapshot, now);
      return { snapshot, source: 'network', cachedAt: now };
    } catch (networkError) {
      const cached = await this.opts.cache?.read();
      if (cached) return { snapshot: cached.snapshot, source: 'cache', cachedAt: cached.cachedAt };
      if (this.opts.bundledSnapshot) return { snapshot: this.opts.bundledSnapshot, source: 'bundled' };
      throw networkError;
    }
  }

  /** Punto 2 del encargo: "tamaños exactos por tag resueltos de forma perezosa con RegistryClient al
   *  abrir la ficha (incluida la capa mmproj para visión)". El manifest ya trae TODAS las capas del tag
   *  (`model`, `projector`/mmproj, `template`, `license`, `params`, doc 13 §3) — sumarlas todas ya
   *  incluye el proyector de visión cuando existe, sin lógica especial. `hasProjector` se expone aparte
   *  para que la UI pueda mostrar "incluye proyector de visión" en la ficha. */
  async resolveExactSize(manifestFetcher: ManifestFetcher, name: string, tag: string): Promise<{ sizeBytes: number; hasProjector: boolean }> {
    const manifest = await manifestFetcher.fetchManifest(`${name}:${tag}`);
    const allLayers = manifest.config ? [...manifest.layers, manifest.config] : manifest.layers;
    const sizeBytes = allLayers.reduce((sum, layer) => sum + layer.size, 0);
    const hasProjector = manifest.layers.some((layer) => (layer.mediaType ?? '').includes('projector'));
    return { sizeBytes, hasProjector };
  }
}
