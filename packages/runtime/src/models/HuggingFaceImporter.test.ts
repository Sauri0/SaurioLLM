import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  importHuggingFaceGguf,
  type HuggingFaceImportInput,
  type HuggingFaceImportResult,
} from './HuggingFaceImporter.js';
import type { PullProgress } from '../gateway/types.js';

const gguf = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.from(' synthetic model bytes')]);
const digest = createHash('sha256').update(gguf).digest('hex');
const roots: string[] = [];

async function stagingRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'saurio-hf-import-test-'));
  roots.push(root);
  return root;
}

function input(root: string, overrides: Partial<HuggingFaceImportInput> = {}): HuggingFaceImportInput {
  return {
    repoId: 'acme/model-gguf',
    filename: 'model-Q4_K_M.gguf',
    expectedSize: gguf.length,
    expectedSha256: digest,
    modelName: 'hf.co/acme/model-gguf:Q4_K_M',
    ollamaBaseUrl: 'http://127.0.0.1:11435',
    stagingRoot: root,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(
  generator: AsyncGenerator<PullProgress, HuggingFaceImportResult>,
): Promise<{ events: PullProgress[]; result: HuggingFaceImportResult }> {
  const events: PullProgress[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

async function requestBody(body: unknown): Promise<Buffer> {
  if (typeof body === 'string') return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('saurio-hf-import-test-') || relative.includes(path.sep)) {
      throw new Error('Directorio temporal inesperado en el test.');
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe('importHuggingFaceGguf', () => {
  it('sigue redirects oficiales, transmite el GGUF y crea el modelo sin ejecutar inferencia', async () => {
    const root = await stagingRoot();
    const orphan = path.join(root, '.hf-import-orphan1');
    await mkdir(orphan);
    await writeFile(path.join(orphan, 'model.gguf'), gguf);
    await utimes(orphan, new Date(0), new Date(0));
    let uploadedHex = '';
    let createPayload: unknown;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (resource, init) => {
      const url = String(resource);
      if (url === 'https://huggingface.co/acme/model-gguf/resolve/main/model-Q4_K_M.gguf') {
        expect(init?.redirect).toBe('manual');
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://us.aws.cdn.hf.co/xet-bridge-us/content',
            'x-linked-etag': `"${digest}"`,
          },
        });
      }
      if (url === 'https://us.aws.cdn.hf.co/xet-bridge-us/content') {
        return new Response(gguf, { headers: { 'content-length': String(gguf.length) } });
      }
      if (url === `http://127.0.0.1:11435/api/blobs/sha256:${digest}`) {
        uploadedHex = (await requestBody(init?.body)).toString('hex');
        return new Response(null, { status: 201 });
      }
      if (url === 'http://127.0.0.1:11435/api/create') {
        createPayload = JSON.parse(String(init?.body));
        return Response.json({ status: 'success' });
      }
      throw new Error(`Request inesperada: ${url}`);
    });

    const { events, result } = await collect(importHuggingFaceGguf(input(root), {
      fetchImpl,
      freeBytes: async () => 1024 ** 4,
      requestTimeoutMs: 1_000,
      staleStageAgeMs: 1,
    }));

    expect(uploadedHex).toBe(gguf.toString('hex'));
    expect(createPayload).toEqual({
      model: 'hf.co/acme/model-gguf:Q4_K_M',
      files: { 'model-Q4_K_M.gguf': `sha256:${digest}` },
      stream: false,
    });
    expect(result).toEqual({
      modelName: 'hf.co/acme/model-gguf:Q4_K_M', digest: `sha256:${digest}`, sizeBytes: gguf.length,
    });
    expect(new Set(events.map((event) => event.digest))).toEqual(new Set([`sha256:${digest}`]));
    expect(events.map((event) => event.status)).toEqual([
      'downloading', 'downloading', 'verifying sha256 digest', 'uploading blob', 'creating model', 'success',
    ]);
    expect(events.map((event) => event.completed)).toEqual([0, gguf.length, gguf.length, gguf.length, gguf.length, gguf.length]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(await readdir(root)).toEqual([]);
  });

  it('limita eventos aunque la red entregue muchos chunks pequeños', async () => {
    const root = await stagingRoot();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of gguf) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, {
      headers: { 'content-length': String(gguf.length) },
    }));
    const adapter = {
      uploadBlob: vi.fn(async () => undefined),
      createModel: vi.fn(async () => undefined),
    };
    const { events } = await collect(importHuggingFaceGguf(input(root), {
      fetchImpl,
      freeBytes: async () => 1024 ** 4,
      ollamaAdapter: adapter,
      progressBytes: Number.MAX_SAFE_INTEGER,
      progressIntervalMs: Number.MAX_SAFE_INTEGER,
    }));
    expect(events.filter((event) => event.status === 'downloading')).toHaveLength(2);
    expect(adapter.uploadBlob).toHaveBeenCalledWith(expect.objectContaining({ digest: `sha256:${digest}` }));
    expect(adapter.createModel).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('rechaza redirects fuera de los dominios oficiales antes de enviar otra request', async () => {
    const root = await stagingRoot();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: 'https://files.example.com/model.gguf' },
    }));
    await expect(collect(importHuggingFaceGguf(input(root), {
      fetchImpl, freeBytes: async () => 1024 ** 4,
    }))).rejects.toThrow('destino no permitido');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('cancela la request activa y limpia únicamente su staging', async () => {
    const root = await stagingRoot();
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_resource, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const generator = importHuggingFaceGguf(input(root, { signal: controller.signal }), {
      fetchImpl, freeBytes: async () => 1024 ** 4,
    });
    expect((await generator.next()).value).toMatchObject({ status: 'downloading', completed: 0 });
    const pending = generator.next();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(root)).toEqual([]);
  });

  it('rechaza tamaño, hash y cabecera GGUF inválidos antes de llamar a Ollama', async () => {
    const root = await stagingRoot();
    const download = (body: Buffer) => vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      headers: { 'content-length': String(body.length) },
    }));

    const wrongSize = download(gguf);
    await expect(collect(importHuggingFaceGguf(input(root, { expectedSize: gguf.length + 1 }), {
      fetchImpl: wrongSize, freeBytes: async () => 1024 ** 4,
    }))).rejects.toThrow('tamaño publicado');

    const wrongHash = download(gguf);
    await expect(collect(importHuggingFaceGguf(input(root, { expectedSha256: '0'.repeat(64) }), {
      fetchImpl: wrongHash, freeBytes: async () => 1024 ** 4,
    }))).rejects.toThrow('SHA-256 publicado');

    const html = Buffer.from('<htm>not a model</htm>');
    const wrongMagic = download(html);
    await expect(collect(importHuggingFaceGguf(input(root, {
      expectedSize: html.length,
      expectedSha256: createHash('sha256').update(html).digest('hex'),
    }), { fetchImpl: wrongMagic, freeBytes: async () => 1024 ** 4 }))).rejects.toThrow('cabecera GGUF');

    const overUnknownLimit = download(gguf);
    await expect(collect(importHuggingFaceGguf(input(root, {
      expectedSize: undefined, expectedSha256: undefined,
    }), {
      fetchImpl: overUnknownLimit, freeBytes: async () => 1024 ** 4, maxBytes: gguf.length - 1,
    }))).rejects.toThrow('límite permitido');

    expect(wrongSize).toHaveBeenCalledTimes(1);
    expect(wrongHash).toHaveBeenCalledTimes(1);
    expect(wrongMagic).toHaveBeenCalledTimes(1);
    expect(overUnknownLimit).toHaveBeenCalledTimes(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('falla antes de la red cuando el volumen de staging no alcanza', async () => {
    const root = await stagingRoot();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(collect(importHuggingFaceGguf(input(root), {
      fetchImpl, freeBytes: async () => gguf.length - 1,
    }))).rejects.toThrow('espacio suficiente');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('propaga errores de las APIs de blob y create y siempre limpia staging', async () => {
    const root = await stagingRoot();
    const failingFetch = (failure: 'blob' | 'create') => vi.fn<typeof fetch>().mockImplementation(async (resource) => {
      const url = String(resource);
      if (url.startsWith('https://huggingface.co/')) {
        return new Response(gguf, { headers: { 'content-length': String(gguf.length) } });
      }
      if (url.includes('/api/blobs/')) {
        return failure === 'blob' ? new Response('sin espacio', { status: 507 }) : new Response(null, { status: 201 });
      }
      if (url.endsWith('/api/create')) {
        return Response.json({ error: 'arquitectura no soportada' }, { status: 400 });
      }
      throw new Error(`Request inesperada: ${url}`);
    });

    await expect(collect(importHuggingFaceGguf(input(root), {
      fetchImpl: failingFetch('blob'), freeBytes: async () => 1024 ** 4,
    }))).rejects.toThrow('Ollama rechazó el blob');
    await expect(collect(importHuggingFaceGguf(input(root), {
      fetchImpl: failingFetch('create'), freeBytes: async () => 1024 ** 4,
    }))).rejects.toThrow('Ollama no pudo crear el modelo');
    expect(await readdir(root)).toEqual([]);
  });
});
