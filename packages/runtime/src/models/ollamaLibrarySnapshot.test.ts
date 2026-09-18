// Tests de esquema + fusión del snapshot completo con el catálogo curado —
// packages/runtime/src/models/ollamaLibrarySnapshot.test.ts.
import { describe, expect, it } from 'vitest';
import { loadOllamaLibrarySnapshot, mergeSnapshotWithCuratedCatalog, type OllamaLibrarySnapshot } from './ollamaLibrarySnapshot.js';
import type { ModelCatalogEntry } from './types.js';

function snapshot(overrides: Partial<OllamaLibrarySnapshot> = {}): OllamaLibrarySnapshot {
  return {
    generatedAt: '2026-09-18T00:00:00.000Z',
    source: 'https://ollama.com/library',
    familyCount: 1,
    variantCount: 2,
    families: [
      {
        name: 'qwen3',
        description: 'Qwen3 family',
        capabilityHints: ['tools', 'thinking'],
        sizeHints: ['8b', '4b'],
        pulls: '10M',
        tagsCount: 2,
        variants: [
          { tag: '8b', sizeBytes: 5_225_388_164, contextMax: 40960, vision: false },
          { tag: '4b', sizeBytes: 2_497_293_931, contextMax: 40960, vision: false },
        ],
      },
    ],
    ...overrides,
  };
}

describe('loadOllamaLibrarySnapshot', () => {
  it('parsea un JSON válido', () => {
    const parsed = loadOllamaLibrarySnapshot(JSON.stringify(snapshot()));
    expect(parsed.families).toHaveLength(1);
  });

  it('rechaza un JSON que no cumple el esquema', () => {
    expect(() => loadOllamaLibrarySnapshot(JSON.stringify({ foo: 'bar' }))).toThrow();
  });
});

describe('mergeSnapshotWithCuratedCatalog', () => {
  const curated: ModelCatalogEntry[] = [{
    name: 'qwen3', tag: '8b', sizeBytes: 1, // tamaño curado viejo — el del snapshot debe ganar
    capabilities: { tools: true, thinking: true, vision: false, embedding: false },
    contextMax: 999, quantization: 'Q4_K_M', suggestedUse: ['coding', 'chat', 'analysis'],
    notes: 'Medido en este equipo.',
  }];

  it('el tamaño/contexto del snapshot pisa al curado (más fresco)', () => {
    const merged = mergeSnapshotWithCuratedCatalog(snapshot(), curated);
    const entry = merged.find((e) => e.name === 'qwen3' && e.tag === '8b')!;
    expect(entry.sizeBytes).toBe(5_225_388_164);
    expect(entry.contextMax).toBe(40960);
  });

  it('notes/quantization/suggestedUse curados se conservan cuando existe la entrada', () => {
    const merged = mergeSnapshotWithCuratedCatalog(snapshot(), curated);
    const entry = merged.find((e) => e.name === 'qwen3' && e.tag === '8b')!;
    expect(entry.notes).toBe('Medido en este equipo.');
    expect(entry.quantization).toBe('Q4_K_M');
    expect(entry.suggestedUse).toEqual(['coding', 'chat', 'analysis']);
  });

  it('una variante sin curación usa la heurística de suggestedUse y no inventa notes', () => {
    const merged = mergeSnapshotWithCuratedCatalog(snapshot(), curated);
    const entry = merged.find((e) => e.name === 'qwen3' && e.tag === '4b')!;
    expect(entry.notes).toBeUndefined();
    expect(entry.suggestedUse).toContain('coding');
    expect(entry.suggestedUse).toContain('chat');
    expect(entry.suggestedUse).toContain('analysis'); // thinking hint
  });

  it('una entrada curada que el snapshot no trajo se conserva igual', () => {
    const onlyCurated: ModelCatalogEntry[] = [...curated, {
      name: 'gemma4', tag: '26b', sizeBytes: 18_604_148_513,
      capabilities: { tools: true, thinking: true, vision: true, embedding: false },
      contextMax: 262144, suggestedUse: ['chat'], notes: 'Solo curado, familia no relevada en este snapshot.',
    }];
    const merged = mergeSnapshotWithCuratedCatalog(snapshot(), onlyCurated);
    expect(merged.find((e) => e.name === 'gemma4' && e.tag === '26b')).toBeDefined();
  });

  it('embedding hint fuerza suggestedUse = ["analysis"]', () => {
    const embSnapshot = snapshot({
      families: [{
        name: 'all-minilm', description: undefined, capabilityHints: ['embedding'], sizeHints: [],
        variants: [{ tag: 'latest', sizeBytes: 45_960_996, contextMax: 512, vision: false }],
      }],
    });
    const merged = mergeSnapshotWithCuratedCatalog(embSnapshot, []);
    expect(merged[0]!.suggestedUse).toEqual(['analysis']);
    expect(merged[0]!.capabilities.embedding).toBe(true);
  });

  it('sin tamaño en snapshot NI en curado, la variante no se agrega (nunca inventar)', () => {
    const noSize = snapshot({
      families: [{
        name: 'algo-nuevo', capabilityHints: [], sizeHints: [],
        variants: [{ tag: 'latest', vision: false }],
      }],
    });
    const merged = mergeSnapshotWithCuratedCatalog(noSize, []);
    expect(merged.find((e) => e.name === 'algo-nuevo')).toBeUndefined();
  });
});
