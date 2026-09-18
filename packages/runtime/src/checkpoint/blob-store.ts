// BlobStore content-addressed — packages/runtime/src/checkpoint/blob-store.ts.
// Define: doc 09 §2.1-2.2 (appData/blobs/<hash>, escritura atómica tmp -> fsync -> rename antes del
// INSERT en `blobs`, refcount para deduplicar, recalculo de hash al leer para detectar corrupción).
// Implementa la interfaz fija `BlobStore` de packages/runtime/src/checkpoint/types.ts (no modificable).
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BlobStore } from './types.js';
import type { BlobRefStore } from './repositories.js';
import { atomicWrite, readFileRaw } from './fs-atomic.js';
import { sha256 } from './hash.js';

export class FileBlobStore implements BlobStore {
  constructor(
    private readonly blobsDir: string,
    private readonly refs: BlobRefStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async put(content: Buffer | string): Promise<{ hash: string; size: number }> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const hash = sha256(buf);
    const dest = this.pathFor(hash);

    // doc 09 §2.2: antes de confiar en un blob ya presente, se recalcula su hash — si no coincide
    // (escritura truncada de un crash anterior) se reescribe en vez de darlo por bueno.
    const existing = await readFileRaw(dest);
    const alreadyValid = existing !== undefined && sha256(existing) === hash;
    if (!alreadyValid) {
      await atomicWrite(dest, buf, `${hash}-${process.pid}-${randomUUID()}`);
    }
    this.refs.upsertRef(hash, buf.length, this.now());
    return { hash, size: buf.length };
  }

  async get(hash: string): Promise<Buffer | null> {
    const content = await readFileRaw(this.pathFor(hash));
    if (content === undefined) return null;
    // mismo recalculo que en put(): un blob cuyo contenido no coincide con su nombre no se usa.
    if (sha256(content) !== hash) return null;
    return content;
  }

  addRef(hash: string): void {
    const record = this.refs.get(hash);
    this.refs.upsertRef(hash, record?.size ?? 0, record?.createdAt ?? this.now());
  }

  releaseRef(hash: string): void {
    this.refs.releaseRef(hash);
  }

  private pathFor(hash: string): string {
    return path.join(this.blobsDir, hash);
  }
}
