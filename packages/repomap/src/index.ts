// Punto de entrada de @saurio/repomap (doc 04 §12 "Project Indexer / Repo Map"; doc 07 §2).
// `RepoMapEngine` implementa el pipeline completo: listado (files.ts) -> parseo+tags (tags.ts) ->
// grafo ponderado (graph.ts) -> PageRank personalizado (pagerank.ts) -> selección por presupuesto
// y render compacto (render.ts), con cache por mtime+size inyectada (cache.ts) y degradación a
// árbol plano si falla la grammar (doc 07 §2.5).
//
// API pública, tal como la pide la tarea de este módulo: `index(projectPath, changedFiles?)` y
// `rank(query, budgetTokens)`. Esto es una capa de conveniencia sobre las piezas de más abajo;
// el doc 04 §12 define `ProjectIndexer` con `rank(query)` (sin `budgetTokens`) separado de
// `render(nodes, budgetTokens)` — se mantienen también esos dos métodos por separado
// (`rankFiles`/`render`/`tagsFor`) para no romper esa forma, y `rank()` los combina. Ver
// "deviations" en la salida estructurada del módulo.
import { readFileSync } from 'node:fs';
import { InMemoryRepoMapCache, isCacheFresh } from './cache.js';
import { langForFile, listProjectFiles } from './files.js';
import { buildGraph } from './graph.js';
import { personalizedPageRank } from './pagerank.js';
import { renderRepoMap, type RenderResult } from './render.js';
import { extractTags } from './tags.js';
import type {
  IndexResult,
  RankedFile,
  RankQuery,
  RepoFile,
  RepoGraphNode,
  RepoMapCache,
  RepoTag,
  SupportedLang,
} from './types.js';

export * from './loader.js';
export * from './types.js';
export { buildGraph, type FileGraph } from './graph.js';
export { personalizedPageRank } from './pagerank.js';
export { estimateTokens, renderFileBlock, renderRepoMap, type RenderResult } from './render.js';
export { extractTags, hasTagSupport, getQueriesDir, setQueriesDir } from './tags.js';
export { listProjectFiles, langForFile, MAX_FILE_BYTES } from './files.js';
export { InMemoryRepoMapCache, isCacheFresh } from './cache.js';

export interface RepoMapEngineOptions {
  /** Cache por mtime+size inyectada (doc 07 §2.4); por defecto en memoria. */
  cache?: RepoMapCache;
}

/** Motor de repo map de un proyecto: mantiene el estado indexado (tags por archivo) en memoria
 *  del `utilityProcess` que lo hospeda (columna vertebral ADR-1); no persiste nada por sí mismo
 *  más allá de lo que la `RepoMapCache` inyectada decida guardar. */
export class RepoMapEngine {
  private readonly cache: RepoMapCache;
  private projectRoot: string | undefined;
  private files: RepoFile[] = [];
  private readonly tagsByFile = new Map<string, RepoTag[]>();
  private readonly langByFile = new Map<string, SupportedLang | 'plain'>();

  constructor(opts: RepoMapEngineOptions = {}) {
    this.cache = opts.cache ?? new InMemoryRepoMapCache();
  }

  /**
   * Indexa el proyecto (doc 04 §12: `{ filesIndexed, tookMs }`). Sin `changedFiles`, reindexa todo
   * el listado (doc 07 §2.1 paso 1). Con `changedFiles`, solo reprocesa esas rutas (doc 07 §2.4:
   * "actualización incremental... con la lista puntual de archivos tocados, no un re-scan
   * completo") y elimina del índice las que ya no existan.
   */
  async index(projectPath: string, changedFiles?: string[]): Promise<IndexResult> {
    const start = Date.now();
    this.projectRoot = projectPath;
    const allFiles = await listProjectFiles(projectPath);
    this.files = allFiles;
    const allRelPaths = new Set(allFiles.map((f) => f.relPath));

    if (!changedFiles) {
      // Reindexado completo: se sacan del mapa las rutas que ya no están en el listado actual.
      for (const rel of [...this.tagsByFile.keys()]) {
        if (!allRelPaths.has(rel)) {
          this.tagsByFile.delete(rel);
          this.langByFile.delete(rel);
        }
      }
    } else {
      for (const rel of changedFiles) {
        if (!allRelPaths.has(rel)) {
          this.tagsByFile.delete(rel);
          this.langByFile.delete(rel);
          this.cache.delete(rel);
        }
      }
    }

    const byRel = new Map(allFiles.map((f) => [f.relPath, f]));
    const targets = changedFiles && changedFiles.length > 0
      ? changedFiles.map((rel) => byRel.get(rel)).filter((f): f is RepoFile => f !== undefined)
      : allFiles;

    let filesIndexed = 0;
    for (const file of targets) {
      await this.indexOne(file);
      filesIndexed++;
    }
    return { filesIndexed, tookMs: Date.now() - start };
  }

