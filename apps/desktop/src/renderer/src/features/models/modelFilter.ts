import type { Locality, ModelInfo } from '@saurio/shared';

export type ModelLocalityFilter = 'all' | 'local' | 'lan' | 'cloud';

export interface ModelFilterState {
  query: string;
  locality: ModelLocalityFilter;
  providerId: string;
  tools: boolean;
  vision: boolean;
  minContext: number | undefined;
  favoritesOnly: boolean;
  recentsOnly: boolean;
  freeOnly: boolean;
  costOrder: 'none' | 'low-to-high';
}

export const DEFAULT_MODEL_FILTERS: ModelFilterState = {
  query: '', locality: 'all', providerId: 'all', tools: false, vision: false, minContext: undefined, favoritesOnly: false, recentsOnly: false, freeOnly: false, costOrder: 'none',
};

export function modelIdentity(model: Pick<ModelInfo, 'ref'>): string {
  return `${model.ref.providerId}::${model.ref.name}`;
}

export function uniqueModels(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = modelIdentity(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchesLocality(model: ModelInfo, locality: ModelLocalityFilter): boolean {
  if (locality === 'all') return true;
  if (locality === 'cloud') return model.ref.locality === 'cloud' || model.ref.locality === 'proxied-cloud';
  return model.ref.locality === locality;
}

export function filterModels(models: ModelInfo[], filters: ModelFilterState, memberships: { favoriteIds?: ReadonlySet<string>; recentIds?: ReadonlySet<string> } = {}): ModelInfo[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const filtered = uniqueModels(models).filter((model) => {
    const searchable = [model.ref.name, model.ref.providerId, model.family, model.parameterSize].join(' ').toLocaleLowerCase();
    return (!query || searchable.includes(query))
      && matchesLocality(model, filters.locality)
      && (filters.providerId === 'all' || model.ref.providerId === filters.providerId)
      && (!filters.tools || model.capabilities.tools)
      && (!filters.vision || model.capabilities.vision)
      && (filters.minContext === undefined || (model.contextMax !== undefined && model.contextMax >= filters.minContext))
      && (!filters.favoritesOnly || memberships.favoriteIds?.has(modelIdentity(model)) === true)
      && (!filters.recentsOnly || memberships.recentIds?.has(modelIdentity(model)) === true)
      // "Gratis confirmado" requiere que cada cargo conocido por el contrato esté informado y sea
      // cero: la ausencia de request/image no autoriza a convertir un costo desconocido en gratuito.
      && (!filters.freeOnly || (model.metadataSource !== undefined && model.metadataCheckedAt !== undefined
        && model.pricing?.promptUsdPerToken === 0 && model.pricing?.completionUsdPerToken === 0
        && model.pricing.requestUsd === 0 && model.pricing.imageUsd === 0));
  });
  if (filters.costOrder === 'low-to-high') {
    filtered.sort(compareModelCost);
  }
  return filtered;
}

/** Ordena por precio de entrada confirmado; los precios ausentes quedan al final y nunca valen cero. */
function compareModelCost(a: ModelInfo, b: ModelInfo): number {
  const aPrompt = a.pricing?.promptUsdPerToken;
  const bPrompt = b.pricing?.promptUsdPerToken;
  if (aPrompt === undefined && bPrompt !== undefined) return 1;
  if (aPrompt !== undefined && bPrompt === undefined) return -1;
  if (aPrompt !== undefined && bPrompt !== undefined && aPrompt !== bPrompt) return aPrompt - bPrompt;
  const aCompletion = a.pricing?.completionUsdPerToken;
  const bCompletion = b.pricing?.completionUsdPerToken;
  if (aCompletion === undefined && bCompletion !== undefined) return 1;
  if (aCompletion !== undefined && bCompletion === undefined) return -1;
  if (aCompletion !== undefined && bCompletion !== undefined && aCompletion !== bCompletion) return aCompletion - bCompletion;
  return a.ref.name.localeCompare(b.ref.name) || a.ref.providerId.localeCompare(b.ref.providerId);
}

export function hasModelFilters(filters: ModelFilterState): boolean {
  return filters.query.trim().length > 0 || filters.locality !== 'all' || filters.providerId !== 'all'
    || filters.tools || filters.vision || filters.minContext !== undefined || filters.favoritesOnly || filters.recentsOnly || filters.freeOnly || filters.costOrder !== 'none';
}

export function modelCostPerMillion(model: Pick<ModelInfo, 'pricing'>): { prompt: number; completion: number } | undefined {
  const prompt = model.pricing?.promptUsdPerToken;
  const completion = model.pricing?.completionUsdPerToken;
  if (prompt === undefined || completion === undefined) return undefined;
  return { prompt: prompt * 1_000_000, completion: completion * 1_000_000 };
}

export function localityFilterLabel(locality: ModelLocalityFilter): string {
  const labels: Record<ModelLocalityFilter, string> = { all: 'Todas', local: 'Local', lan: 'LAN', cloud: 'Nube' };
  return labels[locality];
}

export function isLocality(value: string): value is Locality {
  return value === 'local' || value === 'lan' || value === 'cloud' || value === 'proxied-cloud';
}
