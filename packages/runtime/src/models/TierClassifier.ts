// TierClassifier: escala de SEIS niveles para "¿me conviene este modelo en esta PC?" —
// packages/runtime/src/models/TierClassifier.ts.
// Define: punto 3 del encargo de doc 13/16 (Centro de modelos v0.2+, sesión 2026-09-18 "cobertura
// máxima de catálogo"): "Escala de SEIS niveles ... 1 Perfecto ... 6 No recomendado instalar".
// Función PURA (sin I/O): toma números ya medidos/estimados por HardwareProbe/MemoryEstimator (o el
// proxy de RecommendationEngine para un modelo todavía no instalado) y devuelve el nivel + color +
// explicación de una línea. Nunca decide por sí sola "measured" — el llamador declara `tested` solo
// si existe una fila real de `model_compat`/medición en este equipo (mismo principio que
// RecommendationEngine.TestedLookup: "nunca se muestra un número sin que Benchmark lo haya medido").
//
// [HIPÓTESIS A PROBAR]: los umbrales exactos (0.85, 1.05, 0.5, 0.3) son un punto de partida razonable
// para separar los seis niveles a partir de los cuatro `fitClass` que ya calcula `MemoryEstimator`/
// `RecommendationEngine` (`fits_gpu | tight | partial_offload | no_fit`) — la lógica de separación
// (¿el modelo completo entra en la GPU con margen? ¿entran los pesos aunque no el KV cache? ¿entran
// en RAM? ¿entra en disco?) no es hipótesis, los cortes numéricos sí. Ver TierClassifier.test.ts para
// los tres escenarios que pide el encargo (8 GB, 24 GB, solo CPU) y el caso de "medido: no entra" que
// fuerza nivel 6 sin importar la fórmula (doc 13 §1: el caso real de `gemma4:31b`, `cudaMalloc failed:
// out of memory`, es justo el tipo de resultado que `model_compat.status` puede registrar).
import type { HardwareProfile } from './types.js';

export type ModelTierLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Nombre de color por nivel — el renderer lo mapea a una clase CSS con tokens
 *  (`--saurio-tier-<color>`, `features/models/models.css`), nunca un hex hardcodeado acá (esta capa
 *  es pura y no depende de CSS). */
export type ModelTierColor = 'green' | 'teal' | 'yellow' | 'orange' | 'red' | 'gray';

export interface ModelTier {
  level: ModelTierLevel;
  /** Etiqueta corta en español, la misma nomenclatura del encargo. */
  label: string;
  color: ModelTierColor;
  /** Explicación de una línea, en español simple (punto 3 del feedback post-v0.1: "textos simples
   *  para gente no técnica" — nada de "fitClass"/"VRAM" crudo acá, eso queda en la ficha técnica). */
  explanation: string;
  /** 'measured' solo si `tested` venía poblado (Benchmark/model_compat real para este hardware);
   *  'estimated' en cualquier otro caso — igual que doc 13 §4 "Regla de UI". */
  quality: 'measured' | 'estimated';
}

