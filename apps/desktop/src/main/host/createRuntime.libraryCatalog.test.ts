// Verifica que, con userData vacío y sin red, `models:libraryCatalog` (a través de
// `createGlobalRuntime`) cae al snapshot empaquetado real (`resources/model-catalog.snapshot.json`,
// >500 variantes) en vez de devolver un catálogo vacío — apps/desktop/src/main/host/
// createRuntime.libraryCatalog.test.ts.
//
// Contexto (agregado del director sobre una captura real, docs/capturas/smoke-models-explore.png):
// la pestaña Explorar mostró "Página 1 de 1 (0 modelos)" sin ningún error visible. La causa real,
// confirmada con un script de investigación puntual contra este mismo `createGlobalRuntime` (no
// commiteado): CUALQUIER combinación de appPath/resourcesPath usada en dev o en el empaquetado real
// (`release/win-unpacked/resources`) resuelve bien el snapshot embebido (858 variantes reales en el
// snapshot de esta sesión) — la resolución de recursos NO estaba rota. La causa real de "0 modelos"
// es que la sincronización en vivo contra ollama.com/library (~240 páginas) puede tardar varios
// segundos, y `ExploreTab.tsx` mostraba la MISMA UI de "0 modelos" mientras `loading` seguía en
// `true` (arreglado en ese archivo, ver el commit de esta tarea). Este test cubre la otra mitad del
// pedido: que el fallback a bundled realmente funcione de punta a punta contra los archivos reales
// del repo, no solo contra el snapshot en memoria de OllamaLibraryClient.test.ts.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGlobalRuntime, type GlobalRuntime } from './createRuntime.js';
import { ensureHostDataDirs, type HostAdapter } from './RuntimeHost.js';
import { SecureKeyStore, type SafeStorageLike } from '../services/providers/SecureKeyStore.js';

function makeFakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf-8').slice('enc:'.length),
  };
}

function makeHostAdapter(userDataDir: string, appPath: string, resourcesPath?: string): HostAdapter {
  return {
    paths: {
      userDataDir,
      dbPath: path.join(userDataDir, 'saurio.db'),
      blobsDir: path.join(userDataDir, 'blobs'),
      toolOutputsDir: path.join(userDataDir, 'tool-outputs'),
      logsDir: path.join(userDataDir, 'logs'),
      cacheDir: path.join(userDataDir, 'cache'),
      repoMapCacheDir: path.join(userDataDir, 'cache', 'repo-map'),
      appPath,
      resourcesPath,
    },
    async showOpenDirectoryDialog() { return { canceled: true }; },
    notify() { /* sin notificaciones en test */ },
  };
}

let tmpDirs: string[] = [];
let runtimes: GlobalRuntime[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const runtime of runtimes) runtime.persistence.close();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  runtimes = [];
  tmpDirs = [];
});

/** Simula "sin red hacia ollama.com" (el escenario real donde entra en juego el fallback), sin tocar
 *  ningún otro `fetch` real que el runtime necesite (p. ej. health checks a Ollama local). */
function stubOllamaComUnreachable(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('ollama.com')) throw new Error('ENOTFOUND ollama.com (simulado, sin red)');
    return realFetch(input, init);
  }));
}

describe('createGlobalRuntime + OllamaLibraryClient: fallback al snapshot empaquetado (userData vacío, sin red)', () => {
  it('en dev (appPath=apps/desktop real, resourcesPath undefined): cae al snapshot real con >500 variantes', async () => {
    stubOllamaComUnreachable();
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'saurio-library-catalog-dev-'));
    tmpDirs.push(tmp);
    // `appPath` real de dev: la raíz de apps/desktop (esta suite corre con cwd en el paquete, doc 02
    // §1) — `resources.ts` sube dos niveles desde ahí para llegar a <repo>/resources/*.
    const hostAdapter = makeHostAdapter(path.join(tmp, 'userData'), process.cwd());
    ensureHostDataDirs(hostAdapter.paths);
    const secureKeyStore = new SecureKeyStore(path.join(hostAdapter.paths.userDataDir, 'provider-keys.enc.json'), makeFakeSafeStorage());
    const runtime = createGlobalRuntime(hostAdapter, { secureKeyStore });
    runtimes.push(runtime);

    const result = await runtime.ollamaLibraryClient.getCatalog({});

    expect(result.source).toBe('bundled');
    expect(result.snapshot.variantCount).toBeGreaterThan(500);
    expect(result.snapshot.families.length).toBeGreaterThan(100);
  });

  it('empaquetado real (release/win-unpacked/resources, si existe de un build previo): mismo fallback', async () => {
    const releaseResources = path.resolve(process.cwd(), 'release', 'win-unpacked', 'resources');
    if (!existsSync(path.join(releaseResources, 'model-catalog.snapshot.json'))) {
      // No hay un build empaquetado a mano en esta corrida (p. ej. CI sin `build:installer` previo) —
      // el caso "empaquetado" ya queda cubierto por electron-builder.yml (extraResources, doc 16 §16)
      // más la verificación manual de esta tarea (smoke real del .exe). Se salta en vez de fallar.
      return;
    }
    stubOllamaComUnreachable();
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'saurio-library-catalog-pkg-'));
    tmpDirs.push(tmp);
    const hostAdapter = makeHostAdapter(path.join(tmp, 'userData'), path.join(releaseResources, 'app.asar'), releaseResources);
    ensureHostDataDirs(hostAdapter.paths);
    const secureKeyStore = new SecureKeyStore(path.join(hostAdapter.paths.userDataDir, 'provider-keys.enc.json'), makeFakeSafeStorage());
    const runtime = createGlobalRuntime(hostAdapter, { secureKeyStore });
    runtimes.push(runtime);

    const result = await runtime.ollamaLibraryClient.getCatalog({});

    expect(result.source).toBe('bundled');
    expect(result.snapshot.variantCount).toBeGreaterThan(500);
  });
});
