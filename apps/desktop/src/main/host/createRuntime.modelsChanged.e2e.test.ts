// Prueba real de punta a punta contra Ollama LOCAL (127.0.0.1:11434) — punto 3 del encargo (doc 16,
// "modelo descargado que no aparece"): descarga `all-minilm` de verdad, y reproduce EXACTAMENTE el
// bug real y el fix, contra el `ModelManager` real (mismo objeto que usan los canales IPC de
// apps/desktop/src/main/ipc/models.ts) — no un mock.
//
// Se salta entero (`describe.skipIf`) si Ollama no responde en loopback, para no romper CI/otras
// máquinas sin Ollama instalado — igual criterio que createRuntime.providers.e2e.test.ts (real
// contra OpenRouter, gated por OPENROUTER_API_KEY).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGlobalRuntime, type GlobalRuntime } from './createRuntime.js';
import { ensureHostDataDirs, type HostAdapter } from './RuntimeHost.js';
import { SecureKeyStore, type SafeStorageLike } from '../services/providers/SecureKeyStore.js';

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const MODEL_NAME = 'all-minilm:latest'; // ~46 MB (doc 16 §12.6, entrada real del catálogo curado) — chico, rápido de bajar/borrar.

async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function makeHostAdapter(userDataDir: string): HostAdapter {
  return {
    paths: {
      userDataDir,
      dbPath: path.join(userDataDir, 'saurio.db'),
      blobsDir: path.join(userDataDir, 'blobs'),
      toolOutputsDir: path.join(userDataDir, 'tool-outputs'),
      logsDir: path.join(userDataDir, 'logs'),
      cacheDir: path.join(userDataDir, 'cache'),
      repoMapCacheDir: path.join(userDataDir, 'cache', 'repo-map'),
      appPath: process.cwd(),
    },
    async showOpenDirectoryDialog() { return { canceled: true }; },
    notify() { /* sin notificaciones en test */ },
  };
}

function makeFakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf-8').slice('enc:'.length),
  };
}

let reachable = false;

describe('ModelManager cache + models:changed contra Ollama real (bug real v0.2.0, "modelo descargado no aparece")', async () => {
  reachable = await ollamaReachable();

  describe.skipIf(!reachable)('con Ollama corriendo en 127.0.0.1:11434', () => {
    let tmp: string;
    let runtime: GlobalRuntime;

    beforeAll(async () => {
      tmp = mkdtempSync(path.join(os.tmpdir(), 'saurio-models-changed-e2e-'));
      const hostAdapter = makeHostAdapter(path.join(tmp, 'userData'));
      ensureHostDataDirs(hostAdapter.paths);
      const secureKeyStore = new SecureKeyStore(path.join(hostAdapter.paths.userDataDir, 'provider-keys.enc.json'), makeFakeSafeStorage());
      runtime = createGlobalRuntime(hostAdapter, { secureKeyStore });

      // Limpieza defensiva: si una corrida anterior de este test dejó el modelo instalado, borrarlo
      // antes de empezar para que el "no aparecía antes de la descarga" del test sea real.
      const before = await runtime.modelManager.listInstalled(true);
      if (before.some((m) => m.ref.name === MODEL_NAME)) {
        await runtime.downloadManager.delete(MODEL_NAME).catch(() => {});
      }
    }, 30_000);

    afterAll(async () => {
      // Deja la máquina como estaba: borra el modelo que este test descargó.
      await runtime.downloadManager.delete(MODEL_NAME).catch((error: unknown) => {
        console.warn(`[e2e] no se pudo borrar "${MODEL_NAME}" al limpiar`, error);
      });
      runtime.persistence.close();
      rmSync(tmp, { recursive: true, force: true });
    }, 30_000);

    it(
      `descarga "${MODEL_NAME}" de verdad y reproduce el bug (caché vieja de listInstalled) + el fix ` +
      '(listInstalled(true) tras "done", exactamente lo que main/index.ts::broadcastModelsChanged hace ' +
      'para emitir models:changed)',
      async () => {
        // 0) Confirma que el modelo NO está instalado antes de empezar (si esto falla, la limpieza de
        //    beforeAll no funcionó — mejor abortar temprano que dar un falso positivo).
        const beforeDownload = await runtime.modelManager.listInstalled(true);
        expect(beforeDownload.some((m) => m.ref.name === MODEL_NAME)).toBe(false);

        // 1) `listInstalled(false)` cachea la lista SIN el modelo — simula cualquier canal IPC
        //    (models:list/catalog/libraryCatalog) que el usuario haya pedido antes de descargar.
        await runtime.modelManager.listInstalled(false);

        // 2) Descarga real contra Ollama, esperando el evento 'done' del DownloadManager real (mismo
        //    EventEmitter que apps/desktop/src/main/index.ts reenvía como 'download:done').
        const { downloadId } = await runtime.downloadManager.pull(MODEL_NAME);
        expect(downloadId).toBeTruthy();

        await new Promise<void>((resolve, reject) => {
          const onDone = (job: { id: string; modelName: string }): void => {
            if (job.id !== downloadId) return;
            cleanup();
            resolve();
          };
          const onFailed = (job: { id: string }, error: string): void => {
            if (job.id !== downloadId) return;
            cleanup();
            reject(new Error(`la descarga de "${MODEL_NAME}" falló: ${error}`));
          };
          const cleanup = (): void => {
            runtime.downloadManager.off('done', onDone);
            runtime.downloadManager.off('failed', onFailed);
          };
          runtime.downloadManager.on('done', onDone);
          runtime.downloadManager.on('failed', onFailed);
        });

        // 3) BUG REAL: sin invalidar la caché, `listInstalled(false)` (lo que hacía la app antes de
        //    esta tarea: nada llamaba a `listInstalled(true)` tras 'done') sigue sin mostrar el
        //    modelo recién descargado — reproduce exactamente "el modelo descargado no aparece".
        const staleAfterDownload = await runtime.modelManager.listInstalled(false);
        expect(staleAfterDownload.some((m) => m.ref.name === MODEL_NAME)).toBe(false);

        // 4) FIX: `listInstalled(true)` — exactamente lo que `main/index.ts::broadcastModelsChanged`
        //    llama ahora en el handler `onDone` de `host.onDownloadEvent`, antes de emitir
        //    `models:changed` al renderer — SÍ lo muestra, sin reiniciar la app.
        const freshAfterDownload = await runtime.modelManager.listInstalled(true);
        const found = freshAfterDownload.find((m) => m.ref.name === MODEL_NAME);
        expect(found).toBeDefined();
        expect(found?.sizeBytes).toBeGreaterThan(0);

        // 5) Y una vez refrescada la caché compartida, hasta un `listInstalled(false)` posterior (p.
        //    ej. el que hace `ExploreTab.tsx` al reaccionar a 'download:done') ya lo ve — la caché de
        //    `ModelManager` es una sola instancia compartida por todos los canales IPC.
        const cachedAfterFix = await runtime.modelManager.listInstalled(false);
        expect(cachedAfterFix.some((m) => m.ref.name === MODEL_NAME)).toBe(true);
      },
      120_000, // descarga real, generoso por las dudas de una red lenta
    );
  });
});
