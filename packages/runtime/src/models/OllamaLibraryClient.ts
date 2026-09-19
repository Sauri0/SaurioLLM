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
//
// Bug real (doc 16 §16.5, "Explorar mostraba 'Página 1 de 1 (0 modelos)' durante la carga"): sin
// caché en `userData` (primera vez que se abre la app), `getCatalog()` sincronizaba en vivo las ~240
// familias de ollama.com/library ANTES de devolver nada — medido en esa sesión, ~13 s
// (`elapsedMs: 12988` para 858 variantes). El fix de esa sesión solo cubrió el síntoma en la UI
// ("Cargando catálogo…" en vez de la paginación vacía); este cambio ataca la causa: `getCatalog()`
// pasa a "stale-while-revalidate" — sin caché vigente, devuelve DE INMEDIATO la caché vencida (si hay)
// o el snapshot empaquetado (si no hay caché todavía), y dispara la sincronización real en SEGUNDO
// PLANO (`triggerBackgroundSync`, con at-most-una-en-vuelo). Al terminar esa sincronización, guarda la
// caché y emite `'libraryUpdated'` (o `'libraryUpdateFailed'` si la red falla) para que el host
// (`apps/desktop/src/main/ipc/models.ts`) arme el catálogo fusionado de nuevo y avise al renderer sin
// que el usuario tenga que esperar ni pedir nada. Solo cuando NO hay absolutamente nada para mostrar
// de inmediato (primera vez, sin red todavía, sin snapshot empaquetado) se sigue bloqueando en la
// sincronización en vivo — no hay otra opción, y es exactamente el último caso que ya cubrían los
// tests de fallback de abajo. `forceRefresh` (botón "Actualizar catálogo") tampoco cambia: sigue
// bloqueante, porque ahí el usuario mismo pidió esperar el resultado fresco.
import { EventEmitter } from 'node:events';
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
  /** `true` cuando lo que se devolvió es una caché vencida o el snapshot empaquetado Y ya se disparó
   *  una sincronización real en segundo plano (`triggerBackgroundSync`) que todavía no terminó — la UI
   *  lo usa para el aviso discreto "actualizando…" en vez de fingir que este catálogo ya es el final.
   *  Ausente/`false` en cualquier otro caso (caché vigente, resultado de red, o forceRefresh). */
  syncing?: boolean;
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

// Idioma estándar de TS para tipar los eventos de un `EventEmitter` (doc de Node/@types/node, mismo
// patrón que `DownloadManager` en este mismo paquete): la interfaz se fusiona con la clase de abajo
// para sobrecargar `on`/`emit` con la forma real de los eventos que emite, sin reimplementar
// `EventEmitter`. `@typescript-eslint/no-unsafe-declaration-merging` no distingue este caso (aditivo,
// sin miembros nuevos) del genuinamente riesgoso, así que se deshabilita puntualmente acá.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface OllamaLibraryClient {
  on(event: 'libraryUpdated', listener: (result: { snapshot: OllamaLibrarySnapshot; cachedAt: number }) => void): this;
  on(event: 'libraryUpdateFailed', listener: (error: Error) => void): this;
  once(event: 'libraryUpdated', listener: (result: { snapshot: OllamaLibrarySnapshot; cachedAt: number }) => void): this;
  once(event: 'libraryUpdateFailed', listener: (error: Error) => void): this;
  off(event: 'libraryUpdated', listener: (result: { snapshot: OllamaLibrarySnapshot; cachedAt: number }) => void): this;
  off(event: 'libraryUpdateFailed', listener: (error: Error) => void): this;
  emit(event: 'libraryUpdated', result: { snapshot: OllamaLibrarySnapshot; cachedAt: number }): boolean;
  emit(event: 'libraryUpdateFailed', error: Error): boolean;
}

