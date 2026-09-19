import type { ModelInfo } from '@saurio/shared';

export const CONTEXT_MODELS_PAGE_SIZE = 20;

export interface ContextModelPage {
  items: ModelInfo[];
  page: number;
  pageCount: number;
  total: number;
}

/** Lista liviana para Ajustes: el catálogo puede incluir cientos de modelos API, así que buscar y
 * paginar ocurre antes de pedir detalles de contexto a los pocos modelos locales visibles. */
export function contextModelPage(models: readonly ModelInfo[], query: string, page: number): ContextModelPage {
  const normalizedQuery = query.trim().toLocaleLowerCase('es-AR');
  const filtered = normalizedQuery.length === 0
    ? [...models]
    : models.filter((model) => `${model.ref.name} ${model.ref.providerId}`.toLocaleLowerCase('es-AR').includes(normalizedQuery));
  const pageCount = Math.max(1, Math.ceil(filtered.length / CONTEXT_MODELS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * CONTEXT_MODELS_PAGE_SIZE;
  return { items: filtered.slice(start, start + CONTEXT_MODELS_PAGE_SIZE), page: safePage, pageCount, total: filtered.length };
}

export function modelKey(model: Pick<ModelInfo, 'ref'>): string {
  return `${model.ref.providerId}:${model.ref.name}`;
}
