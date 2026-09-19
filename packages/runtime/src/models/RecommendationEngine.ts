// RecommendationEngine (v0.3, doc 13 §8): hardware × catálogo × model_compat -> tarjetas ordenadas.
// packages/runtime/src/models/RecommendationEngine.ts. Implementa la interfaz `RecommendationEngine`
// de ./types.ts (contrato, no se modifica). Función mayormente pura: no escribe `model_compat`
// (Benchmark, v0.3, fuera de esta zona) ni descarga nada; solo lee el catálogo y el HardwareProfile
// ya muestreado y opcionalmente consulta `model_compat` vía el puerto `TestedLookup` inyectado.
import type {
  HardwareProfile, ModelCatalogEntry, Recommendation, RecommendationEngine as RecommendationEngineContract,
} from './types.js';

const SAFETY_MARGIN_BYTES = 512 * 1024 * 1024;
const ENRICHMENT_UNAVAILABLE = Symbol.for('saurio.recommendation-enrichment-unavailable');

function isEnrichmentUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, ENRICHMENT_UNAVAILABLE) === true;
}

/** Sin instalar el modelo no hay `model_info` para la fórmula de MemoryEstimator. Este proxy escala
 * el margen con el contexto máximo anunciado y siempre se expone como `estimated`; para instalados
 * se prefiere el lookup inyectado con ese mismo contexto máximo. */
function estimatedTotalBytes(sizeBytes: number, contextMax: number): number {
  const contextScale = Math.max(1, contextMax / 16_384);
  return sizeBytes + Math.max(sizeBytes * 0.15 * contextScale, 512 * 1024 * 1024);
}

export interface TestedLookup {
  /** Fila de `model_compat` con `status = 'fits'` para este modelo y `hardwareFingerprint` exactos
   *  (doc 13 §8, Benchmark v0.3); `undefined` si nunca se corrió el Banco de pruebas en este equipo. */
  lookup(catalogEntry: ModelCatalogEntry, hardwareFingerprint: string): Promise<{ tokPerSec: number; testedAt: number } | undefined>;
}

/** `fits()` de MemoryEstimator para un modelo instalado, siempre al máximo confirmado. Su calidad
 * sigue siendo `estimated` salvo que un sample/model_compat confirme carga en el mismo equipo y
 * contexto; hardware medido por sí solo no vuelve medida a la estimación. */
export interface InstalledFitLookup {
  fitClassFor(catalogEntry: ModelCatalogEntry, contextMax: number, hardwareFingerprint: string): Promise<{
    fitClass: Recommendation['fitClass'];
    fitQuality: 'measured' | 'estimated';
    contextUsed: number;
  } | undefined>;
}

/** Señala que el enriquecimiento con el inventario local no está disponible en este momento.
 * El adaptador concreto debe convertir únicamente fallos esperables del proveedor a este error;
 * los errores de datos o programación siguen propagándose. */
