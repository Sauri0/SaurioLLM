// Tests de la lógica pura de "Explorar" (búsqueda/filtros/orden/paginado/agrupado) —
// apps/desktop/src/renderer/src/features/models/exploreLogic.test.ts.
import { describe, expect, it } from 'vitest';
import type { CatalogItem } from '@saurio/shared';
import {
  DEFAULT_EXPLORE_FILTERS, filterCatalogItems, groupByFamily, matchesSearch, paginate, sizeBucketOf,
  sortCatalogItems,
} from './exploreLogic.js';

const GIB = 1024 * 1024 * 1024;

interface ItemOptions {
  name: string; tag: string; sizeBytes: number;
  tier?: CatalogItem['tier'];
  notes?: string;
  suggestedUse?: CatalogItem['entry']['suggestedUse'];
  capabilities?: Partial<CatalogItem['entry']['capabilities']>;
  cloud?: boolean;
}

function item(opts: ItemOptions): CatalogItem {
  return {
    entry: {
      name: opts.name, tag: opts.tag, sizeBytes: opts.sizeBytes,
      capabilities: { tools: false, thinking: false, vision: false, embedding: false, ...opts.capabilities },
      contextMax: 8192, suggestedUse: opts.suggestedUse ?? ['chat'], notes: opts.notes,
      ...(opts.cloud ? { cloud: true } : {}),
    },
    status: 'not_installed',
    tier: opts.tier,
  };
}

describe('sizeBucketOf', () => {
  it('clasifica chico/mediano/grande en los cortes de 4/15 GiB', () => {
    expect(sizeBucketOf(1 * GIB)).toBe('small');
    expect(sizeBucketOf(3.9 * GIB)).toBe('small');
    expect(sizeBucketOf(4 * GIB)).toBe('medium');
    expect(sizeBucketOf(14.9 * GIB)).toBe('medium');
    expect(sizeBucketOf(15 * GIB)).toBe('large');
    expect(sizeBucketOf(30 * GIB)).toBe('large');
  });
});

describe('matchesSearch', () => {
  const qwen = item({ name: 'qwen3', tag: '8b', sizeBytes: 5 * GIB, notes: 'Bueno para programar' });

  it('vacío matchea todo', () => {
    expect(matchesSearch(qwen, '')).toBe(true);
    expect(matchesSearch(qwen, '   ')).toBe(true);
  });
  it('matchea por nombre:tag completo, case-insensitive', () => {
    expect(matchesSearch(qwen, 'QWEN3:8B')).toBe(true);
  });
  it('matchea por nombre parcial', () => {
    expect(matchesSearch(qwen, 'qwe')).toBe(true);
  });
  it('matchea por notas', () => {
    expect(matchesSearch(qwen, 'programar')).toBe(true);
  });
  it('no matchea texto no relacionado', () => {
    expect(matchesSearch(qwen, 'gemma')).toBe(false);
  });
});

describe('filterCatalogItems', () => {
  const items: CatalogItem[] = [
    item({ name: 'qwen3', tag: '8b', sizeBytes: 5 * GIB, tier: { level: 1, label: 'Perfecto', color: 'green', explanation: '', quality: 'estimated' } }),
    item({ name: 'gemma4', tag: '31b', sizeBytes: 20 * GIB, tier: { level: 6, label: 'No recomendado', color: 'gray', explanation: '', quality: 'estimated' } }),
    item({
      name: 'llava', tag: '7b', sizeBytes: 4.5 * GIB,
      capabilities: { vision: true }, suggestedUse: ['vision'],
      tier: { level: 3, label: 'Usable', color: 'yellow', explanation: '', quality: 'estimated' },
    }),
  ];

  it('sin filtros (default), devuelve todo', () => {
    expect(filterCatalogItems(items, DEFAULT_EXPLORE_FILTERS)).toHaveLength(3);
  });

  it('filtra por uso sugerido', () => {
    const result = filterCatalogItems(items, { ...DEFAULT_EXPLORE_FILTERS, use: 'vision' });
    expect(result.map((i) => i.entry.name)).toEqual(['llava']);
  });

  it('filtra por nivel de la escala', () => {
    const result = filterCatalogItems(items, { ...DEFAULT_EXPLORE_FILTERS, tierLevel: 6 });
    expect(result.map((i) => i.entry.name)).toEqual(['gemma4']);
  });

  it('filtra por tamaño (bucket)', () => {
    const result = filterCatalogItems(items, { ...DEFAULT_EXPLORE_FILTERS, sizeBucket: 'large' });
    expect(result.map((i) => i.entry.name)).toEqual(['gemma4']);
  });

  it('combina búsqueda + filtros', () => {
    const result = filterCatalogItems(items, { ...DEFAULT_EXPLORE_FILTERS, search: 'qwen', sizeBucket: 'medium' });
    expect(result.map((i) => i.entry.name)).toEqual(['qwen3']);
  });

  // Punto 4 del encargo (doc 16, "modelos con X / sin compatibilidad para descargar"): las variantes
  // de NUBE van ocultas por defecto, y aparecen solo con showCloud: true.
  describe('showCloud (variantes de NUBE)', () => {
    const withCloud: CatalogItem[] = [
      ...items,
      item({ name: 'gpt-oss', tag: '20b-cloud', sizeBytes: 0, cloud: true }),
    ];

    it('por defecto (showCloud: false) no incluye variantes cloud', () => {
      const result = filterCatalogItems(withCloud, DEFAULT_EXPLORE_FILTERS);
      expect(result.map((i) => i.entry.name)).not.toContain('gpt-oss');
      expect(result).toHaveLength(3);
    });

    it('con showCloud: true, las variantes cloud aparecen', () => {
      const result = filterCatalogItems(withCloud, { ...DEFAULT_EXPLORE_FILTERS, showCloud: true });
      expect(result.map((i) => i.entry.name)).toContain('gpt-oss');
      expect(result).toHaveLength(4);
    });

    it('una variante cloud no se descarta por el filtro de tamaño (sizeBytes es un placeholder)', () => {
      const result = filterCatalogItems(withCloud, { ...DEFAULT_EXPLORE_FILTERS, showCloud: true, sizeBucket: 'large' });
      expect(result.map((i) => i.entry.name)).toContain('gpt-oss');
    });
  });
});

