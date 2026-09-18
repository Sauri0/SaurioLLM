// Tipos internos de @saurio/repomap (doc 04 §12 "Project Indexer / Repo Map"; doc 07 §2).
// RepoTag y RepoGraphNode están definidos por la columna vertebral (doc 04 §12) y se re-exportan acá
// tal cual; el resto (RepoFileCacheEntry, RepoMapCache, IndexResult, RankedFile) es interno del
// paquete: la tarea de repomap no debe tocar packages/shared, así que cualquier tipo adicional que
// necesite vive acá (ver "deviations" en la salida estructurada del módulo).

/** Igual a la interfaz de doc 04 §12; `RepoTag { file, name, kind, line }`. */
export interface RepoTag {
  file: string;
  name: string;
  kind: 'def' | 'ref';
  line: number;
}

/** Igual a la interfaz de doc 04 §12; `RepoGraphNode { file, rank }`. */
export interface RepoGraphNode {
  file: string;
  rank: number;
}

/** Lenguajes con grammar disponible en el MVP (doc 07 §2.2 paso 2 / §2.5). */
export type SupportedLang = 'typescript' | 'tsx' | 'javascript' | 'python';

/** Entrada de la tabla `repo_map_cache(project_id, rel_path, mtime, size, lang, tags_json)`
 *  (doc 07 §2.4, columna vertebral §4). El repomap no abre SQLite directamente (eso es
 *  responsabilidad de packages/runtime/src/persistence): recibe una implementación de
 *  `RepoMapCache` inyectada por quien lo instancia (columna vertebral ADR-1: el indexer corre en
 *  un utilityProcess separado y habla con el resto por su propio canal). */
export interface RepoFileCacheEntry {
  relPath: string;
  mtimeMs: number;
  size: number;
  lang: SupportedLang | 'plain';
  tags: RepoTag[];
}

/** Cache por mtime+size inyectada (tarea repomap: "cache por mtime+size (interfaz inyectada)").
 *  Una implementación en memoria (`InMemoryRepoMapCache`) vive en cache.ts para tests y para el
 *  caso "sin persistencia todavía disponible"; la implementación real contra SQLite se conecta
 *  desde packages/runtime. */
export interface RepoMapCache {
  get(relPath: string): RepoFileCacheEntry | undefined;
  set(entry: RepoFileCacheEntry): void;
  delete(relPath: string): void;
  clear(): void;
}

/** Un archivo del listado, ya filtrado por .saurioignore/binarios/tamaño (doc 07 §2.1 paso 1). */
export interface RepoFile {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  size: number;
}

/** Resultado de `index()` (interfaz de doc 04 §12: `{ filesIndexed, tookMs }`). */
export interface IndexResult {
  filesIndexed: number;
  tookMs: number;
}

/** Opciones de ranking (doc 07 §2.2 pasos 4-5: mencionados/tocados personalizan el PageRank). */
export interface RankQuery {
  mentioned?: string[];
  touched?: string[];
}

/** Archivo ya rankeado + sus tags (para render.ts, doc 07 §2.3 y §2.6 selección por presupuesto). */
export interface RankedFile extends RepoGraphNode {
  tags: RepoTag[];
  lang: SupportedLang | 'plain';
}
