// RecommendationEngine (v0.3, doc 13 §8): hardware × catálogo × model_compat -> tarjetas ordenadas.
// packages/runtime/src/models/RecommendationEngine.ts. Implementa la interfaz `RecommendationEngine`
// de ./types.ts (contrato, no se modifica). Función mayormente pura: no escribe `model_compat`
// (Benchmark, v0.3, fuera de esta zona) ni descarga nada; solo lee el catálogo y el HardwareProfile
// ya muestreado y opcionalmente consulta `model_compat` vía el puerto `TestedLookup` inyectado.
import type {
  HardwareProfile, ModelCatalogEntry, Recommendation, RecommendationEngine as RecommendationEngineContract,
} from './types.js';

const SAFETY_MARGIN_BYTES = 512 * 1024 * 1024;

/** Sin instalar el modelo no hay `model_info` (arch/block_count) para la fórmula exacta de KV cache
 *  de `MemoryEstimator` (esa fórmula necesita `/api/show`, que solo responde para modelos ya
 *  presentes localmente — doc 08 §5.2). Acá se usa un margen fijo sobre el tamaño de pesos como
 *  proxy de KV cache + buffers a un contexto moderado (8-16K): 15% del tamaño de pesos, con un piso
 *  de 512 MiB para que un modelo muy chico no salga "gratis". Esto es `[HIPÓTESIS A PROBAR]`
 *  explícito (doc 13 §8 lo permite: "los umbrales exactos, no la lógica") — en cuanto el motor
 *  recibe un modelo ya instalado, debería preferirse `MemoryEstimator.fits()` real en su lugar
 *  (ver `RecommendationEngineOptions.installedFitOverride`). */
function estimatedTotalBytes(sizeBytes: number): number {
  return sizeBytes + Math.max(sizeBytes * 0.15, 512 * 1024 * 1024);
}

export interface TestedLookup {
  /** Fila de `model_compat` con `status = 'fits'` para este modelo y `hardwareFingerprint` exactos
   *  (doc 13 §8, Benchmark v0.3); `undefined` si nunca se corrió el Banco de pruebas en este equipo. */
  lookup(catalogEntry: ModelCatalogEntry, hardwareFingerprint: string): Promise<{ tokPerSec: number; testedAt: number } | undefined>;
}

/** `fits()` real (MemoryEstimator + ModelManager) para un modelo YA instalado, si el host lo tiene a
 *  mano; permite que la recomendación de un modelo instalado use la fórmula exacta en vez del proxy
 *  de `estimatedTotalBytes` (doc 13 §8 regla 2: "usando la misma fórmula que MemoryEstimator"). */
export interface InstalledFitLookup {
  fitClassFor(catalogEntry: ModelCatalogEntry): Promise<Recommendation['fitClass'] | undefined>;
}

export class RecommendationEngine implements RecommendationEngineContract {
  constructor(
    private readonly catalog: ModelCatalogEntry[],
    private readonly tested?: TestedLookup,
    private readonly installedFit?: InstalledFitLookup,
  ) {}

  async recommend(
    hardware: HardwareProfile,
    use: ModelCatalogEntry['suggestedUse'][number],
    goal: 'speed' | 'quality',
  ): Promise<Recommendation[]> {
    const vramTotal = hardware.gpu?.vramTotalBytes.value ?? 0;
    const vramUsed = hardware.gpu?.vramUsedBytes?.value ?? 0;
    const vramAvailable = Math.max(vramTotal - vramUsed - SAFETY_MARGIN_BYTES, 0);

    // Doc 13 §8 regla 1: filtra por capabilities requeridas ("coding"/"agent" exige tools; "vision"
    // exige vision"). "chat"/"analysis" no exigen ninguna capability extra.
    const filtered = this.catalog.filter((entry) => {
      if (!entry.suggestedUse.includes(use)) return false;
      if (use === 'coding' && !entry.capabilities.tools) return false;
      if (use === 'vision' && !entry.capabilities.vision) return false;
      return true;
    });

    const results: Recommendation[] = [];
    for (const entry of filtered) {
      const overriddenFitClass = await this.installedFit?.fitClassFor(entry);
      const fitClass = overriddenFitClass ?? this.estimateFitClass(entry, vramAvailable);
      const usesCpuOffload = fitClass === 'partial_offload' || fitClass === 'no_fit';
      const speedHint: Recommendation['speedHint'] =
        fitClass === 'fits_gpu' ? 'fast' : fitClass === 'tight' ? 'medium' : 'slow';

      const testedRow = this.tested && hardware.fingerprint
        ? await this.tested.lookup(entry, hardware.fingerprint)
        : undefined;

      results.push({
        catalogEntry: entry,
        fitClass,
        locality: 'local', // doc 13 §9: el Centro de modelos solo recomienda providers locales en el MVP/v0.3
        speedHint,
        usesCpuOffload,
        tested: testedRow
          ? { tokPerSec: testedRow.tokPerSec, testedAt: testedRow.testedAt, hardwareFingerprint: hardware.fingerprint }
          : undefined,
      });
    }

    results.sort((a, b) => {
      if (goal === 'speed') return a.catalogEntry.sizeBytes - b.catalogEntry.sizeBytes;
      // goal === 'quality': el catálogo de este MVP no trae un `quality_score` curado explícito
      // (doc 13 §8 punto 3 lo permite como fallback); se usa el tamaño de pesos como proxy documentado
      // — mayor tamaño primero — hasta que Benchmark (v0.3) aporte `model_compat.quality_score` real.
      return b.catalogEntry.sizeBytes - a.catalogEntry.sizeBytes;
    });
    return results;
  }

  private estimateFitClass(entry: ModelCatalogEntry, vramAvailable: number): Recommendation['fitClass'] {
    if (vramAvailable <= 0) return 'no_fit';
    const needed = estimatedTotalBytes(entry.sizeBytes);
    if (needed <= vramAvailable) return 'fits_gpu';
    if (needed <= vramAvailable * 1.05) return 'tight';
    if (entry.sizeBytes <= vramAvailable) return 'partial_offload';
    return 'no_fit';
  }
}
