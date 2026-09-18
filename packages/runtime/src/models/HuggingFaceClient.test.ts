// Tests de HuggingFaceClient contra los fixtures reales investigados en la sesión anterior —
// packages/runtime/src/models/HuggingFaceClient.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HuggingFaceClient } from './HuggingFaceClient.js';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');
const searchFixture = readFileSync(path.join(FIXTURES_DIR, 'hf-search-qwen.sample.json'), 'utf-8');
const detailFixture = readFileSync(path.join(FIXTURES_DIR, 'hf-model-detail-bartowski-qwen25coder7b.sample.json'), 'utf-8');

function fakeFetch(body: string): typeof fetch {
  return vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

describe('HuggingFaceClient.searchModels', () => {
  it('parsea el fixture real de búsqueda', async () => {
    const client = new HuggingFaceClient({ fetchImpl: fakeFetch(searchFixture) });
    const results = await client.searchModels('qwen');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({ id: 'ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF' });
    expect(results[0]!.downloads).toBeGreaterThan(0);
    expect(results[0]!.tags).toContain('gguf');
  });

  it('pide la URL con filter=gguf y el término de búsqueda codificado', async () => {
    const fetchImpl = fakeFetch('[]');
    const client = new HuggingFaceClient({ fetchImpl });
    await client.searchModels('qwen coder');
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('filter=gguf');
    expect(String(url)).toContain(encodeURIComponent('qwen coder'));
  });
});

describe('HuggingFaceClient.listGgufFiles', () => {
  it('filtra solo .gguf y descarta README/gitattributes/imatrix', async () => {
    const client = new HuggingFaceClient({ fetchImpl: fakeFetch(detailFixture) });
    const files = await client.listGgufFiles('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF');
    expect(files.every((f) => f.filename.toLowerCase().endsWith('.gguf'))).toBe(true);
    expect(files.find((f) => f.filename.includes('README'))).toBeUndefined();
    expect(files.find((f) => f.filename.includes('imatrix'))).toBeUndefined();
  });

  it('parsea la cuantización del nombre de archivo', async () => {
    const client = new HuggingFaceClient({ fetchImpl: fakeFetch(detailFixture) });
    const files = await client.listGgufFiles('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF');
    const q4km = files.find((f) => f.filename.endsWith('Q4_K_M.gguf'))!;
    expect(q4km.quant).toBe('Q4_K_M');
    const iq2m = files.find((f) => f.filename.endsWith('IQ2_M.gguf'))!;
    expect(iq2m.quant).toBe('IQ2_M');
    const f16 = files.find((f) => f.filename.endsWith('-f16.gguf'))!;
    expect(f16.quant).toBe('f16');
  });

  it('el fixture guardado no trae tamaño (sin ?blobs=true): sizeBytes queda undefined, nunca inventado', async () => {
    const client = new HuggingFaceClient({ fetchImpl: fakeFetch(detailFixture) });
    const files = await client.listGgufFiles('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF');
    expect(files.every((f) => f.sizeBytes === undefined)).toBe(true);
  });

  it('con tamaño real (?blobs=true, verificado en vivo esta sesión) lo expone', async () => {
    const withBlobs = JSON.stringify({
      id: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',
      siblings: [{ rfilename: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf', size: 4683087561 }],
    });
    const client = new HuggingFaceClient({ fetchImpl: fakeFetch(withBlobs) });
    const files = await client.listGgufFiles('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF');
    expect(files[0]!.sizeBytes).toBe(4683087561);
  });

  it('pide ?blobs=true para traer el tamaño', async () => {
    const fetchImpl = fakeFetch(JSON.stringify({ id: 'x', siblings: [] }));
    const client = new HuggingFaceClient({ fetchImpl });
    await client.listGgufFiles('user/repo');
    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('blobs=true');
  });
});

describe('HuggingFaceClient.buildOllamaRef', () => {
  it('formato hf.co/<usuario>/<repo>:<quant>', () => {
    const client = new HuggingFaceClient();
    expect(client.buildOllamaRef('bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', 'Q4_K_M'))
      .toBe('hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M');
  });
});
