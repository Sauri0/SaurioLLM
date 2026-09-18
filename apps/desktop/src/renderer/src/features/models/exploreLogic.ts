// Lógica pura de la pestaña "Explorar" (búsqueda, filtros, orden, paginado, agrupado por familia) —
// apps/desktop/src/renderer/src/features/models/exploreLogic.ts.
// Define: punto 5 del encargo (doc 16 §12.6): "búsqueda, filtros por uso, por nivel de la escala, por
// tamaño y por fuente ... orden por recomendación para ESTE equipo, lista virtualizada o paginada para
// cientos de modelos". Funciones puras, sin IPC ni React — así se pueden testear directo con fixtures,
// separadas de ExploreTab.tsx (que solo orquesta estado + IPC).
import type { CatalogItem } from '@saurio/shared';

export type ExploreUseFilter = 'all' | 'coding' | 'chat' | 'analysis' | 'vision';
/** `@saurio/shared` no exporta un alias `ModelTierLevel` propio (solo la forma completa
 *  `ModelTierSchema`/`CatalogItem['tier']`) — se declara acá, local a esta feature (mismo criterio que
 *  el resto del repo: "si necesitás un tipo nuevo, definilo local a tu módulo"). */
export type ModelTierLevelFilter = 1 | 2 | 3 | 4 | 5 | 6;
export type ExploreTierFilter = 'all' | ModelTierLevelFilter;
export type ExploreSizeBucket = 'all' | 'small' | 'medium' | 'large';
export type ExploreSortMode = 'recommended' | 'name' | 'size';

const GIB = 1024 * 1024 * 1024;

/** Cortes de tamaño en GiB — "chico" entra en casi cualquier GPU dedicada de gama media, "grande" son
 *  los modelos densos de 30B+ que necesitan mucha VRAM/RAM. `[DECISIÓN DE DISEÑO]`: son cortes
 *  editoriales para agrupar el filtro, no un cálculo derivado del hardware (eso ya lo hace el nivel de
 *  la escala, que es el filtro que de verdad importa para "¿me sirve en esta PC?"). */
export function sizeBucketOf(sizeBytes: number): Exclude<ExploreSizeBucket, 'all'> {
  if (sizeBytes < 4 * GIB) return 'small';
  if (sizeBytes < 15 * GIB) return 'medium';
  return 'large';
}

export const SIZE_BUCKET_LABELS: Record<Exclude<ExploreSizeBucket, 'all'>, string> = {
  small: 'Chico (< 4 GB)', medium: 'Mediano (4-15 GB)', large: 'Grande (> 15 GB)',
};

export interface ExploreFilters {
  search: string;
  use: ExploreUseFilter;
  tierLevel: ExploreTierFilter;
  sizeBucket: ExploreSizeBucket;
}

export const DEFAULT_EXPLORE_FILTERS: ExploreFilters = { search: '', use: 'all', tierLevel: 'all', sizeBucket: 'all' };

function fullName(item: CatalogItem): string {
  return `${item.entry.name}:${item.entry.tag}`;
}

export function matchesSearch(item: CatalogItem, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (q.length === 0) return true;
  return fullName(item).toLowerCase().includes(q)
    || item.entry.name.toLowerCase().includes(q)
    || (item.entry.notes ?? '').toLowerCase().includes(q);
}

export function filterCatalogItems(items: CatalogItem[], filters: ExploreFilters): CatalogItem[] {
  return items.filter((item) => (
    matchesSearch(item, filters.search)
    && (filters.use === 'all' || item.entry.suggestedUse.includes(filters.use))
    && (filters.tierLevel === 'all' || item.tier?.level === filters.tierLevel)
    && (filters.sizeBucket === 'all' || sizeBucketOf(item.entry.sizeBytes) === filters.sizeBucket)
  ));
}

/** "Recomendado para ESTE equipo" (punto 5 del encargo): nivel de la escala ascendente (1 Perfecto
 *  primero) y, a igual nivel, tamaño ascendente (el más chico que igual anda bien, primero). Sin tier
 *  (hardware no muestreado todavía) se trata como nivel 6 — al final, nunca se recomienda algo sin
 *  poder clasificarlo. */
export function sortCatalogItems(items: CatalogItem[], sortBy: ExploreSortMode): CatalogItem[] {
  const copy = [...items];
  if (sortBy === 'name') {
    copy.sort((a, b) => fullName(a).localeCompare(fullName(b)));
  } else if (sortBy === 'size') {
    copy.sort((a, b) => a.entry.sizeBytes - b.entry.sizeBytes);
  } else {
    copy.sort((a, b) => {
      const levelA = a.tier?.level ?? 6;
      const levelB = b.tier?.level ?? 6;
      if (levelA !== levelB) return levelA - levelB;
      return a.entry.sizeBytes - b.entry.sizeBytes;
    });
  }
  return copy;
}

export interface Page<T> { pageItems: T[]; pageCount: number; page: number; total: number }

/** Paginado simple (punto 5 del encargo: "lista virtualizada o paginada para cientos de modelos") —
 *  con cientos de entradas (biblioteca completa, ~850 variantes) una lista paginada de a 30 es liviana
 *  de renderizar sin depender de una librería de virtualización nueva (ADR-2: sin dependencias nuevas
 *  si no hacen falta). `page` fuera de rango se acota en vez de devolver una página vacía confusa. */
export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedPage = Math.min(Math.max(page, 1), pageCount);
  const start = (clampedPage - 1) * pageSize;
  return { pageItems: items.slice(start, start + pageSize), pageCount, page: clampedPage, total: items.length };
}

export interface FamilyGroup { name: string; variants: CatalogItem[] }

/** Agrupa por familia (`entry.name`) para la ficha lateral (punto 5 del encargo: "ficha lateral con
 *  variantes") — mantiene el orden de aparición de `items` (ya viene ordenado por `sortCatalogItems`),
 *  y dentro de cada familia ordena las variantes por tamaño ascendente (la más chica primero, más fácil
 *  de recomendar como punto de entrada). */
export function groupByFamily(items: CatalogItem[]): FamilyGroup[] {
  const order: string[] = [];
  const map = new Map<string, CatalogItem[]>();
  for (const item of items) {
    if (!map.has(item.entry.name)) { map.set(item.entry.name, []); order.push(item.entry.name); }
    map.get(item.entry.name)!.push(item);
  }
  return order.map((name) => ({
    name,
    variants: [...map.get(name)!].sort((a, b) => a.entry.sizeBytes - b.entry.sizeBytes),
  }));
}

/** Selector de contexto de la ficha (punto 5 del encargo: "selector de contexto 4k/8k/16k/32k"). */
export const NUM_CTX_OPTIONS = [4096, 8192, 16384, 32768] as const;
export type NumCtxOption = typeof NUM_CTX_OPTIONS[number];
export const DEFAULT_NUM_CTX_OPTION: NumCtxOption = 8192;