export interface TierClassificationInput {
  /** VRAM que necesitaría cargar el modelo con el `num_ctx` elegido (pesos + KV + overhead) —
   *  mismo campo que `MemoryEstimate.vramNeededBytes` cuando el modelo está instalado, o el proxy de
   *  `RecommendationEngine.estimatedTotalBytes` cuando no lo está. */
  vramNeededBytes: number;
  /** VRAM libre ya descontado el margen de seguridad (`MemoryEstimate.vramAvailableBytes`). */
  vramAvailableBytes: number;
  /** Tamaño de los pesos del modelo en disco (sin KV/overhead) — determina si por lo menos los
   *  pesos entran en la GPU o hace falta repartir capas en RAM. */
  weightsBytes: number;
  /** RAM libre del equipo (HardwareProbe, siempre `measured`: `os.freemem()`). */
  ramFreeBytes: number;
  /** Espacio libre en el disco de `OLLAMA_MODELS` (doc 13 §5 punto 1); si no se pudo medir
   *  (`spaceQuality: 'unavailable'`), se omite y nivel 6 nunca se fuerza por falta de disco. */
  freeDiskBytes?: number;
  /** Doc 13 §8 "Para MoE, si la fuente da parámetros activos, usalos para estimar velocidad y
   *  decilo": bytes de parámetros ACTIVOS (no el total) para modelos MoE (ej. gemma4:26b, 25.2B
   *  totales / 3.8B activos) — solo cambia el texto de la explicación, nunca el nivel (el nivel sigue
   *  dependiendo de cuánta VRAM/RAM hace falta para los pesos completos, que es lo que hay que cargar
   *  igual; los parámetros activos solo explican por qué puede ser más rápido de lo que el tamaño
   *  total sugeriría). */
  activeParamsRatio?: number;
  /** Solo se pasa si existe una medición real en ESTE equipo (Banco de pruebas / `model_compat` con
   *  `hardware_fingerprint` exacto, doc 13 §8) — fuerza el nivel a partir del resultado medido en vez
   *  de la fórmula, y sube `quality` a 'measured'. */
  tested?: { status: 'fits' | 'no_fit'; tokPerSec?: number; testedAt: number };
  /** `true` si la GPU es integrada/memoria unificada (Intel Arc iGPU, Apple Silicon, APU de AMD) —
   *  hardware real relevado en equipo #2 (Intel Core Ultra 9 288V + Arc 140V, 18 GiB compartidos de
   *  32 GB RAM): esa memoria se disputa con el resto del sistema y el ancho de banda es menor que el
   *  de una GPU dedicada, así que acá se exige más margen para los niveles 1-2 y se lo dice siempre en
   *  la explicación. `[HIPÓTESIS A PROBAR]`: el corte de 0.70/0.90 (contra 0.85/1.05 en GPU dedicada)
   *  y la mención de "más lento que en una placa dedicada" son un punto de partida razonable, no una
   *  medición de ancho de banda real. */
  integrated?: boolean;
}

const LABELS: Record<ModelTierLevel, string> = {
  1: 'Perfecto', 2: 'Muy bueno', 3: 'Usable', 4: 'Al límite', 5: 'Solo CPU / muy lento', 6: 'No recomendado instalar',
};
const COLORS: Record<ModelTierLevel, ModelTierColor> = {
  1: 'green', 2: 'teal', 3: 'yellow', 4: 'orange', 5: 'red', 6: 'gray',
};

function explanationForTested(level: ModelTierLevel, status: 'fits' | 'no_fit', tokPerSec: number | undefined): string {
  if (status === 'no_fit') return 'No anduvo bien en esta PC: se probó de verdad y no entró (memoria insuficiente al cargarlo).';
  if (tokPerSec !== undefined) {
    const base = level <= 2 ? 'Anduvo bien en esta PC' : 'Anduvo, pero lento en esta PC';
    return `${base}: ${tokPerSec.toFixed(1)} tok/s medidos.`;
  }
  return 'Se probó de verdad en esta PC y entró sin problemas.';
}

function explanationFor(level: ModelTierLevel, activeParamsRatio: number | undefined, integrated: boolean | undefined): string {
  const moeNote = activeParamsRatio !== undefined && activeParamsRatio < 0.5
    ? ` (usa solo una parte de sus parámetros por llamada — puede ir más rápido de lo que pesa)`
    : '';
  // Doc 13 §7 + hardware real equipo #2 (iGPU Intel Arc, memoria unificada con la RAM): la GPU
  // integrada comparte ancho de banda con el resto del sistema, así que incluso "entra" es más lento
  // que en una placa dedicada — se lo decimos siempre que aplique, en los niveles donde importa.
  const igpuNote = integrated && level <= 4
    ? ' Esta placa de video comparte memoria con la RAM (memoria unificada): puede ir más lento que con una placa dedicada.'
    : '';
  switch (level) {
    case 1: return `Entra completo en tu placa de video, con margen de sobra${moeNote}.${igpuNote}`;
    case 2: return `Entra en tu placa de video, justo${moeNote}.${igpuNote}`;
    case 3: return `Parte de la memoria usa RAM además de la placa de video; velocidad aceptable${moeNote}.${igpuNote}`;
    case 4: return `Pesado para esta PC: buena parte va a RAM, va a andar lento — priorizalo solo si te importa más la calidad que la velocidad${moeNote}.${igpuNote}`;
    case 5: return `No entra en tu placa de video: correría solo con el procesador (CPU), muy lento${moeNote}.`;
    case 6: return `No entra ni usando toda la RAM disponible, o no hay espacio en disco para instalarlo — no se recomienda en esta PC.`;
  }
}

