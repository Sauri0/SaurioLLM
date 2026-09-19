import { HuggingFaceClient } from './HuggingFaceClient.js';
import { importHuggingFaceGguf } from './HuggingFaceImporter.js';
import type { DownloadProvider } from './types.js';

/** Conserva el gestor de jobs y el motor elegido; los GGUF públicos se verifican antes de importar. */
export function withHuggingFaceImports(provider: DownloadProvider, options: {
  ollamaBaseUrl: () => string;
  stagingRoot: string;
  client?: Pick<HuggingFaceClient, 'listGgufFiles'>;
  importer?: typeof importHuggingFaceGguf;
}): DownloadProvider {
  const client = options.client ?? new HuggingFaceClient();
  return {
    id: provider.id,
    delete: provider.delete ? (name) => provider.delete!(name) : undefined,
    unload: provider.unload ? (name) => provider.unload!(name) : undefined,
    async *pull(name, signal) {
      const baseUrl = options.ollamaBaseUrl();
      const hostname = new URL(baseUrl).hostname.toLowerCase();
      const localEngine = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
      // Un motor LAN administra sus propios archivos: conservar su contrato de pull remoto.
      if (!name.startsWith('hf.co/') || !localEngine) {
        if (!provider.pull) throw new Error('El motor no permite descargar modelos.');
        yield* provider.pull(name, signal);
        return;
      }
      const match = /^hf\.co\/([a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*)(?::([^:]+))?$/.exec(name);
      if (!match) throw new Error('La referencia Hugging Face no es válida. Elegí un repositorio y un archivo GGUF.');
      const repoId = match[1]!;
      const selector = match[2] && match[2] !== 'latest' ? match[2] : 'Q4_K_M';
      const files = await client.listGgufFiles(repoId, signal);
      const exactFile = files.find((file) => file.filename === selector);
      const candidates = exactFile ? [exactFile] : files.filter((file) => file.quant?.toLowerCase() === selector.toLowerCase());
      if (candidates.length !== 1) {
        throw new Error('No se pudo identificar un único GGUF para esa referencia. Elegí el archivo completo en Hugging Face.');
      }
      const selected = candidates[0]!;
      yield* (options.importer ?? importHuggingFaceGguf)({
        repoId, filename: selected.filename, expectedSize: selected.sizeBytes,
        expectedSha256: selected.sha256, modelName: name,
        ollamaBaseUrl: baseUrl, stagingRoot: options.stagingRoot, signal,
      });
    },
  };
}
