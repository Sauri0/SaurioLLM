// PageRank personalizado sobre el grafo archivo->archivo (doc 07 §2.2 paso 5; doc 04 §12).
// Implementación propia (doc 07 §2.2: "implementación propia o graphology, a decidir en el
// scaffolding — no es una decisión de arquitectura"; se eligió implementación propia para no
// agregar una dependencia no instalada, ver "missingDeps"/"deviations" de la salida del módulo).
import type { FileGraph } from './graph.js';
import type { RepoGraphNode } from './types.js';

export interface PageRankOptions {
  damping?: number;       // factor de amortiguación estándar
  maxIterations?: number;
  tolerance?: number;     // corte por convergencia (suma de diffs absolutos)
  /** Archivos hacia los que se sesga el vector de "personalización" (doc 07 §2.2 paso 5). */
  personalization?: readonly string[];
}

const DEFAULT_DAMPING = 0.85;
const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_TOLERANCE = 1e-6;

/**
 * PageRank personalizado: en vez de repartir el "teletransporte" uniformemente entre todos los
 * nodos, lo concentra en `personalization` (archivos mencionados/tocados en el chat) para sesgar
 * el ranking hacia lo relevante al turno actual (doc 07 §2.2 paso 5).
 */
export function personalizedPageRank(graph: FileGraph, opts: PageRankOptions = {}): RepoGraphNode[] {
  const damping = opts.damping ?? DEFAULT_DAMPING;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;

  const nodes = [...graph.nodes];
  const n = nodes.length;
  if (n === 0) return [];
  if (n === 1) return [{ file: nodes[0] as string, rank: 1 }];

  const index = new Map(nodes.map((f, i) => [f, i]));

  // Vector de personalización: uniforme por defecto; sesgado a los archivos indicados si hay alguno.
  const personalized = (opts.personalization ?? []).filter((f) => index.has(f));
  const personalization = new Float64Array(n);
  if (personalized.length > 0) {
    const share = 1 / personalized.length;
    for (const f of personalized) {
      const i = index.get(f);
      if (i !== undefined) personalization[i] = share;
    }
  } else {
    personalization.fill(1 / n);
  }

  // Pesos salientes normalizados por nodo (fila estocástica), con dangling nodes (sin salida)
  // repartidos según el vector de personalización (estándar en PageRank personalizado).
  const outWeightSum = new Float64Array(n);
  for (const [from, targets] of graph.edges) {
    const fi = index.get(from);
    if (fi === undefined) continue;
    for (const w of targets.values()) outWeightSum[fi] = (outWeightSum[fi] ?? 0) + w;
  }

  let rank = new Float64Array(n).fill(1 / n);

  for (let iter = 0; iter < maxIterations; iter++) {
    const next = new Float64Array(n);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      if ((outWeightSum[i] ?? 0) === 0) danglingMass += rank[i] ?? 0;
    }

    for (const [from, targets] of graph.edges) {
      const fi = index.get(from);
      if (fi === undefined) continue;
      const total = outWeightSum[fi] ?? 0;
      if (total === 0) continue;
      const r = rank[fi] ?? 0;
      for (const [to, w] of targets) {
        const ti = index.get(to);
        if (ti === undefined) continue;
        next[ti] = (next[ti] ?? 0) + damping * r * (w / total);
      }
    }

    for (let i = 0; i < n; i++) {
      const teleport = (1 - damping) * (personalization[i] ?? 0);
      const dangling = damping * danglingMass * (personalization[i] ?? 0);
      next[i] = (next[i] ?? 0) + teleport + dangling;
    }

    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs((next[i] ?? 0) - (rank[i] ?? 0));
    rank = next;
    if (diff < tolerance) break;
  }

  return nodes
    .map((file, i) => ({ file, rank: rank[i] ?? 0 }))
    .sort((a, b) => b.rank - a.rank);
}
