// MemoryEstimator: fórmula de VRAM (pesos + KV + overhead) — packages/runtime/src/models/MemoryEstimator.ts.
// Define: doc 08 §5.2 (fórmula exacta, HIPÓTESIS A PROBAR salvo los parámetros de entrada, que son
// VERIFICADO EN DOC OFICIAL). Implementa la interfaz `MemoryEstimator` de ./types.ts (contrato, no
// se modifica). SIEMPRE devuelve quality 'estimated' (nunca 'measured': eso solo lo escribe
// model_compat del Banco de pruebas, v0.3, doc 08 §5.4).
import type { ModelRef, ModelDescription, MemoryEstimate } from '@saurio/shared';
import type { HardwareProfile, MemoryEstimator as MemoryEstimatorContract } from './types.js';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

/** kv_cache_type efectivo no es consultable por API en modo attach (doc 08 §5.2): se asume f16
 *  salvo que el usuario lo declare en Settings (v0.2+ — no hay ese dato en el MVP). */
const DEFAULT_KV_CACHE_TYPE: KvCacheType = 'f16';
type KvCacheType = 'f16' | 'q8_0' | 'q4_0';
const BYTES_PER_ELEM: Record<KvCacheType, number> = { f16: 2, q8_0: 1.0625, q4_0: 0.5625 };

const DEFAULT_OVERHEAD_BYTES = 1 * GIB;
const SAFETY_MARGIN_BYTES = 512 * MIB;

/** Hallazgo real (equipo #2, Intel Core Ultra 9 288V + Arc 140V iGPU, sesión 2026-09-18): gemma4:26b
 *  (Q4, pesos 15.77 GiB + proyector de visión ~1.1 GiB, ambos YA sumados en `description.sizeBytes`
 *  porque es el tamaño total instalado) NO entró en ~17.2 GiB de VRAM disponible según Ollama, pese a
 *  que la suma de bytes por sí sola sugería que sí — el propio scheduler de Ollama no reserva memoria
 *  de trabajo extra para el encoder de visión al decidir cuántas capas offloadear, así que el margen
 *  real necesario es mayor que "pesos + KV + overhead genérico". `[HIPÓTESIS A PROBAR]`: 1.25 GiB es
 *  un punto de partida (apenas por encima del proyector mismo) hasta que el Banco de pruebas mida el
 *  margen real en más de un modelo de visión. */
const VISION_OVERHEAD_BYTES = 1.25 * GIB;
/** iGPU/memoria unificada (doc 13 §7): la memoria se comparte con el resto del sistema (compositor,
 *  navegador, el propio Ollama fuera de la GPU), así que hace falta más margen que en una GPU
 *  dedicada donde el sistema operativo no le disputa VRAM a nadie más. `[HIPÓTESIS A PROBAR]`: 10%
 *  del total, con el margen fijo de `SAFETY_MARGIN_BYTES` como piso. */
const INTEGRATED_GPU_SAFETY_MARGIN_RATIO = 0.10;

/** El ModelManager es quien conoce cómo pedir ModelDescription (vía Provider) y cómo calibrar el
 *  overhead con model_load_samples (EMA); MemoryEstimator no depende de Provider ni de un
 *  repositorio SQLite directamente para mantenerse una unidad pura y testeable con fixtures.
 *  Dependencias inyectadas, no definidas en @saurio/shared ni en runtime/**\/types.ts (doc 04 §11
 *  solo declara la forma del método fits(); esta interfaz de apoyo es local a este módulo). */
export interface ModelDescriber {
  describeModel(ref: ModelRef): Promise<ModelDescription>;
}

export interface OverheadCalibrator {
  /** EMA de (size_vram_medido - weights - kv_teórico) para este modelo; undefined si aún no hay
   *  muestras de model_load_samples para calibrar (usa DEFAULT_OVERHEAD_BYTES). */
  getCalibratedOverheadBytes(ref: ModelRef): Promise<number | undefined>;
}

interface ArchInfo {
  architecture: string;
  blockCount: number;
  headCountKv: number;
  headCount: number;
  keyLength?: number;
  embeddingLength: number;
  slidingWindow?: number;
}

