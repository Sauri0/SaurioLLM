// RepoMapClient stub: árbol plano de archivos cuando no hay repo map real — packages/runtime/src/context/repo-map-client.ts.
// Define: doc 04 §8 (interfaz `RepoMapClient`, ./types.ts, no se modifica) y doc 07-context-manager.md §2.5
// (fallback a árbol plano). El motor real (tree-sitter + PageRank, @saurio/repomap + ProjectIndexer en un
// utilityProcess) es de otro módulo (paquete @saurio/repomap, fuera de los directorios asignados a esta
// tarea); esta clase implementa la interfaz con una lectura de directorio simple para que ContextBuilder
// tenga algo real para armar el primer mensaje de usuario mientras no exista el indexer.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RepoMapClient } from './types.js';

const DEFAULT_IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.saurio', '.turbo']);

/** ~2.5 chars/token para rutas (doc 07 §9, ratio `path`); usado solo para frenar el listado por
 *  presupuesto sin depender de un TokenCounter inyectado (este stub es intencionalmente liviano). */
const CHARS_PER_TOKEN_PATH = 2.5;

function listFilesFlat(root: string, ignored: Set<string>): string[] {
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // directorio no legible: se ignora, el indexer real decide qué hacer (doc 07 §2.5)
    }
    for (const entry of entries) {
      if (ignored.has(entry)) continue;
      const full = path.join(dir, entry);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        stack.push(full);
      } else {
        results.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  results.sort();
  return results;
}

/** Stub de `RepoMapClient`: sin símbolos, agrupado por carpeta como texto plano (doc 07 §2.5),
 *  cortado por presupuesto de tokens. `invalidate` es un no-op: este stub no cachea nada, relee
 *  el filesystem en cada `build`. */
export class FlatTreeRepoMapClient implements RepoMapClient {
  async build(
    projectRoot: string,
    opts: { budgetTokens: number; mentioned: string[]; touched: string[] },
  ): Promise<{ text: string; tokens: number }> {
    const files = listFilesFlat(projectRoot, DEFAULT_IGNORED_DIRS);
    const prioritized = prioritize(files, opts.mentioned, opts.touched);

    const lines: string[] = [];
    let usedChars = 0;
    const budgetChars = opts.budgetTokens * CHARS_PER_TOKEN_PATH;
    for (const file of prioritized) {
      const line = `${file}\n`;
      if (usedChars + line.length > budgetChars && lines.length > 0) break;
      lines.push(line);
      usedChars += line.length;
    }

    const text = lines.length === prioritized.length
      ? `# árbol plano del proyecto (sin repo map)\n${lines.join('')}`
      : `# árbol plano del proyecto (sin repo map; truncado por presupuesto)\n${lines.join('')}`;
    return { text, tokens: Math.ceil(text.length / CHARS_PER_TOKEN_PATH) };
  }

  invalidate(_changedFiles: string[]): void {
    // No-op: este stub no cachea (doc 07 §2.4, cache real vive en `repo_map_cache` del indexer real).
  }
}

function prioritize(files: string[], mentioned: string[], touched: string[]): string[] {
  const boosted = new Set([...mentioned, ...touched]);
  const front: string[] = [];
  const rest: string[] = [];
  for (const file of files) {
    if (boosted.has(file)) front.push(file);
    else rest.push(file);
  }
  return [...front, ...rest];
}

export function createRepoMapClient(): RepoMapClient {
  return new FlatTreeRepoMapClient();
}