/** Cliente de la biblioteca completa de Ollama: sincroniza en vivo (`getCatalog`), cachea con TTL de
 *  24 h y cae al snapshot empaquetado sin red — nunca deja el Centro de modelos sin catálogo alguno.
 *  Extiende `EventEmitter` (mismo patrón que `DownloadManager`) para avisar cuándo termina una
 *  sincronización disparada en segundo plano (`'libraryUpdated'`/`'libraryUpdateFailed'`) — el host
 *  se suscribe recién cuando existe la `BrowserWindow` a la que reenviar `models:libraryUpdated`. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class OllamaLibraryClient extends EventEmitter {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly concurrency: number;
  /** Sincronización de fondo en curso (`triggerBackgroundSync`), si hay una — evita disparar dos
   *  recorridas completas de ~240 páginas en paralelo si `getCatalog()` se llama varias veces mientras
   *  la caché sigue vencida (p. ej. varias pestañas/paneles pidiendo el catálogo casi al mismo tiempo). */
  private syncInFlight: Promise<void> | undefined;

  constructor(private readonly opts: OllamaLibraryClientOptions = {}) {
    super();
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
   *  refresco (`forceRefresh: true`, salteando la caché aunque no haya vencido, bloqueante porque el
   *  usuario mismo pidió esperar el resultado fresco).
   *
   *  Stale-while-revalidate (doc 16 §16.5, ver comentario de arriba del archivo): sin `forceRefresh`,
   *  si la caché sigue vigente se devuelve tal cual (sin red, como antes). Si no hay caché vigente
   *  (venció o nunca existió) PERO hay algo para mostrar YA MISMO — la caché vencida, o si no hay
   *  ninguna caché el snapshot empaquetado — se devuelve ESO de inmediato (marcando `source`/
   *  `cachedAt`/`syncing: true`) y se dispara `triggerBackgroundSync()` sin esperarla. Recién cuando no
   *  hay absolutamente nada que devolver de inmediato (primera vez que se abre la app, sin red
   *  todavía, sin snapshot empaquetado) se bloquea en la sincronización en vivo — último recurso, sin
   *  cambios respecto de antes — y si esa falla, se cae a la caché (aunque esté vencida) o al
   *  snapshot empaquetado igual que siempre. */
  async getCatalog(opts: { forceRefresh?: boolean } = {}): Promise<LibraryCatalogResult> {
    const now = this.now();
    const cached = this.opts.cache ? await this.opts.cache.read() : undefined;

    if (!opts.forceRefresh) {
      if (cached && now - cached.cachedAt < this.ttlMs) {
        return { snapshot: cached.snapshot, source: 'cache', cachedAt: cached.cachedAt };
      }
      const immediate: LibraryCatalogResult | undefined = cached
        ? { snapshot: cached.snapshot, source: 'cache', cachedAt: cached.cachedAt, syncing: true }
        : this.opts.bundledSnapshot
          ? { snapshot: this.opts.bundledSnapshot, source: 'bundled', syncing: true }
          : undefined;
      if (immediate) {
        this.triggerBackgroundSync();
        return immediate;
      }
    }

    try {
      const snapshot = await this.fetchFullCatalog();
      await this.opts.cache?.write(snapshot, now);
      return { snapshot, source: 'network', cachedAt: now };
    } catch (networkError) {
      if (cached) return { snapshot: cached.snapshot, source: 'cache', cachedAt: cached.cachedAt };
      if (this.opts.bundledSnapshot) return { snapshot: this.opts.bundledSnapshot, source: 'bundled' };
      throw networkError;
    }
  }

  /** Dispara la sincronización real contra ollama.com/library en segundo plano, sin bloquear a quien
   *  llamó a `getCatalog()`. `syncInFlight` asegura como mucho una recorrida completa a la vez — si ya
   *  hay una en curso, esta llamada es un no-op (la que ya está en vuelo va a terminar de todos modos y
   *  va a emitir el evento). Nunca propaga el error de red: lo emite como `'libraryUpdateFailed'` para
   *  que el host muestre un aviso no bloqueante, dejando en pantalla lo que ya se estaba mostrando. */
  private triggerBackgroundSync(): void {
    if (this.syncInFlight) return;
    const startedAt = this.now();
    this.syncInFlight = this.fetchFullCatalog()
      .then(async (snapshot) => {
        await this.opts.cache?.write(snapshot, startedAt);
        this.emit('libraryUpdated', { snapshot, cachedAt: startedAt });
      })
      .catch((error: unknown) => {
        this.emit('libraryUpdateFailed', error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.syncInFlight = undefined;
      });
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
