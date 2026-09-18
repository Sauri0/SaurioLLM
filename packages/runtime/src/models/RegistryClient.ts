// Cliente del registry de Ollama (manifests públicos, sin auth) — packages/runtime/src/models/RegistryClient.ts.
// Define: doc 13 §3 ("GET https://registry.ollama.ai/v2/library/<modelo>/manifests/<tag> funciona
// sin autenticación, devuelve un manifest Docker v2 con layers[].size por capa"). Implementación
// real de `ManifestFetcher` (./types.ts); DownloadManager la recibe inyectada para poder testearse
// con fixtures sin red real.
import { statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BlobStoreProbe, DiskSpaceProbe, ManifestFetcher, RegistryManifest } from './types.js';

const REGISTRY_BASE_URL = 'https://registry.ollama.ai';

interface DockerManifestLayer { mediaType: string; digest: string; size: number }
interface DockerManifest { schemaVersion: number; config?: DockerManifestLayer; layers?: DockerManifestLayer[] }

/** `name` puede venir como `modelo` o `modelo:tag` (doc 13 §3, MVP: solo namespace `library`, que es
 *  donde vive el catálogo curado — un modelo de otro namespace, ej. `usuario/modelo`, no lo resuelve
 *  este cliente todavía). */
function splitNameTag(modelName: string): { name: string; tag: string } {
  const idx = modelName.lastIndexOf(':');
  if (idx === -1) return { name: modelName, tag: 'latest' };
  return { name: modelName.slice(0, idx), tag: modelName.slice(idx + 1) };
}

export class RegistryClient implements ManifestFetcher {
  constructor(
    private readonly baseUrl: string = REGISTRY_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchManifest(modelName: string): Promise<RegistryManifest> {
    const { name, tag } = splitNameTag(modelName);
    const url = `${this.baseUrl}/v2/library/${name}/manifests/${tag}`;
    const response = await this.fetchImpl(url, { headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' } });
    if (!response.ok) {
      throw new Error(`manifest de "${modelName}" no encontrado (HTTP ${response.status}): ${url}`);
    }
    const json = (await response.json()) as DockerManifest;
    return {
      layers: (json.layers ?? []).map((l) => ({ digest: l.digest, size: l.size, mediaType: l.mediaType })),
      config: json.config ? { digest: json.config.digest, size: json.config.size, mediaType: json.config.mediaType } : undefined,
    };
  }
}

/** Los blobs de Ollama viven en `<OLLAMA_MODELS>/blobs/sha256-<hex>` — `:` no es válido en nombres
 *  de archivo de Windows, así que el digest `sha256:<hex>` se guarda con `-` en vez de `:`
 *  [VERIFICADO EN DOC OFICIAL: convención documentada de `OLLAMA_MODELS`, confirmado contra los
 *  blobs reales de `N:\OllamaModels\blobs` en esta máquina]. */
export function digestToBlobFilename(digest: string): string {
  return digest.replace(':', '-');
}

export class FsBlobStoreProbe implements BlobStoreProbe {
  async hasBlob(modelsFolder: string, digest: string): Promise<boolean> {
    return existsSync(join(modelsFolder, 'blobs', digestToBlobFilename(digest)));
  }
}

export class FsDiskSpaceProbe implements DiskSpaceProbe {
  async freeBytes(path: string): Promise<number | undefined> {
    let probe = path;
    for (let i = 0; i < 8; i += 1) {
      try {
        const stats = await statfs(probe);
        return stats.bfree * stats.bsize;
      } catch {
        const parent = join(probe, '..');
        if (parent === probe) break;
        probe = parent;
      }
    }
    return undefined;
  }
}
