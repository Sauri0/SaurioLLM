// Caché en disco (userData) del snapshot completo de la biblioteca de Ollama — implementación real de
// `LibraryCachePort` (`packages/runtime/src/models/OllamaLibraryClient.ts`) —
// apps/desktop/src/main/services/models/LibraryCache.ts.
// Define: punto 2 del encargo (doc 16 §12.6): "caché en userData con TTL de 24 h". El host es quien
// sabe dónde vive `userData`; `packages/runtime` nunca importa `fs`/rutas de Electron directamente
// para esto (mismo patrón que `SecureKeyStore`/`SqlDownloadsRepository`: el puerto es genérico, la
// implementación de disco vive acá).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadOllamaLibrarySnapshot, type LibraryCachePort, type OllamaLibrarySnapshot } from '@saurio/runtime/models/index';

interface CacheFileShape { snapshot: unknown; cachedAt: number }

/** Un único JSON por app (no una fila SQL): el catálogo completo es un dato de "cache", no de negocio
 *  — perderlo en un update de SaurioLLM no importa (se vuelve a sincronizar solo, o cae al snapshot
 *  empaquetado). Nunca lanza en `read()` (una caché corrupta o de un esquema viejo se trata como "sin
 *  caché", mismo criterio que `SecureKeyStore.get()`). */
export class FileLibraryCache implements LibraryCachePort {
  constructor(private readonly filePath: string) {}

  async read(): Promise<{ snapshot: OllamaLibrarySnapshot; cachedAt: number } | undefined> {
    if (!existsSync(this.filePath)) return undefined;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as CacheFileShape;
      const snapshot = loadOllamaLibrarySnapshot(JSON.stringify(parsed.snapshot));
      return { snapshot, cachedAt: parsed.cachedAt };
    } catch {
      return undefined;
    }
  }

  async write(snapshot: OllamaLibrarySnapshot, cachedAt: number): Promise<void> {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: CacheFileShape = { snapshot, cachedAt };
    writeFileSync(this.filePath, JSON.stringify(payload), 'utf-8');
  }
}
