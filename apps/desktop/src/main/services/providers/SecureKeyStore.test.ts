// Test de SecureKeyStore (punto 6 del encargo: "unitarias del almacén (con safeStorage mockeado)")
// — apps/desktop/src/main/services/providers/SecureKeyStore.test.ts. `safeStorage` real requiere
// Electron; acá se inyecta un `SafeStorageLike` falso (cifrado reversible trivial, suficiente para
// probar el contrato: nunca guarda en claro, nunca lanza al leer una clave corrupta, avisa si el
// cifrado no está disponible en vez de guardar igual).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecureKeyStore, SecureKeyStoreUnavailableError, type SafeStorageLike } from './SecureKeyStore.js';

/** Cifrado falso pero reversible (Buffer.from/toString), NO seguro — solo para probar que
 *  SecureKeyStore nunca guarda el texto plano en el archivo y sí lo recupera vía `decryptString`. */
function makeFakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => {
      const raw = encrypted.toString('utf-8');
      if (!raw.startsWith('enc:')) throw new Error('formato inválido');
      return raw.slice('enc:'.length);
    },
  };
}

describe('SecureKeyStore', () => {
  let tmp: string;
  let filePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'saurio-keystore-'));
    filePath = path.join(tmp, 'provider-keys.enc.json');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('guarda y recupera una clave; el archivo en disco nunca contiene el texto plano', () => {
    const store = new SecureKeyStore(filePath, makeFakeSafeStorage());
    store.set('openai', 'sk-secreto-123');

    expect(store.get('openai')).toBe('sk-secreto-123');
    const onDisk = readFileSync(filePath, 'utf-8');
    expect(onDisk).not.toContain('sk-secreto-123');
  });

  it('last4() expone solo los últimos 4 caracteres', () => {
    const store = new SecureKeyStore(filePath, makeFakeSafeStorage());
    store.set('anthropic', 'sk-ant-api03-XYZ789');
    expect(store.last4('anthropic')).toBe('Z789');
  });

  it('has()/remove() reflejan si hay clave guardada', () => {
    const store = new SecureKeyStore(filePath, makeFakeSafeStorage());
    expect(store.has('openrouter')).toBe(false);
    store.set('openrouter', 'sk-or-1');
    expect(store.has('openrouter')).toBe(true);
    store.remove('openrouter');
    expect(store.has('openrouter')).toBe(false);
    expect(store.get('openrouter')).toBeUndefined();
  });

  it('sin safeStorage disponible: set() avisa (lanza) y no guarda nada', () => {
    const store = new SecureKeyStore(filePath, makeFakeSafeStorage(false));
    expect(() => store.set('openai', 'sk-x')).toThrow(SecureKeyStoreUnavailableError);
    expect(store.has('openai')).toBe(false);
  });

  it('una clave ilegible (archivo corrupto/SO cambió credenciales) se trata como "sin clave", nunca lanza', () => {
    const store = new SecureKeyStore(filePath, makeFakeSafeStorage());
    store.set('custom', 'sk-c');
    // Simula que `decryptString` ahora falla (SO cambió las credenciales del usuario) reabriendo con
    // un safeStorage cuyo decrypt siempre lanza, contra el mismo archivo ya escrito.
    const broken = new SecureKeyStore(filePath, {
      isEncryptionAvailable: () => true,
      encryptString: () => { throw new Error('no debería llamarse'); },
      decryptString: () => { throw new Error('credenciales del SO cambiaron'); },
    });
    expect(broken.get('custom')).toBeUndefined();
    expect(broken.last4('custom')).toBeUndefined();
  });

  it('persiste entre instancias (mismo filePath)', () => {
    const store1 = new SecureKeyStore(filePath, makeFakeSafeStorage());
    store1.set('openai', 'sk-persistente');

    const store2 = new SecureKeyStore(filePath, makeFakeSafeStorage());
    expect(store2.get('openai')).toBe('sk-persistente');
  });
});