/** Calcula el nivel 1-6 a partir de las cifras ya medidas/estimadas (doc: "Aplicá lo aprendido en
 *  mediciones reales del repo": no repite acá la fórmula de KV cache ni el muestreo de hardware, solo
 *  el corte en niveles — eso es responsabilidad de `MemoryEstimator`/`HardwareProbe`/
 *  `RecommendationEngine`, ya existentes). */
export function classifyModelTier(input: TierClassificationInput): ModelTier {
  // Un resultado MEDIDO en este equipo manda, sin pasar por la fórmula (doc 13 §4/§8: "nunca se
  // muestra un tok/s sin que Benchmark lo haya medido"; acá además decide el nivel).
  if (input.tested) {
    const level: ModelTierLevel = input.tested.status === 'no_fit' ? 6 : (input.vramNeededBytes <= input.vramAvailableBytes ? 1 : 2);
    return {
      level, label: LABELS[level], color: COLORS[level], quality: 'measured',
      explanation: explanationForTested(level, input.tested.status, input.tested.tokPerSec),
    };
  }

  const hasDiskInfo = input.freeDiskBytes !== undefined;
  const fitsDisk = !hasDiskInfo || (input.freeDiskBytes as number) >= input.weightsBytes;
  const fitsRam = input.weightsBytes <= input.ramFreeBytes;
  // Hardware real equipo #2 (iGPU Intel Arc, memoria unificada): se exige más margen para "perfecto"/
  // "muy bueno" que en una GPU dedicada (0.70/0.90 en vez de 0.85/1.05) — la memoria se comparte con
  // el resto del sistema y Ollama mismo puede necesitar más margen del que su propio total reportado
  // sugiere (ver nota de "proyector no contado" en MemoryEstimator).
  const perfectRatio = input.integrated ? 0.70 : 0.85;
  const goodRatio = input.integrated ? 0.90 : 1.05;
  // Techo de "cuánto puede excederse `vramNeeded` de `vramAvailable` y seguir siendo nivel 3
  // (usable)" en vez de 4 (al límite): en iGPU/memoria unificada un excedente chico ya empeoró el
  // resultado real medido (equipo #2: gemma4:26b con proyector, needed≈18.5 GiB sobre 17.2 GiB
  // disponibles — un 7.6% de más — no entró), así que el margen tolerado es mucho más chico que en
  // una GPU dedicada (donde el KV cache/overhead sobrante suele repartirse a RAM sin drama).
  const usableOverflowRatio = input.integrated ? 1.05 : 1.3;

  let level: ModelTierLevel;
  if (!fitsDisk || !fitsRam) {
    level = 6; // "no entra ni con RAM o sin disco" (doc, nivel 6 literal)
  } else if (input.vramAvailableBytes > 0 && input.vramNeededBytes <= input.vramAvailableBytes * perfectRatio) {
    level = 1; // entra en GPU con margen
  } else if (input.vramAvailableBytes > 0 && input.vramNeededBytes <= input.vramAvailableBytes * goodRatio) {
    level = 2; // entra justo
  } else if (
    input.vramAvailableBytes > 0 && input.weightsBytes <= input.vramAvailableBytes
    && input.vramNeededBytes <= input.vramAvailableBytes * usableOverflowRatio
  ) {
    level = 3; // los pesos entran en GPU, el KV cache/overhead se reparte con RAM: aceptable
  } else if (input.vramAvailableBytes / Math.max(input.weightsBytes, 1) >= 0.3) {
    level = 4; // offload parcial significativo (≥30% de los pesos en GPU): pesado pero con GPU real
  } else {
    level = 5; // entra en RAM pero casi sin ayuda de GPU: prácticamente CPU
  }

  return {
    level, label: LABELS[level], color: COLORS[level], quality: 'estimated',
    explanation: explanationFor(level, input.activeParamsRatio, input.integrated),
  };
}

const CATALOG_PROXY_SAFETY_MARGIN_BYTES = 512 * 1024 * 1024;
/** `numCtx` de referencia contra el que se calibró el proxy original de 15% (doc: "a un contexto
 *  moderado") — mantenerlo como baseline hace que `tierForCatalogWeights(weights, hw)` sin `numCtx`
 *  explícito siga devolviendo EXACTAMENTE lo mismo que antes de este cambio (nadie que ya lo llamaba
 *  ve un resultado distinto). */
