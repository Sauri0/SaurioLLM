// Cache por mtime+size (doc 07 §2.4: "un archivo se re-parsea solo si cambió mtime o size").
// Implementación en memoria de `RepoMapCache`, usada por defecto y en tests; la persistencia real
// contra `repo_map_cache` (SQLite) se inyecta desde packages/runtime, que implementa la misma
// interfaz contra el driver better-sqlite3 (columna vertebral §4).
import type { RepoFileCacheEntry, RepoMapCache } from './types.js';

export class InMemoryRepoMapCache implements RepoMapCache {
  private readonly entries = new Map<string, RepoFileCacheEntry>();

  get(relPath: string): RepoFileCacheEntry | undefined {
    return this.entries.get(relPath);
  }

  set(entry: RepoFileCacheEntry): void {
    this.entries.set(entry.relPath, entry);
  }

  delete(relPath: string): void {
    this.entries.delete(relPath);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** True si la entrada cacheada sigue vigente para este archivo (doc 07 §2.4). */
export function isCacheFresh(entry: RepoFileCacheEntry | undefined, mtimeMs: number, size: number): entry is RepoFileCacheEntry {
  return entry !== undefined && entry.mtimeMs === mtimeMs && entry.size === size;
}
