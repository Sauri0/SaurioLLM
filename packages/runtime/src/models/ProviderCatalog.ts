import { ModelInfoSchema, type ModelInfo, type ModelRef, type ProviderCatalogStatus } from '@saurio/shared';

export interface CatalogProvider {
  readonly id: string;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}
export interface CatalogStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}
interface Entry { models: ModelInfo[]; updatedAt: number }

/** Catalog reads never run inference. Each provider has its own deadline and dated cache. */
export class ProviderCatalog {
  private entries = new Map<string, Entry>();
  private states = new Map<string, ProviderCatalogStatus>();
  private flights = new Map<string, Promise<ModelInfo[]>>();
  private generation = 0;
  private manualWrites = new Map<string, Promise<void>>();
  constructor(private readonly options: {
    storage?: CatalogStorage;
    timeoutMs?: number;
    maxAgeMs?: number;
    now?: () => number;
    /** Includes the provider configuration identity, never a raw secret. */
    storageKey?: (providerId: string) => string;
  } = {}) {}

  reset(): void {
    this.generation++;
    this.entries.clear();
    this.states.clear();
    this.flights.clear();
  }

  status(providerId: string): ProviderCatalogStatus {
    return this.states.get(providerId) ?? { providerId, state: 'unknown', count: 0 };
  }

  private storageKey(providerId: string): string {
    return this.options.storageKey?.(providerId) ?? `providerCatalog:${providerId}`;
  }

  async manualModels(providerId: string, locality: ModelRef['locality'], key = `${this.storageKey(providerId)}.manual`): Promise<ModelInfo[]> {
    const raw = await this.options.storage?.get(key);
    const names = Array.isArray(raw) ? raw.filter((value): value is string =>
      typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\r\n]/u.test(value) && !value.includes('\0')) : [];
    return [...new Set(names)].map((name) => ({
      ref: { providerId, name, locality }, metadataSource: 'manual', manualDefinition: true,
      digest: '', sizeBytes: 0, family: '', parameterSize: '', quantization: '',
      capabilities: { tools: false, thinking: false, vision: false, embedding: false },
    }));
  }

  updateManual(ref: ModelRef, remove = false): Promise<void> {
    if (!this.options.storage) return Promise.reject(new Error('No se puede guardar el modelo manual: almacenamiento no disponible.'));
    const name = ref.name.trim();
    if (!name || name.length > 200 || /[\r\n]/u.test(name) || name.includes('\0')) return Promise.reject(new Error('El ID del modelo no es válido.'));
    const key = `${this.storageKey(ref.providerId)}.manual`;
    const previous = this.manualWrites.get(key) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      const models = await this.manualModels(ref.providerId, ref.locality, key);
      const names = new Set(models.map((model) => model.ref.name));
      if (remove) names.delete(name); else names.add(name);
      await this.options.storage!.set(key, [...names]);
    }).finally(() => {
      if (this.manualWrites.get(key) === write) this.manualWrites.delete(key);
    });
    this.manualWrites.set(key, write);
    return write;
  }

  read(provider: CatalogProvider, refresh = false): Promise<ModelInfo[]> {
    const existing = this.flights.get(provider.id);
    if (existing) return existing;
    const generation = this.generation;
    const work = this.fetch(provider, refresh, generation).finally(() => {
      if (this.flights.get(provider.id) === work) this.flights.delete(provider.id);
    });
    this.flights.set(provider.id, work);
    return work;
  }

  private async loadCache(providerId: string, key: string, generation: number): Promise<Entry | undefined> {
    let cached = this.entries.get(providerId);
    if (!cached && this.options.storage) {
      try {
        const raw = await this.options.storage.get(key) as Partial<Entry> | null;
        const parsed = ModelInfoSchema.array().safeParse(raw?.models);
        if (parsed.success && typeof raw?.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
          && parsed.data.every((model) => model.ref.providerId === providerId)) {
          cached = { models: parsed.data, updatedAt: raw.updatedAt };
          if (generation === this.generation) this.entries.set(providerId, cached);
        }
      } catch { /* A corrupt cache does not prevent a live catalog read. */ }
    }
    return cached;
  }

  async cachedOnly(providerId: string): Promise<ModelInfo[]> {
    const generation = this.generation;
    const cached = await this.loadCache(providerId, this.storageKey(providerId), generation);
    if (generation !== this.generation || !cached) return [];
    const now = (this.options.now ?? Date.now)();
    const stale = now - cached.updatedAt >= (this.options.maxAgeMs ?? 300_000) || now < cached.updatedAt;
    const previous = this.status(providerId);
    if (previous.state === 'unknown' || (stale && previous.state === 'ready')) this.states.set(providerId, {
      providerId, state: stale ? 'stale' : 'ready', updatedAt: cached.updatedAt, count: cached.models.length,
    });
    return cached.models;
  }

  private async fetch(provider: CatalogProvider, refresh: boolean, generation: number): Promise<ModelInfo[]> {
    const now = this.options.now ?? Date.now;
    const key = this.storageKey(provider.id);
    const cached = await this.loadCache(provider.id, key, generation);
    if (generation !== this.generation) return [];
    if (!refresh && cached && now() - cached.updatedAt < (this.options.maxAgeMs ?? 300_000)
      && now() >= cached.updatedAt) {
      if (this.status(provider.id).state !== 'stale') this.states.set(provider.id, { providerId: provider.id, state: 'ready', updatedAt: cached.updatedAt, count: cached.models.length });
      return cached.models;
    }
    if (generation === this.generation) this.states.set(provider.id, { providerId: provider.id, state: 'loading', updatedAt: cached?.updatedAt, count: cached?.models.length ?? 0 });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('El proveedor tardó demasiado en responder. Reintentá actualizar su catálogo.'));
        }, this.options.timeoutMs ?? 15_000);
      });
      const models = await Promise.race([provider.listModels(controller.signal), timeout]);
      if (generation !== this.generation) return [];
      const entry = { models, updatedAt: now() };
      this.entries.set(provider.id, entry);
      this.states.set(provider.id, { providerId: provider.id, state: 'ready', updatedAt: entry.updatedAt, count: models.length });
      if (this.options.storage) {
        try { await this.options.storage.set(key, entry); }
        catch {
          if (generation === this.generation) this.states.set(provider.id, { ...this.status(provider.id), error: 'Catálogo actualizado; no se pudo guardar la caché para el próximo inicio.' });
        }
      }
      return generation === this.generation ? models : [];
    } catch (error) {
      if (generation !== this.generation) return [];
      this.states.set(provider.id, {
        providerId: provider.id, state: cached ? 'stale' : 'error', updatedAt: cached?.updatedAt,
        count: cached?.models.length ?? 0, error: error instanceof Error ? error.message : String(error),
      });
      if (cached) return cached.models;
      throw error;
    } finally { clearTimeout(timer); }
  }
}
