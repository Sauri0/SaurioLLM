import { describe, expect, it, vi } from 'vitest';
import { withHuggingFaceImports } from './HuggingFaceDownloadProvider.js';
import type { importHuggingFaceGguf } from './HuggingFaceImporter.js';

const signal = new AbortController().signal;
async function collect(stream: AsyncIterable<unknown>) {
  const results = [];
  for await (const chunk of stream) results.push(chunk);
  return results;
}

function fixture(files = [{ filename: 'model-q8_0.gguf', quant: 'q8_0', sizeBytes: 100, sha256: 'a'.repeat(64) }]) {
  const received: Parameters<typeof importHuggingFaceGguf>[0][] = [];
  const importer: typeof importHuggingFaceGguf = async function* (input) {
    received.push(input);
    yield { status: 'success' };
    return { modelName: input.modelName, digest: 'sha256:test', sizeBytes: 100 };
  };
  const client = { listGgufFiles: vi.fn(async () => files) };
  const base = {
    id: 'ollama',
    pull: vi.fn(async function* () { yield { status: 'original' }; }),
    delete: vi.fn(async () => {}), unload: vi.fn(async () => {}),
  };
  let url = 'http://127.0.0.1:11435';
  const provider = withHuggingFaceImports(base, {
    ollamaBaseUrl: () => url, stagingRoot: 'isolated-stage', client, importer,
  });
  return { provider, base, client, received, changeUrl: (next: string) => { url = next; } };
}

describe('withHuggingFaceImports', () => {
  it('conserva pulls Ollama y acciones de inventario existentes', async () => {
    const f = fixture();
    expect(await collect(f.provider.pull!('qwen:latest', signal))).toEqual([{ status: 'original' }]);
    await f.provider.delete!('qwen:latest');
    await f.provider.unload!('qwen:latest');
    expect(f.base.delete).toHaveBeenCalledWith('qwen:latest');
    expect(f.base.unload).toHaveBeenCalledWith('qwen:latest');
    expect(f.client.listGgufFiles).not.toHaveBeenCalled();
  });

  it('resuelve cuantización real, digest publicado y motor vigente sin llamar pull HF roto', async () => {
    const f = fixture();
    f.changeUrl('http://127.0.0.1:11436');
    await collect(f.provider.pull!('hf.co/Qwen/repo:Q8_0', signal));
    expect(f.base.pull).not.toHaveBeenCalled();
    expect(f.client.listGgufFiles).toHaveBeenCalledWith('Qwen/repo', signal);
    expect(f.received[0]).toMatchObject({
      repoId: 'Qwen/repo', filename: 'model-q8_0.gguf', expectedSize: 100,
      expectedSha256: 'a'.repeat(64), modelName: 'hf.co/Qwen/repo:Q8_0',
      ollamaBaseUrl: 'http://127.0.0.1:11436', signal,
    });
  });

  it('no elige arbitrariamente entre dos archivos con igual cuantización', async () => {
    const f = fixture([
      { filename: 'one-q8_0.gguf', quant: 'q8_0', sizeBytes: 100, sha256: 'a'.repeat(64) },
      { filename: 'two-q8_0.gguf', quant: 'q8_0', sizeBytes: 100, sha256: 'b'.repeat(64) },
    ]);
    await expect(collect(f.provider.pull!('hf.co/Qwen/repo:q8_0', signal))).rejects.toThrow('único GGUF');
    expect(f.received).toHaveLength(0);
    await collect(f.provider.pull!('hf.co/Qwen/repo:two-q8_0.gguf', signal));
    expect(f.received[0]?.filename).toBe('two-q8_0.gguf');
  });

  it('rechaza referencias inválidas antes de consultar metadatos', async () => {
    const f = fixture();
    await expect(collect(f.provider.pull!('hf.co/../repo:q8_0', signal))).rejects.toThrow('no es válida');
    expect(f.client.listGgufFiles).not.toHaveBeenCalled();
  });

  it('conserva pull del motor LAN sin importar archivos locales a otro equipo', async () => {
    const f = fixture();
    f.changeUrl('http://192.168.1.20:11434');
    expect(await collect(f.provider.pull!('hf.co/Qwen/repo:q8_0', signal))).toEqual([{ status: 'original' }]);
    expect(f.received).toHaveLength(0);
    expect(f.client.listGgufFiles).not.toHaveBeenCalled();
  });
});
