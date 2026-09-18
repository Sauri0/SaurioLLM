// RepoMapClient real, respaldado por @saurio/repomap — packages/runtime/src/context/engine-repo-map-client.ts.
// Define: doc 04 §8 (`RepoMapClient`) + doc 07 §2 (pipeline del repo map) + doc 04 §12 (ProjectIndexer).
//
// TODO utilityProcess v0.2: doc 01 §4.2 y ADR-1 quieren el ProjectIndexer (tree-sitter + PageRank)
// en un `utilityProcess` aparte, para que el parseo no bloquee el proceso main. En el MVP el motor
// corre EN EL MISMO PROCESO que el runtime (RuntimeHost ya vive fuera del renderer, así que la UI no
// se congela); mover el motor a utilityProcess solo cambia esta clase por un cliente de mensajes,
// sin tocar a `ContextBuilder` ni a `RunController`, porque la interfaz `RepoMapClient` es la misma.
import { RepoMapEngine, setGrammarsDir, setQueriesDir } from '@saurio/repomap';
import type { RepoMapClient } from './types.js';

/** Punto 5 del encargo (doc 16): apps/desktop no depende directamente de `@saurio/repomap` (solo de
 *  `@saurio/runtime`, que ya lo hace) — este es el único punto de paso para que `createRuntime.ts`
 *  inyecte la carpeta real de grammars .wasm y queries .scm ANTES de indexar cualquier proyecto,
 *  con la ruta ya resuelta contra `process.resourcesPath` (empaquetado) o la raíz del repo (dev),
 *  igual que ya hace `services/resources.ts` para el catálogo de modelos y los prompts. Llamarla más
 *  de una vez es seguro (`setGrammarsDir`/`setQueriesDir` solo reemplazan un valor en memoria). */
export function configureRepoMapResources(paths: { grammarsDir?: string; queriesDir?: string }): void {
  if (paths.grammarsDir) setGrammarsDir(paths.grammarsDir);
  if (paths.queriesDir) setQueriesDir(paths.queriesDir);
}

export interface EngineRepoMapClientOptions {
  /** ms mínimos entre reindexados completos; evita re-scanear el árbol en cada turno del run. */
  reindexIntervalMs?: number;
}

export class EngineRepoMapClient implements RepoMapClient {
  private readonly engine = new RepoMapEngine();
  private readonly reindexIntervalMs: number;
  private indexedRoot: string | undefined;
  private lastIndexAt = 0;
  private pendingChanges = new Set<string>();
  private indexing: Promise<void> | undefined;

  constructor(opts: EngineRepoMapClientOptions = {}) {
    this.reindexIntervalMs = opts.reindexIntervalMs ?? 30_000;
  }

  async build(
    projectRoot: string,
    opts: { budgetTokens: number; mentioned: string[]; touched: string[] },
  ): Promise<{ text: string; tokens: number }> {
    await this.ensureIndexed(projectRoot);
    const { text, tokens } = this.engine.rank(
      { mentioned: opts.mentioned, touched: opts.touched },
      opts.budgetTokens,
    );
    return { text, tokens };
  }

  invalidate(changedFiles: string[]): void {
    for (const file of changedFiles) this.pendingChanges.add(file);
    this.engine.invalidate(changedFiles);
  }

  private async ensureIndexed(projectRoot: string): Promise<void> {
    if (this.indexing) return this.indexing;

    const rootChanged = this.indexedRoot !== projectRoot;
    const stale = Date.now() - this.lastIndexAt > this.reindexIntervalMs;
    const changed = [...this.pendingChanges];
    if (!rootChanged && !stale && changed.length === 0) return;

    const task = (async (): Promise<void> => {
      // Reindexado completo si cambió la raíz o venció el intervalo; incremental si solo hay
      // archivos tocados (doc 07 §2.4: "con la lista puntual de archivos tocados").
      const incremental = !rootChanged && !stale && changed.length > 0;
      await this.engine.index(projectRoot, incremental ? changed : undefined);
      this.indexedRoot = projectRoot;
      this.lastIndexAt = Date.now();
      this.pendingChanges = new Set();
    })();

    this.indexing = task.finally(() => { this.indexing = undefined; });
    return this.indexing;
  }
}