  private async indexOne(file: RepoFile): Promise<void> {
    const cached = this.cache.get(file.relPath);
    if (isCacheFresh(cached, file.mtimeMs, file.size)) {
      this.tagsByFile.set(file.relPath, cached.tags);
      this.langByFile.set(file.relPath, cached.lang);
      return;
    }

    const lang = langForFile(file.relPath);
    let tags: RepoTag[] | null = null;
    let effLang: SupportedLang | 'plain' = 'plain';
    if (lang) {
      try {
        const source = readFileSync(file.absPath, 'utf8');
        tags = await extractTags(file.relPath, source, lang);
        if (tags) effLang = lang;
      } catch {
        // Archivo ilegible (borrado en carrera, encoding raro): degrada a árbol plano para este
        // archivo puntual, sin abortar el resto del indexado (doc 07 §2.5).
        tags = null;
      }
    }
    const finalTags = tags ?? [];
    this.tagsByFile.set(file.relPath, finalTags);
    this.langByFile.set(file.relPath, effLang);
    this.cache.set({ relPath: file.relPath, mtimeMs: file.mtimeMs, size: file.size, lang: effLang, tags: finalTags });
  }

  /** `invalidate` de `RepoMapClient` (doc 04 §8): saca archivos del índice y de la cache sin
   *  reindexarlos (el próximo `index(..., changedFiles)` los vuelve a traer). */
  invalidate(changedFiles: string[]): void {
    for (const rel of changedFiles) {
      this.tagsByFile.delete(rel);
      this.langByFile.delete(rel);
      this.cache.delete(rel);
    }
  }

  /** Separa `query.mentioned` en rutas de archivo conocidas (van a la personalización de
   *  PageRank y al x50 de graph.ts) e identificadores sueltos (van al x10 de graph.ts) — el
   *  doc 04 §8/§12 no distingue ambos casos en el tipo de `query`; ver "deviations". */
  private splitMentioned(query: RankQuery): { mentionedFiles: string[]; mentionedIdents: string[] } {
    const mentionedFiles: string[] = [];
    const mentionedIdents: string[] = [];
    for (const m of query.mentioned ?? []) {
      if (this.tagsByFile.has(m)) mentionedFiles.push(m);
      else mentionedIdents.push(m);
    }
    return { mentionedFiles, mentionedIdents };
  }

  /** `rank(query)` de `ProjectIndexer` (doc 04 §12): archivos ordenados por PageRank
   *  personalizado, sin renderizar ni aplicar presupuesto todavía. */
  rankFiles(query: RankQuery = {}): RepoGraphNode[] {
    const { mentionedFiles, mentionedIdents } = this.splitMentioned(query);
    const touched = [...(query.touched ?? []), ...mentionedFiles];
    const graph = buildGraph(this.tagsByFile, { touched, mentioned: mentionedFiles }, mentionedIdents);
    return personalizedPageRank(graph, { personalization: touched });
  }

  /** `tagsFor(file)` de `ProjectIndexer` (doc 04 §12). */
  tagsFor(file: string): RepoTag[] {
    return this.tagsByFile.get(file) ?? [];
  }

  /** `render(nodes, budgetTokens)` de `ProjectIndexer` (doc 04 §12): selección por búsqueda
   *  binaria + render compacto (doc 07 §2.2 paso 6, §2.3). */
  render(nodes: RepoGraphNode[], budgetTokens: number): RenderResult {
    const ranked: RankedFile[] = nodes.map((n) => ({
      ...n,
      tags: this.tagsByFile.get(n.file) ?? [],
      lang: this.langByFile.get(n.file) ?? 'plain',
    }));
    return renderRepoMap(ranked, budgetTokens);
  }

  /**
   * Conveniencia pedida por la tarea del módulo: `rank(query, budgetTokens)` — rankea y
   * renderiza en un solo llamado (equivalente a `render(rankFiles(query), budgetTokens)`), que es
   * lo que `RepoMapClient.build` de packages/runtime termina necesitando en la práctica.
   */
  rank(query: RankQuery, budgetTokens: number): RenderResult {
    return this.render(this.rankFiles(query), budgetTokens);
  }

  /** Rutas indexadas hasta ahora (útil para tests y para diagnósticos). */
  listIndexedFiles(): string[] {
    return [...this.tagsByFile.keys()];
  }

  get root(): string | undefined {
    return this.projectRoot;
  }
}
