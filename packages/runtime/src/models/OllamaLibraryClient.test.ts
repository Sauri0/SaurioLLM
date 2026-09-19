// Tests de OllamaLibraryClient: caché con TTL de 24h, fallback a caché vencida y a snapshot
// empaquetado sin red, botón "Actualizar catálogo" (forceRefresh), stale-while-revalidate (doc 16
// §16.5: sin caché vigente, la caché vencida/el snapshot empaquetado se devuelven de inmediato y la
// sincronización real corre en segundo plano) y resolución perezosa de tamaño exacto vía
// RegistryClient (incluida la capa projector/mmproj) — packages/runtime/src/models/
// OllamaLibraryClient.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { OllamaLibraryClient, DEFAULT_LIBRARY_CACHE_TTL_MS, type LibraryCachePort } from './OllamaLibraryClient.js';
import type { OllamaLibrarySnapshot } from './ollamaLibrarySnapshot.js';
import type { ManifestFetcher, RegistryManifest } from './types.js';

const LIST_HTML = `
  <a href="/library/qwen3" class="group w-full space-y-5">
    <div title="qwen3" class="flex flex-col">
      <p class="max-w-lg break-words text-neutral-800 text-md">Qwen3 family.</p>
    </div>
  </a>
`;
const TAGS_HTML = `
  <a href="/library/qwen3:8b" class="sm:hidden flex flex-col space-y-[6px] group text-[13px] px-4 py-3">
    <p class="flex text-neutral-500">5.2GB · 40K context window · Text · 1 year ago</p>
  </a>
`;

function fakeFetch(routes: Record<string, string | (() => never)>): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const handler = routes[url];
    if (handler === undefined) throw new Error(`sin ruta fake para ${url}`);
    if (typeof handler === 'function') handler();
    return new Response(handler as string, { status: 200 });
  }) as unknown as typeof fetch;
}

function memoryCache(): LibraryCachePort & { snapshot?: { snapshot: OllamaLibrarySnapshot; cachedAt: number } } {
  const store: { value?: { snapshot: OllamaLibrarySnapshot; cachedAt: number } } = {};
  return {
    async read() { return store.value; },
    async write(snapshot, cachedAt) { store.value = { snapshot, cachedAt }; },
    get snapshot() { return store.value; },
  };
}

describe('OllamaLibraryClient.fetchFullCatalog', () => {
  it('recorre listado + tags de cada familia con el parser tolerante', async () => {
    const client = new OllamaLibraryClient({
      fetchImpl: fakeFetch({ 'https://ollama.com/library': LIST_HTML, 'https://ollama.com/library/qwen3': TAGS_HTML }),
    });
    const snapshot = await client.fetchFullCatalog();
    expect(snapshot.familyCount).toBe(1);
    expect(snapshot.variantCount).toBe(1);
    expect(snapshot.families[0]!.variants[0]).toMatchObject({ tag: '8b', sizeBytes: Math.round(5.2 * 1024 ** 3), contextMax: 40960 });
  });

  it('tira si el listado no encuentra ninguna familia (layout roto) en vez de devolver un snapshot vacío', async () => {
    const client = new OllamaLibraryClient({ fetchImpl: fakeFetch({ 'https://ollama.com/library': '<html>sin familias</html>' }) });
    await expect(client.fetchFullCatalog()).rejects.toThrow();
  });

  it('un error en la página de UNA familia no aborta el resto (tolerante)', async () => {
    const twoFamilies = `${LIST_HTML}<a href="/library/otra" class="group w-full space-y-5"></a>`;
    const client = new OllamaLibraryClient({
      fetchImpl: fakeFetch({
        'https://ollama.com/library': twoFamilies,
        'https://ollama.com/library/qwen3': TAGS_HTML,
        'https://ollama.com/library/otra': () => { throw new Error('network down'); },
      }),
    });
    const snapshot = await client.fetchFullCatalog();
    expect(snapshot.familyCount).toBe(2);
    const otra = snapshot.families.find((f) => f.name === 'otra')!;
    expect(otra.fetchError).toBeDefined();
    expect(otra.variants).toEqual([]);
    const qwen3 = snapshot.families.find((f) => f.name === 'qwen3')!;
    expect(qwen3.variants).toHaveLength(1);
  });
});