const CATALOG_PROXY_BASELINE_NUM_CTX = 8192;

/** Igual que `RecommendationEngine.estimatedTotalBytes` (mismo `[HIPÓTESIS A PROBAR]`, documentado
 *  ahí): sin el modelo instalado no hay `model_info` para la fórmula exacta de KV cache
 *  (`MemoryEstimator.computeKvBytes`, que sí es sensible a `numCtx` para un modelo instalado), así que
 *  se usa un margen proxy (15% del tamaño de pesos a 8192 de contexto, piso de 512 MiB) y se lo escala
 *  linealmente con `numCtx` — el KV cache real de llama.cpp crece aproximadamente lineal con el
 *  contexto (doc 08 §5.2: `kvBytesPerLayerPerToken × blockCount × numCtx`), así que escalar el proxy
 *  de la misma forma es más honesto que dejarlo fijo cuando el selector de contexto de la UI (punto 5
 *  del encargo: "selector de contexto 4k/8k/16k/32k que recalcula memoria y nivel") cambia `numCtx` —
 *  aun así sigue siendo un PROXY (`[HIPÓTESIS A PROBAR]`: la pendiente exacta depende de la
 *  arquitectura real, que acá no se conoce todavía). Se duplica acá (en vez de importar desde
 *  `RecommendationEngine.ts`) a propósito para no crear una dependencia cruzada entre los dos módulos
 *  por una fórmula de pocas líneas. */
function estimatedTotalBytes(weightsBytes: number, numCtx: number): number {
  const baselineMargin = Math.max(weightsBytes * 0.15, 512 * 1024 * 1024);
  const scaledMargin = baselineMargin * (numCtx / CATALOG_PROXY_BASELINE_NUM_CTX);
  return weightsBytes + Math.max(scaledMargin, 512 * 1024 * 1024);
}

/** Punto de entrada para el catálogo (modelo NO instalado, doc 13 §2/§10 "Explorar"): arma
 *  `TierClassificationInput` a partir de un `HardwareProfile` ya muestreado y el tamaño de pesos del
 *  catálogo, y clasifica. `tested`/`activeParamsRatio` son opcionales (el catálogo del MVP no siempre
 *  los tiene). `numCtx` (opcional, default 8192 — el mismo baseline que ya usaba el proxy original)
 *  alimenta el selector de contexto 4k/8k/16k/32k de la ficha (punto 5 del encargo): a más contexto
 *  elegido, más margen de KV cache proxy, así el nivel puede bajar de "Perfecto" a "Usable" al subir el
 *  selector — la UI lo etiqueta "estimado" siempre, nunca "medido" (eso solo lo da el Banco de
 *  pruebas). */
export function tierForCatalogWeights(
  weightsBytes: number,
  hardware: HardwareProfile,
  opts: {
    freeDiskBytes?: number; activeParamsRatio?: number; tested?: TierClassificationInput['tested']; numCtx?: number;
  } = {},
): ModelTier {
  const vramTotal = hardware.gpu?.vramTotalBytes.value ?? 0;
  const vramUsed = hardware.gpu?.vramUsedBytes?.value ?? 0;
  const integrated = hardware.gpu?.integrated;
  const marginRatio = integrated ? 0.10 : undefined;
  const safetyMargin = marginRatio !== undefined
    ? Math.max(CATALOG_PROXY_SAFETY_MARGIN_BYTES, Math.round(vramTotal * marginRatio))
    : CATALOG_PROXY_SAFETY_MARGIN_BYTES;
  const vramAvailableBytes = Math.max(vramTotal - vramUsed - safetyMargin, 0);
  const numCtx = opts.numCtx ?? CATALOG_PROXY_BASELINE_NUM_CTX;

  return classifyModelTier({
    vramNeededBytes: estimatedTotalBytes(weightsBytes, numCtx),
    vramAvailableBytes,
    weightsBytes,
    ramFreeBytes: hardware.ram.freeBytes.value,
    freeDiskBytes: opts.freeDiskBytes,
    activeParamsRatio: opts.activeParamsRatio,
    tested: opts.tested,
    integrated,
  });
}
