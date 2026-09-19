import type { ModelInfo, ModelRef } from '@saurio/shared';

export const INSTALLED_PAGE_SIZES = [20, 50] as const;
export type InstalledPageSize = (typeof INSTALLED_PAGE_SIZES)[number];

export function installedModelKey(ref: Pick<ModelRef, 'providerId' | 'name'>): string {
  return `${ref.providerId}::${ref.name}`;
}

export function installedPageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function installedPage<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const safePage = Math.min(Math.max(1, page), installedPageCount(items.length, pageSize));
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/** Sólo los modelos locales visibles necesitan `/show` y estimación contra este hardware. */
export function localDetailCandidates(
  visible: readonly ModelInfo[],
  requested: ReadonlySet<string>,
): ModelInfo[] {
  return visible.filter((model) => (
    model.ref.locality === 'local'
    && model.metadataSource !== 'manual'
    && !requested.has(`${installedModelKey(model.ref)}::${model.digest}`)
  ));
}

/** Pool chico para no abrir decenas de requests `/show`/hardware a la vez. Mantiene el orden. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!, index);
    }
  }));
  return results;
}
