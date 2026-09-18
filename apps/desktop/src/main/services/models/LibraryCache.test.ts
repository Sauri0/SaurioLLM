// Test de FileLibraryCache (implementación real de LibraryCachePort sobre disco) —
// apps/desktop/src/main/services/models/LibraryCache.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OllamaLibrarySnapshot } from '@saurio/runtime/models/index';
import { FileLibraryCache } from './LibraryCache.js';

const SNAPSHOT: OllamaLibrarySnapshot = {
  generatedAt: '2026-09-18T00:00:00.000Z',
  source: 'https://ollama.com/library',
  familyCount: 1,
  variantCount: 1,
  families: [{
    name: 'qwen3', capabilityHints: ['tools'], sizeHints: ['8b'],
    variants: [{ tag: '8b', sizeBytes: 5_225_388_164, contextMax: 40960, vision: false }],
  }],
};

describe('FileLibraryCache', () => {
  let tmp: string;
  let filePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'saurio-library-cache-'));
    filePath = path.join(tmp, 'nested', 'model-library-cache.json');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('read() sin archivo todavía: undefined (no lanza)', async () => {
    const cache = new FileLibraryCache(filePath);
    expect(await cache.read()).toBeUndefined();
  });

  it('write() + read() redondo, creando subcarpetas si hace falta', async () => {
    const cache = new FileLibraryCache(filePath);
    await cache.write(SNAPSHOT, 1234);
    const result = await cache.read();
    expect(result?.cachedAt).toBe(1234);
    expect(result?.snapshot.familyCount).toBe(1);
    expect(result?.snapshot.families[0]?.name).toBe('qwen3');
  });

  it('archivo corrupto: read() devuelve undefined en vez de lanzar', async () => {
    const corruptPath = path.join(tmp, 'corrupt.json');
    writeFileSync(corruptPath, '{ esto no es json válido', 'utf-8');
    const cache = new FileLibraryCache(corruptPath);
    expect(await cache.read()).toBeUndefined();
  });

  it('JSON con forma vieja/inválida (no cumple el esquema): read() devuelve undefined', async () => {
    const flatPath = path.join(tmp, 'flat.json');
    writeFileSync(flatPath, JSON.stringify({ snapshot: { foo: 'bar' }, cachedAt: 1 }), 'utf-8');
    const cache = new FileLibraryCache(flatPath);
    expect(await cache.read()).toBeUndefined();
  });
});