export class RecommendationEnrichmentUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('El inventario local no está disponible para enriquecer recomendaciones.', { cause });
    this.name = 'RecommendationEnrichmentUnavailableError';
    Object.defineProperty(this, ENRICHMENT_UNAVAILABLE, { value: true });
  }
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
    const ramAvailable = Math.max(hardware.ram.freeBytes.value - SAFETY_MARGIN_BYTES, 0);
    const integrated = hardware.gpu?.integrated === true;
    const rawVramAvailable = Math.max(vramTotal - vramUsed - SAFETY_MARGIN_BYTES, 0);
    // En memoria unificada, la VRAM anunciada es un techo dentro de la RAM compartida. Acotarla por
    // la RAM libre evita recomendar como GPU-fit algo que el sistema ya no puede reservar.
    const vramAvailable = integrated ? Math.min(rawVramAvailable, ramAvailable) : rawVramAvailable;

    // Doc 13 §8 regla 1: filtra por capabilities requeridas ("coding"/"agent" exige tools; "vision"
    // exige vision"). "chat"/"analysis" no exigen ninguna capability extra.
    const filtered = this.catalog.filter((entry) => {
      if (entry.cloud) return false;
      if (!entry.suggestedUse.includes(use)) return false;
      if (use === 'coding' && !entry.capabilities.tools) return false;
      if (use === 'vision' && !entry.capabilities.vision) return false;
      return true;
    });

    const results: Recommendation[] = [];
    let enrichmentAvailable = true;
    for (const entry of filtered) {
      let installedAssessment: Awaited<ReturnType<InstalledFitLookup['fitClassFor']>>;
      if (enrichmentAvailable) {
        try {
          installedAssessment = await this.installedFit?.fitClassFor(entry, entry.contextMax, hardware.fingerprint);
        } catch (error) {
          if (!isEnrichmentUnavailable(error)) throw error;
          // Un motor apagado no impide recomendar la primera descarga. Evita además repetir el
          // mismo timeout en los otros enriquecimientos y conserva estimaciones explícitas.
          enrichmentAvailable = false;
        }
      }
      const fitClass = installedAssessment?.fitClass
        ?? this.estimateFitClass(entry, vramAvailable, ramAvailable, integrated);
      const fitQuality = installedAssessment?.fitQuality ?? 'estimated';
      const contextUsed = installedAssessment?.contextUsed ?? entry.contextMax;
      const usesCpuOffload = fitClass === 'partial_offload';
      const speedHint: Recommendation['speedHint'] =
        fitClass === 'fits_gpu' ? 'fast' : fitClass === 'tight' ? 'medium' : 'slow';

      let testedRow: Awaited<ReturnType<TestedLookup['lookup']>>;
      if (enrichmentAvailable && this.tested && hardware.fingerprint) {
        try {
          testedRow = await this.tested.lookup(entry, hardware.fingerprint);
        } catch (error) {
          if (!isEnrichmentUnavailable(error)) throw error;
          enrichmentAvailable = false;
        }
      }

      results.push({
        catalogEntry: entry,
        fitClass,
        locality: 'local', // doc 13 §9: el Centro de modelos solo recomienda providers locales en el MVP/v0.3
        speedHint,
        usesCpuOffload,
        fitQuality,
        contextUsed,
        reason: this.reasonFor(entry, fitClass, fitQuality, contextUsed),
        tested: testedRow
          ? { tokPerSec: testedRow.tokPerSec, testedAt: testedRow.testedAt, hardwareFingerprint: hardware.fingerprint }
          : undefined,
      });
    }

    const fitRank: Record<Recommendation['fitClass'], number> = { fits_gpu: 0, tight: 1, partial_offload: 2, no_fit: 3 };
    results.sort((a, b) => {
      const byFit = fitRank[a.fitClass] - fitRank[b.fitClass];
      if (byFit !== 0) return byFit;
      if (goal === 'speed') {
        if (a.tested && b.tested && a.tested.tokPerSec !== b.tested.tokPerSec) return b.tested.tokPerSec - a.tested.tokPerSec;
        return a.catalogEntry.sizeBytes - b.catalogEntry.sizeBytes || (b.contextUsed ?? b.catalogEntry.contextMax) - (a.contextUsed ?? a.catalogEntry.contextMax);
      }
      // Un `partial_offload` estimado no confirma que el SO pueda reservar en ese instante todos los
      // pesos, KV y buffers calculados. Dentro de esa clase conviene dejar margen y elegir primero el
      // modelo menor. Una medición real de compatibilidad sigue teniendo prioridad sobre la fórmula.
      if (a.fitClass === 'partial_offload' && b.fitClass === 'partial_offload') {
        if (a.fitQuality !== b.fitQuality) return a.fitQuality === 'measured' ? -1 : 1;
        if (a.fitQuality === 'estimated') {
          return a.catalogEntry.sizeBytes - b.catalogEntry.sizeBytes
            || (b.contextUsed ?? b.catalogEntry.contextMax) - (a.contextUsed ?? a.catalogEntry.contextMax);
        }
      }
      // goal === 'quality': el catálogo de este MVP no trae un `quality_score` curado explícito
      // (doc 13 §8 punto 3 lo permite como fallback); se usa el tamaño de pesos como proxy documentado
      // — mayor tamaño primero — hasta que Benchmark (v0.3) aporte `model_compat.quality_score` real.
      return b.catalogEntry.sizeBytes - a.catalogEntry.sizeBytes || (b.contextUsed ?? b.catalogEntry.contextMax) - (a.contextUsed ?? a.catalogEntry.contextMax);
    });
    return results;
  }

  private estimateFitClass(entry: ModelCatalogEntry, vramAvailable: number, ramAvailable: number, integrated: boolean): Recommendation['fitClass'] {
    const needed = estimatedTotalBytes(entry.sizeBytes, entry.contextMax);
    const combinedAvailable = integrated ? ramAvailable : vramAvailable + ramAvailable;
    if (needed <= vramAvailable) return 'fits_gpu';
    if (needed <= vramAvailable * 1.05 && needed <= combinedAvailable) return 'tight';
    if (needed <= combinedAvailable) return 'partial_offload';
    return 'no_fit';
  }

  private reasonFor(entry: ModelCatalogEntry, fitClass: Recommendation['fitClass'], quality: 'measured' | 'estimated', contextUsed: number): string {
    const evidence = quality === 'measured' ? 'Carga confirmada' : 'Estimación de memoria';
    const context = `${Math.round(contextUsed / 1024)}k de contexto`;
    const tools = entry.capabilities.tools ? 'Compatible con herramientas.' : 'Sin soporte de herramientas.';
    if (fitClass === 'fits_gpu') return `${tools} ${evidence} para ${context}: entra en GPU.`;
    if (fitClass === 'tight') return `${tools} ${evidence} para ${context}: entra justo en GPU.`;
    if (fitClass === 'partial_offload') {
      const margin = quality === 'estimated'
        ? ' Entre alternativas con offload estimado se priorizan modelos más chicos para dejar margen de memoria.'
        : '';
      return `${tools} ${evidence} para ${context}: requiere offload a RAM/CPU y puede responder más lento.${margin}`;
    }
    return `${tools} ${evidence} para ${context}: la memoria disponible no alcanza.`;
  }
}
