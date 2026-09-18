// Almacén seguro de claves de API — apps/desktop/src/main/services/providers/SecureKeyStore.ts.
// Punto 1 del encargo: "guardar/leer/borrar por providerId; nunca en SQLite en claro, nunca en logs,
// nunca enviado al renderer (el renderer solo ve 'clave configurada: sí/no' y los últimos 4
// caracteres). Si safeStorage no está disponible, avisar y no guardar."
//
// Deliberadamente SIN `import { safeStorage } from 'electron'` acá (mismo criterio que
// services/resources.ts): este módulo recibe una implementación de `SafeStorageLike` ya resuelta por
// `index.ts` (el único lugar con Electron real, doc 02 §1 ADR-002), para que las pruebas unitarias
// puedan inyectar un `safeStorage` falso sin un proceso Electron real.
//
// Persistencia: un único archivo JSON en userData (`provider-keys.enc.json`), providerId -> texto
// cifrado en base64 (`safeStorage.encryptString`, cifrado atado al usuario/SO — DPAPI en Windows,
// Keychain en macOS, libsecret en Linux [VERIFICADO EN DOC OFICIAL: electronjs.org/docs/latest/api/
// safe-storage]). Nunca se guarda la clave en texto plano en ningún lado; `get()`/`last4()` son las
// únicas formas de recuperar el valor real, y ninguna de las dos lo loguea.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Subconjunto de `Electron.safeStorage` que este módulo necesita. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class SecureKeyStoreUnavailableError extends Error {
  constructor() {
    super(
      'saurio: el almacén seguro de claves (Electron safeStorage) no está disponible en este sistema ' +
        '(sin backend de cifrado del SO) — no se guardó ninguna clave.',
    );
    this.name = 'SecureKeyStoreUnavailableError';
  }
}

type KeyFile = Record<string, string>; // providerId -> ciphertext base64

export class SecureKeyStore {
  private cache: KeyFile | undefined;

  constructor(private readonly filePath: string, private readonly safeStorage: SafeStorageLike) {}

  isAvailable(): boolean {
    try {
      return this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private load(): KeyFile {
    if (this.cache) return this.cache;
    try {
      this.cache = existsSync(this.filePath)
        ? (JSON.parse(readFileSync(this.filePath, 'utf-8')) as KeyFile)
        : {};
    } catch (error) {
      console.error('[providers] no se pudo leer provider-keys.enc.json, se arranca vacío', error);
      this.cache = {};
    }
    return this.cache;
  }

  private persist(data: KeyFile): void {
    this.cache = data;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(data));
    } catch (error) {
      console.error('[providers] no se pudo escribir provider-keys.enc.json', error);
    }
  }

  has(providerId: string): boolean {
    return providerId in this.load();
  }

  /** Nunca lanza: una clave ilegible (SO cambió las credenciales del usuario, archivo corrupto) se
   *  trata como "sin clave", no como error fatal — y nunca se loguea el valor real. */
  get(providerId: string): string | undefined {
    const raw = this.load()[providerId];
    if (!raw) return undefined;
    try {
      return this.safeStorage.decryptString(Buffer.from(raw, 'base64'));
    } catch (error) {
      console.error(`[providers] no se pudo desencriptar la clave de "${providerId}" (no se imprime el valor)`, error);
      return undefined;
    }
  }

  /** Únicos 4 caracteres que puede ver el renderer (punto 1 del encargo). */
  last4(providerId: string): string | undefined {
    const value = this.get(providerId);
    return value && value.length > 0 ? value.slice(-4) : undefined;
  }

  /** Lanza `SecureKeyStoreUnavailableError` si `safeStorage` no puede cifrar en este equipo —
   *  nunca hace fallback a guardar en claro. */
  set(providerId: string, apiKey: string): void {
    if (!this.isAvailable()) throw new SecureKeyStoreUnavailableError();
    const data = { ...this.load(), [providerId]: this.safeStorage.encryptString(apiKey).toString('base64') };
    this.persist(data);
  }

  remove(providerId: string): void {
    if (!this.has(providerId)) return;
    const data = { ...this.load() };
    delete data[providerId];
    this.persist(data);
  }
}
