// Construcción del grafo archivo -> archivo ponderado (doc 07 §2.2 paso 4; doc 04 §12).
// Arista A -> B: "A referencia símbolos definidos en B". Pesos (doc 07 §2.2 paso 4):
//   x50  si B fue mencionado/tocado en el chat actual;
//   x10  si el identificador de la referencia fue mencionado textualmente por el usuario;
//   x0.1 si el nombre es genérico (contiene "_", o está definido en más de 5 archivos);
//   escalado final por sqrt(cantidad de referencias) de ese identificador en A.
import type { RankQuery, RepoTag } from './types.js';

const GENERIC_DEF_FILE_THRESHOLD = 5;
const MENTIONED_FILE_MULTIPLIER = 50;
const MENTIONED_IDENT_MULTIPLIER = 10;
const GENERIC_NAME_MULTIPLIER = 0.1;

export interface FileGraph {
  /** Todos los archivos que aparecen como nodo (con def o ref), aunque queden sin aristas. */
  nodes: Set<string>;
  /** A -> (B -> peso acumulado). */
  edges: Map<string, Map<string, number>>;
}

function isGenericName(name: string, definedInFiles: number): boolean {
  return name.includes('_') || definedInFiles > GENERIC_DEF_FILE_THRESHOLD;
}

function addEdge(edges: Map<string, Map<string, number>>, from: string, to: string, weight: number): void {
  if (from === to || weight <= 0) return;
  let targets = edges.get(from);
  if (!targets) {
    targets = new Map();
    edges.set(from, targets);
  }
  targets.set(to, (targets.get(to) ?? 0) + weight);
}

/**
 * Construye el grafo archivo->archivo a partir de los tags de todos los archivos indexados.
 * `query.touched`/`query.mentioned` son rutas relativas mencionadas/tocadas en el chat actual
 * (doc 07 §2.2 paso 4); `mentionedIdentifiers` son identificadores nombrados textualmente por el
 * usuario en el turno.
 */
export function buildGraph(
  tagsByFile: ReadonlyMap<string, RepoTag[]>,
  query: RankQuery = {},
  mentionedIdentifiers: readonly string[] = [],
): FileGraph {
  const nodes = new Set<string>(tagsByFile.keys());
  const touchedFiles = new Set([...(query.touched ?? []), ...(query.mentioned ?? [])]);
  const mentionedIdents = new Set(mentionedIdentifiers);

  // defs: nombre -> conjunto de archivos que lo definen
  const defs = new Map<string, Set<string>>();
  for (const [file, tags] of tagsByFile) {
    for (const tag of tags) {
      if (tag.kind !== 'def') continue;
      let files = defs.get(tag.name);
      if (!files) {
        files = new Set();
        defs.set(tag.name, files);
      }
      files.add(file);
    }
  }

  // refs por archivo: nombre -> cantidad de referencias en ese archivo
  const refsByFile = new Map<string, Map<string, number>>();
  for (const [file, tags] of tagsByFile) {
    const counts = new Map<string, number>();
    for (const tag of tags) {
      if (tag.kind !== 'ref') continue;
      counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
    }
    refsByFile.set(file, counts);
  }

  const edges = new Map<string, Map<string, number>>();
  for (const [file, counts] of refsByFile) {
    for (const [name, count] of counts) {
      const definingFiles = defs.get(name);
      if (!definingFiles || definingFiles.size === 0) continue;
      let mul = 1;
      if (isGenericName(name, definingFiles.size)) mul *= GENERIC_NAME_MULTIPLIER;
      if (mentionedIdents.has(name)) mul *= MENTIONED_IDENT_MULTIPLIER;
      const scaled = mul * Math.sqrt(count);
      for (const defFile of definingFiles) {
        if (defFile === file) continue;
        const targetMul = touchedFiles.has(defFile) ? MENTIONED_FILE_MULTIPLIER : 1;
        addEdge(edges, file, defFile, scaled * targetMul);
        nodes.add(defFile);
      }
    }
  }

  return { nodes, edges };
}
