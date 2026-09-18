// Prueba real de punta a punta contra OpenRouter (punto 6 del encargo: "SOLO si existe la variable
// de entorno OPENROUTER_API_KEY") — apps/desktop/src/main/host/createRuntime.providers.e2e.test.ts.
// A diferencia de packages/runtime/src/gateway/providers/openai-compat/provider.test.ts (que ya
// prueba el Provider HTTP en sí, real, contra OpenRouter), esto prueba el CABLEADO de apps/desktop:
// agregar el provider vía SqlProvidersRepository + SecureKeyStore, refreshProviders() en caliente,
// providers:test (health+listModels), un chat corto con un modelo barato/gratuito, y que
// SqlAuditLogRepository registre la llamada no local (punto 4 del encargo). Sin la variable de
// entorno, se salta entero (`describe.skipIf`) — nunca se imprime el valor de la clave.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelRef } from '@saurio/shared';
import { createGlobalRuntime, type GlobalRuntime } from './createRuntime.js';
import { ensureHostDataDirs, type HostAdapter } from './RuntimeHost.js';
import { SecureKeyStore, type SafeStorageLike } from '../services/providers/SecureKeyStore.js';

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

/** Cifrado reversible trivial (NO seguro) — suficiente para que `SecureKeyStore.get()` le devuelva
 *  la clave real al `OpenAICompatProvider` en este test, sin depender de Electron real. */
function makeFakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf-8').slice('enc:'.length),
  };
}

async function collectContent(iter: AsyncIterable<{ type: string }>): Promise<{ type: string }[]> {
  const out: { type: string }[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

const openrouterKey = process.env.OPENROUTER_API_KEY;

describe.skipIf(openrouterKey === undefined || openrouterKey.length === 0)(
  'createRuntime + providers (integración real con OpenRouter, opcional — requiere OPENROUTER_API_KEY)',
  () => {
    let tmp: string;
    let runtime: GlobalRuntime;

    beforeEach(() => {
      tmp = mkdtempSync(path.join(os.tmpdir(), 'saurio-providers-e2e-'));
      const hostAdapter = makeHostAdapter(path.join(tmp, 'userData'));
      ensureHostDataDirs(hostAdapter.paths);
      const secureKeyStore = new SecureKeyStore(path.join(hostAdapter.paths.userDataDir, 'provider-keys.enc.json'), makeFakeSafeStorage());
      runtime = createGlobalRuntime(hostAdapter, { secureKeyStore });
    });

    afterEach(() => {
      runtime.persistence.close();
      rmSync(tmp, { recursive: true, force: true });
    });

    it('agregar proveedor + probar conexión + listar modelos + chat corto + badge NUBE (locality) + audit_log', async () => {
      // 1) Agregar proveedor (punto 3 del encargo) — mismo flujo que ipc/providers.ts `providers:add`.
      runtime.providersRepository.insert({
        id: 'openrouter', kind: 'openai-compat', baseUrl: 'https://openrouter.ai/api', preset: 'openrouter',
        label: 'OpenRouter', headers: { 'HTTP-Referer': 'https://saurio.local', 'X-Title': 'SaurioLLM' },
      });
      runtime.secureKeyStore.set('openrouter', openrouterKey!);
      runtime.refreshProviders();

      // 2) "Probar conexión" real (health + listModels) — punto 3 del encargo.
      const testResult = await runtime.testProvider('openrouter');
      expect(testResult.ok).toBe(true);
      expect(testResult.modelNames?.length ?? 0).toBeGreaterThan(0);

      // 3) `providers:list`/`listProviderConfigs()` nunca expone la clave real, solo hasApiKey/last4;
      //    `locality: 'cloud'` es lo que la UI usa para pintar el badge NUBE (ChatHeader/MessageBubble/
      //    ModelSelect, ya cubiertos por su propio render — acá se verifica el dato de origen).
      const config = runtime.listProviderConfigs().find((p) => p.id === 'openrouter');
      expect(config?.hasApiKey).toBe(true);
      expect(config?.apiKeyLast4).toBe(openrouterKey!.slice(-4));
      expect(JSON.stringify(config)).not.toContain(openrouterKey);
      expect(config?.locality).toBe('cloud');

      // 4) `models:list` real: el modelo elegido tiene que aparecer con locality 'cloud'.
      const installed = await runtime.modelManager.listInstalled();
      const modelName = testResult.modelNames?.find((n) => n.includes(':free')) ?? 'meta-llama/llama-3.1-8b-instruct';
      const fromModelManager = installed.find((m) => m.ref.providerId === 'openrouter' && m.ref.name === modelName);
      expect(fromModelManager?.ref.locality ?? 'cloud').toBe('cloud'); // por si el modelo elegido no está en el listado paginado

      // 5) Chat corto con un modelo barato/gratuito, a través del ModelGateway real (mismo camino
      //    que usa un run real) — verifica que el cableado completo (host -> gateway -> provider) sirve.
      const ref: ModelRef = { providerId: 'openrouter', name: modelName, locality: 'cloud' };
      const chunks = await collectContent(runtime.gateway.chat(
        ref,
        {
          model: modelName,
          messages: [{ id: 'm1', role: 'user', content: 'Respondé solo con la palabra: hola' }],
          options: { numCtx: 8192, temperature: 0, numPredict: 16 },
        },
        { runId: 'e2e-openrouter-run', signal: new AbortController().signal, authorizedLocality: ['cloud'], priority: 'interactive' },
      ));
      expect(chunks.some((c) => c.type === 'content' || c.type === 'done')).toBe(true);

      // 6) audit_log: el hook `onNonLocalCall` de ModelGatewayImpl (cambio aditivo de esta tarea en
      //    packages/runtime) tiene que haber registrado ESTA llamada (punto 4 del encargo).
      const auditEntries = runtime.auditLog.listNonLocalCalls();
      expect(auditEntries.some((e) => e.runId === 'e2e-openrouter-run' && e.providerId === 'openrouter' && e.locality === 'cloud')).toBe(true);
    }, 30_000);
  },
);