describe('OllamaLibraryClient.getCatalog (caché TTL 24h + fallback)', () => {
  it('usa la caché si no venció (sin pedir red de nuevo)', async () => {
    const fetchImpl = fakeFetch({ 'https://ollama.com/library': LIST_HTML, 'https://ollama.com/library/qwen3': TAGS_HTML });
    const cache = memoryCache();
    let now = 1_000_000;
    const client = new OllamaLibraryClient({ fetchImpl, cache, now: () => now });

    const first = await client.getCatalog();
    expect(first.source).toBe('network');
    expect(fetchImpl).toHaveBeenCalledTimes(2); // listado + 1 familia

    now += 1000; // mucho antes de las 24h
    const second = await client.getCatalog();
    expect(second.source).toBe('cache');
    expect(fetchImpl).toHaveBeenCalledTimes(2); // no volvió a pedir red
  });

  it('TTL de 24h vencido: sirve la caché vencida DE INMEDIATO (stale-while-revalidate) y sincroniza en segundo plano', async () => {
    const fetchImpl = fakeFetch({ 'https://ollama.com/library': LIST_HTML, 'https://ollama.com/library/qwen3': TAGS_HTML });
    const cache = memoryCache();
    let now = 0;
    const client = new OllamaLibraryClient({ fetchImpl, cache, now: () => now });

    await client.getCatalog(); // sin caché todavía: bloquea (sin cambios), deja la caché escrita
    now += DEFAULT_LIBRARY_CACHE_TTL_MS + 1;

    const updated = new Promise<void>((resolve) => client.once('libraryUpdated', () => resolve()));
    const second = await client.getCatalog();
    // Punto central del cambio (antes: `second.source === 'network'`, bloqueando ~13s contra
    // ollama.com/library real): ahora la caché vencida se devuelve tal cual, sin esperar la red.
    expect(second.source).toBe('cache');
    expect(second.syncing).toBe(true);

    await updated; // la sincronización en segundo plano ya terminó
    expect(fetchImpl).toHaveBeenCalledTimes(4); // listado+familia, dos veces (la de arranque + la de fondo)
    const third = await client.getCatalog();
    expect(third.source).toBe('cache'); // la caché quedó fresca con lo que trajo la sincronización de fondo
    expect(third.syncing).toBeUndefined();
  });

  it('stale-while-revalidate: la primera respuesta llega SIN esperar a que la red (lenta) termine, y la actualización llega después', async () => {
    // Fetch deliberadamente lento: el listado de ollama.com/library no resuelve hasta que el test lo
    // decide (`resolveList`) — simula los ~13s reales medidos contra el sitio (doc 16 §16.5).
    let resolveList!: (value: Response) => void;
    const listPromise = new Promise<Response>((resolve) => { resolveList = resolve; });
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === 'https://ollama.com/library') return listPromise;
      if (url === 'https://ollama.com/library/qwen3') return new Response(TAGS_HTML, { status: 200 });
      throw new Error(`sin ruta fake para ${url}`);
    }) as unknown as typeof fetch;

    const bundledSnapshot: OllamaLibrarySnapshot = {
      generatedAt: 'bundled', source: 'https://ollama.com/library', familyCount: 1, variantCount: 0, families: [],
    };
    const client = new OllamaLibraryClient({ fetchImpl, bundledSnapshot });

    let resolved = false;
    const first = client.getCatalog().then((r) => { resolved = true; return r; });
    // Deja correr los microtasks pendientes SIN resolver `listPromise` — si la primera respuesta
    // dependiera de la red lenta, `resolved` seguiría en `false` acá.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(resolved).toBe(true);

    const firstResult = await first;
    expect(firstResult.source).toBe('bundled');
    expect(firstResult.snapshot).toBe(bundledSnapshot);
    expect(firstResult.syncing).toBe(true);

    // Recién ahora "termina" la red — la actualización en segundo plano llega después.
    const updated = new Promise<{ snapshot: OllamaLibrarySnapshot; cachedAt: number }>((resolve) => client.once('libraryUpdated', resolve));
    resolveList(new Response(LIST_HTML, { status: 200 }));
    const updateResult = await updated;
    expect(updateResult.snapshot.familyCount).toBe(1);
    expect(updateResult.snapshot.variantCount).toBe(1);
  });

  it('dos pedidos mientras la caché está vencida no disparan dos sincronizaciones de fondo en paralelo', async () => {
    const fetchImpl = fakeFetch({ 'https://ollama.com/library': LIST_HTML, 'https://ollama.com/library/qwen3': TAGS_HTML });
    const cache = memoryCache();
    await cache.write(
      { generatedAt: 'x', source: 'https://ollama.com/library', familyCount: 0, variantCount: 0, families: [] },
      0,
    );
    const client = new OllamaLibraryClient({ fetchImpl, cache, now: () => DEFAULT_LIBRARY_CACHE_TTL_MS * 100 });

    const updated = new Promise<void>((resolve) => client.once('libraryUpdated', () => resolve()));
    const [a, b] = await Promise.all([client.getCatalog(), client.getCatalog()]);
    expect(a.source).toBe('cache');
    expect(b.source).toBe('cache');

    await updated;
    expect(fetchImpl).toHaveBeenCalledTimes(2); // una sola recorrida de fondo (listado + 1 familia), no dos
  });

  it('si la sincronización de fondo falla, emite "libraryUpdateFailed" (aviso no bloqueante) y no toca la caché ya mostrada', async () => {
    const cache = memoryCache();
    const staleSnapshot: OllamaLibrarySnapshot = {
      generatedAt: 'x', source: 'https://ollama.com/library', familyCount: 0, variantCount: 0, families: [],
    };
    await cache.write(staleSnapshot, 0);
    const failingFetch = vi.fn(async () => { throw new Error('sin red'); }) as unknown as typeof fetch;
    const client = new OllamaLibraryClient({ fetchImpl: failingFetch, cache, now: () => DEFAULT_LIBRARY_CACHE_TTL_MS * 100 });

    const failed = new Promise<Error>((resolve) => client.once('libraryUpdateFailed', resolve));
    const result = await client.getCatalog();
    expect(result.source).toBe('cache');
    expect(result.snapshot).toBe(staleSnapshot); // sigue mostrando lo que ya tenía, sin cambios

    const error = await failed;
    expect(error.message).toMatch(/sin red/);
    expect((await cache.read())?.snapshot).toBe(staleSnapshot); // la caché no se pisó con nada roto
  });

  it('"Actualizar catálogo" (forceRefresh) ignora una caché todavía vigente', async () => {
    const fetchImpl = fakeFetch({ 'https://ollama.com/library': LIST_HTML, 'https://ollama.com/library/qwen3': TAGS_HTML });
    const cache = memoryCache();
    const client = new OllamaLibraryClient({ fetchImpl, cache });

    await client.getCatalog();
    const forced = await client.getCatalog({ forceRefresh: true });
    expect(forced.source).toBe('network');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('sin red: cae a la caché aunque esté vencida', async () => {
    const cache = memoryCache();
    const staleSnapshot: OllamaLibrarySnapshot = {
      generatedAt: 'x', source: 'https://ollama.com/library', familyCount: 0, variantCount: 0, families: [],
    };
    await cache.write(staleSnapshot, 0);
    const failingFetch = vi.fn(async () => { throw new Error('sin red'); }) as unknown as typeof fetch;
    const client = new OllamaLibraryClient({ fetchImpl: failingFetch, cache, now: () => DEFAULT_LIBRARY_CACHE_TTL_MS * 100 });

    const result = await client.getCatalog();
    expect(result.source).toBe('cache');
    expect(result.snapshot).toBe(staleSnapshot);
  });

  it('sin red y sin ninguna caché: cae al snapshot empaquetado', async () => {
    const bundledSnapshot: OllamaLibrarySnapshot = {
      generatedAt: 'bundled', source: 'https://ollama.com/library', familyCount: 1, variantCount: 0, families: [],
    };
    const failingFetch = vi.fn(async () => { throw new Error('sin red'); }) as unknown as typeof fetch;
    const client = new OllamaLibraryClient({ fetchImpl: failingFetch, bundledSnapshot });

    const result = await client.getCatalog();
    expect(result.source).toBe('bundled');
    expect(result.snapshot).toBe(bundledSnapshot);
  });

  it('sin red, sin caché y sin snapshot empaquetado: propaga el error (nunca inventa un catálogo vacío en silencio)', async () => {
    const failingFetch = vi.fn(async () => { throw new Error('sin red'); }) as unknown as typeof fetch;
    const client = new OllamaLibraryClient({ fetchImpl: failingFetch });
    await expect(client.getCatalog()).rejects.toThrow('sin red');
  });
});