describe('sortCatalogItems', () => {
  // Nombres alfabéticamente ordenados al revés de tamaño/nivel a propósito, para que los tres modos
  // de orden den resultados DISTINTOS entre sí (si coincidieran, un bug de "ordena por el campo
  // equivocado" podría pasar desapercibido).
  const nivel3Grande = item({ name: 'a-nivel3-10gib', tag: '1', sizeBytes: 10 * GIB, tier: { level: 3, label: '', color: 'yellow', explanation: '', quality: 'estimated' } });
  const nivel1Mediano = item({ name: 'b-nivel1-5gib', tag: '1', sizeBytes: 5 * GIB, tier: { level: 1, label: '', color: 'green', explanation: '', quality: 'estimated' } });
  const sinTierChico = item({ name: 'c-sintier-1gib', tag: '1', sizeBytes: 1 * GIB, tier: undefined });
  const all = [nivel3Grande, nivel1Mediano, sinTierChico];

  it('"recommended": nivel ascendente primero (sin tier = nivel 6, al final)', () => {
    const sorted = sortCatalogItems(all, 'recommended');
    expect(sorted.map((i) => i.entry.name)).toEqual(['b-nivel1-5gib', 'a-nivel3-10gib', 'c-sintier-1gib']);
  });

  it('"name": alfabético, ignora tier/tamaño', () => {
    const sorted = sortCatalogItems(all, 'name');
    expect(sorted.map((i) => i.entry.name)).toEqual(['a-nivel3-10gib', 'b-nivel1-5gib', 'c-sintier-1gib']);
  });

  it('"size": ascendente por bytes, ignora tier/nombre', () => {
    const sorted = sortCatalogItems(all, 'size');
    expect(sorted.map((i) => i.entry.name)).toEqual(['c-sintier-1gib', 'b-nivel1-5gib', 'a-nivel3-10gib']);
  });

  it('no muta el array original', () => {
    const copy = [...all];
    sortCatalogItems(all, 'size');
    expect(all).toEqual(copy);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 95 }, (_, i) => i);

  it('divide en páginas de pageSize', () => {
    const result = paginate(items, 1, 30);
    expect(result.pageItems).toHaveLength(30);
    expect(result.pageCount).toBe(4);
    expect(result.total).toBe(95);
  });

  it('la última página trae el resto', () => {
    const result = paginate(items, 4, 30);
    expect(result.pageItems).toHaveLength(5);
  });

  it('acota page fuera de rango en vez de devolver vacío', () => {
    expect(paginate(items, 999, 30).page).toBe(4);
    expect(paginate(items, 0, 30).page).toBe(1);
  });

  it('lista vacía: 1 página, sin romper', () => {
    const result = paginate([], 1, 30);
    expect(result.pageCount).toBe(1);
    expect(result.pageItems).toEqual([]);
  });
});

describe('groupByFamily', () => {
  it('agrupa por entry.name preservando el orden de aparición', () => {
    const items: CatalogItem[] = [
      item({ name: 'qwen3', tag: '8b', sizeBytes: 5 * GIB }),
      item({ name: 'gemma4', tag: '31b', sizeBytes: 20 * GIB }),
      item({ name: 'qwen3', tag: '4b', sizeBytes: 2 * GIB }),
    ];
    const groups = groupByFamily(items);
    expect(groups.map((g) => g.name)).toEqual(['qwen3', 'gemma4']);
    expect(groups[0]?.variants.map((v) => v.entry.tag)).toEqual(['4b', '8b']); // ordenado por tamaño asc dentro de la familia
  });
});