function readNumber(info: Record<string, unknown>, key: string): number | undefined {
  const v = info[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Normaliza `model_info` de /api/show: las claves cambian de prefijo `<arch>.*` según
 *  `general.architecture` (doc 08 §2 y §5.2). */
function parseArchInfo(modelInfo: Record<string, unknown>): ArchInfo | undefined {
  const architecture = modelInfo['general.architecture'];
  if (typeof architecture !== 'string' || architecture.length === 0) return undefined;
  const prefix = architecture;
  const blockCount = readNumber(modelInfo, `${prefix}.block_count`);
  const headCountKv = readNumber(modelInfo, `${prefix}.attention.head_count_kv`);
  const headCount = readNumber(modelInfo, `${prefix}.attention.head_count`);
  const embeddingLength = readNumber(modelInfo, `${prefix}.embedding_length`);
  if (blockCount === undefined || headCountKv === undefined || headCount === undefined || embeddingLength === undefined) {
    return undefined;
  }
  return {
    architecture,
    blockCount,
    headCountKv,
    headCount,
    keyLength: readNumber(modelInfo, `${prefix}.attention.key_length`),
    embeddingLength,
    slidingWindow: readNumber(modelInfo, `${prefix}.attention.sliding_window`),
  };
}

/** ubatch fijo del server de Ollama por defecto (512); no hay endpoint para leerlo en modo attach,
 *  así que se usa la constante documentada como aproximación para el término SWA de la fórmula. */
const DEFAULT_UBATCH = 512;
const NUM_PARALLEL = 1; // fijo en el MVP (doc 08 §5.2)

function computeKvBytes(arch: ArchInfo, numCtx: number, kvCacheType: KvCacheType): number {
  const headDim = arch.keyLength ?? arch.embeddingLength / arch.headCount;
  const bytesPerElem = BYTES_PER_ELEM[kvCacheType];
  const kvBytesPerLayerPerToken = 2 * arch.headCountKv * headDim * bytesPerElem;

  if (arch.slidingWindow !== undefined && arch.slidingWindow > 0) {
    // Arquitecturas híbridas (Gemma-like): se asume, a falta de la proporción exacta de capas
    // globales/SWA en model_info, que todas las capas usan la ventana deslizante salvo la última
    // (patrón típico "1 global cada N"); esto es HIPÓTESIS A PROBAR explícita del doc 08 §5.2 y
    // deliberadamente conservadora (subestima antes que repetir la sobreestimación ~40-60x ya
    // documentada como bug corregido).
    const globalLayers = 1;
    const swaLayers = Math.max(arch.blockCount - globalLayers, 0);
    const swaCtx = Math.min(numCtx, arch.slidingWindow + DEFAULT_UBATCH);
    return kvBytesPerLayerPerToken * (globalLayers * numCtx + swaLayers * swaCtx) * NUM_PARALLEL;
  }

  return kvBytesPerLayerPerToken * arch.blockCount * numCtx * NUM_PARALLEL;
}

export class MemoryEstimator implements MemoryEstimatorContract {
  constructor(
    private readonly describer: ModelDescriber,
    private readonly calibrator?: OverheadCalibrator,
    private readonly kvCacheType: KvCacheType = DEFAULT_KV_CACHE_TYPE,
  ) {}

  async fits(ref: ModelRef, numCtx: number, hardware: HardwareProfile): Promise<MemoryEstimate> {
    const description = await this.describer.describeModel(ref);
    const weights = description.sizeBytes;
    const arch = parseArchInfo(description.modelInfo);
    const kvBytes = arch ? computeKvBytes(arch, numCtx, this.kvCacheType) : 0;
    const overhead = (await this.calibrator?.getCalibratedOverheadBytes(ref)) ?? DEFAULT_OVERHEAD_BYTES;
    // Doc 13 §7 / hallazgo real equipo #2: modelos con visión necesitan más margen del que sugiere la
    // simple suma de bytes (ver comentario de `VISION_OVERHEAD_BYTES`).
    const visionOverhead = description.capabilities.vision ? VISION_OVERHEAD_BYTES : 0;

    const vramNeededBytes = Math.round(weights + kvBytes + overhead + visionOverhead);
    const vramTotal = hardware.gpu?.vramTotalBytes.value ?? 0;
    const vramUsed = hardware.gpu?.vramUsedBytes?.value ?? 0;
    const vramFree = Math.max(vramTotal - vramUsed, 0);
    // iGPU/memoria unificada: más margen que en una GPU dedicada (ver comentario de la constante).
    const safetyMarginBytes = hardware.gpu?.integrated
      ? Math.max(SAFETY_MARGIN_BYTES, Math.round(vramTotal * INTEGRATED_GPU_SAFETY_MARGIN_RATIO))
      : SAFETY_MARGIN_BYTES;
    const vramAvailableBytes = Math.max(vramFree - safetyMarginBytes, 0);

    const fitClass: MemoryEstimate['fitClass'] =
      vramNeededBytes <= vramAvailableBytes
        ? 'fits_gpu'
        : vramNeededBytes <= vramAvailableBytes * 1.05
          ? 'tight'
          : weights <= vramAvailableBytes
            ? 'partial_offload'
            : 'no_fit';

    return {
      vramNeededBytes,
      vramAvailableBytes,
      fitClass,
      quality: 'estimated', // nunca 'measured' acá (doc 08 §5.4): eso lo escribe model_compat (v0.3)
      source: 'formula',
      hardwareFingerprint: hardware.fingerprint,
    };
  }
}