describe('OllamaLibraryClient.resolveExactSize', () => {
  function fakeManifestFetcher(manifest: RegistryManifest): ManifestFetcher {
    return { fetchManifest: vi.fn(async () => manifest) };
  }

  it('suma layers + config (tamaño exacto de descarga)', async () => {
    const client = new OllamaLibraryClient();
    const manifest: RegistryManifest = {
      layers: [{ digest: 'sha256:a', size: 1000, mediaType: 'application/vnd.ollama.image.model' }],
      config: { digest: 'sha256:cfg', size: 10 },
    };
    const result = await client.resolveExactSize(fakeManifestFetcher(manifest), 'qwen3', '8b');
    expect(result.sizeBytes).toBe(1010);
    expect(result.hasProjector).toBe(false);
  });

  it('detecta la capa projector/mmproj (modelos de visión) e la incluye en el tamaño', async () => {
    const client = new OllamaLibraryClient();
    const manifest: RegistryManifest = {
      layers: [
        { digest: 'sha256:a', size: 1000, mediaType: 'application/vnd.ollama.image.model' },
        { digest: 'sha256:b', size: 200, mediaType: 'application/vnd.ollama.image.projector' },
      ],
    };
    const result = await client.resolveExactSize(fakeManifestFetcher(manifest), 'gemma3', '4b');
    expect(result.sizeBytes).toBe(1200);
    expect(result.hasProjector).toBe(true);
  });
});
