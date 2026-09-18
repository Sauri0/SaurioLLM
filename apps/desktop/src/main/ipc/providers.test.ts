// Test de los handlers providers:list/add/update/remove/test (punto 6 del encargo: "unitarias...
// de los handlers") — apps/desktop/src/main/ipc/providers.test.ts. `electron` se mockea (igual que
// registerHandler.test.ts, vitest corre fuera de Electron); `RuntimeHost` se reemplaza por un objeto
// falso mínimo con exactamente los métodos que ipc/providers.ts invoca, así el test no depende de
// SQLite real ni de safeStorage real — eso ya lo cubren SqlProvidersRepository.test.ts y
// SecureKeyStore.test.ts por separado.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NonLocalCallAuditEntry, ProviderConfig } from '@saurio/shared';

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const fakeFrame = {} as never;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

const { allowFrame } = await import('./registerHandler.js');
const { registerProvidersHandlers } = await import('./providers.js');
type RuntimeHost = import('../host/RuntimeHost.js').RuntimeHost;

interface FakeRow {
  id: string; kind: 'ollama' | 'openai-compat' | 'cloud'; baseUrl: string;
  preset: ProviderConfig['preset']; label: string; enabled: boolean; headers?: Record<string, string>;
}

function makeFakeHost() {
  const rows = new Map<string, FakeRow>();
  const keys = new Map<string, string>();
  const refreshProviders = vi.fn();

  const host = {
    providersRepository: {
      get: (id: string) => rows.get(id),
      insert: (input: Omit<FakeRow, 'enabled'> & { enabled?: boolean }) => {
        rows.set(input.id, { ...input, enabled: input.enabled ?? true });
      },
      update: (id: string, patch: Partial<FakeRow>) => {
        const current = rows.get(id);
        if (!current) throw new Error('no existe');
        rows.set(id, { ...current, ...patch });
      },
      remove: (id: string) => { rows.delete(id); },
    },
    secureKeyStore: {
      set: (id: string, key: string) => keys.set(id, key),
      remove: (id: string) => keys.delete(id),
      has: (id: string) => keys.has(id),
      last4: (id: string) => (keys.has(id) ? keys.get(id)!.slice(-4) : undefined),
    },
    refreshProviders,
    listProviderConfigs: (): ProviderConfig[] => [...rows.values()].map((row) => ({
      id: row.id, preset: row.preset, kind: row.kind, label: row.label, baseUrl: row.baseUrl,
      enabled: row.enabled, locality: row.kind === 'ollama' ? 'local' : 'cloud',
      hasApiKey: keys.has(row.id), apiKeyLast4: keys.has(row.id) ? keys.get(row.id)!.slice(-4) : undefined,
      headers: row.headers, removable: row.id !== 'ollama',
    })),
    testProvider: vi.fn(async (id: string) => ({ providerId: id, ok: true, modelNames: ['modelo-x'] })),
    auditLog: {
      listNonLocalCalls: vi.fn((): NonLocalCallAuditEntry[] => [
        { id: 1, ts: 123, providerId: 'openrouter_1', modelName: 'llama-3.1-8b', locality: 'cloud', runId: 'run_1' },
      ]),
    },
  };
  return host;
}

async function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handle = handlers.get(channel);
  if (!handle) throw new Error(`canal no registrado: ${channel}`);
  return handle({ senderFrame: fakeFrame }, payload);
}

describe('ipc/providers', () => {
  beforeEach(() => {
    handlers.clear();
    allowFrame(fakeFrame);
  });

  it('providers:add guarda la clave en el almacén seguro y nunca la devuelve — solo hasApiKey/apiKeyLast4', async () => {
    const host = makeFakeHost();
    registerProvidersHandlers(host as unknown as RuntimeHost);

    const created = await invoke('providers:add', {
      preset: 'openai', label: 'Mi OpenAI', baseUrl: 'https://api.openai.com', apiKey: 'sk-abcd1234',
    }) as ProviderConfig;

    expect(created.hasApiKey).toBe(true);
    expect(created.apiKeyLast4).toBe('1234');
    expect(JSON.stringify(created)).not.toContain('sk-abcd1234');
    expect(host.refreshProviders).toHaveBeenCalled();
  });

  it('providers:add usa el baseUrl por defecto del preset cuando no se manda uno', async () => {
    const host = makeFakeHost();
    registerProvidersHandlers(host as unknown as RuntimeHost);

    const created = await invoke('providers:add', { preset: 'openrouter', label: 'OpenRouter', baseUrl: '' }) as ProviderConfig;
    expect(created.baseUrl).toBe('https://openrouter.ai/api');
  });

  it('providers:add con preset "custom" sin baseUrl rechaza (OpenAI-compatible personalizado lo exige)', async () => {
    const host = makeFakeHost();
    registerProvidersHandlers(host as unknown as RuntimeHost);

    await expect(invoke('providers:add', { preset: 'custom', label: 'LM Studio', baseUrl: '' }))
      .rejects.toThrow(/baseUrl/);
  });

  it('providers:update con apiKey: null borra la clave guardada', async () => {
    const host = makeFakeHost();
    registerProvidersHandlers(host as unknown as RuntimeHost);
    const created = await invoke('providers:add', {
      preset: 'anthropic', label: 'Claude', baseUrl: '', apiKey: 'sk-ant-secreto',
    }) as ProviderConfig;

    const updated = await invoke('providers:update', { id: created.id, apiKey: null }) as ProviderConfig;
    expect(updated.hasApiKey).toBe(false);
    expect(updated.apiKeyLast4).toBeUndefined();
  });

  it('providers:remove bloquea borrar el provider "ollama" sembrado por defecto', async () => {
    const host = makeFakeHost();
    host.providersRepository.insert({ id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', preset: 'ollama', label: 'Ollama (local)' });
    registerProvidersHandlers(host as unknown as RuntimeHost);

    await expect(invoke('providers:remove', { id: 'ollama' })).rejects.toThrow(/no se puede borrar/);
  });

  it('providers:test delega en host.testProvider() y devuelve el resultado tal cual', async () => {
    const host = makeFakeHost();
    registerProvidersHandlers(host as unknown as RuntimeHost);

    const result = await invoke('providers:test', { id: 'openai' });
    expect(host.testProvider).toHaveBeenCalledWith('openai');
    expect(result).toEqual({ providerId: 'openai', ok: true, modelNames: ['modelo-x'] });
  });

  it('providers:auditLog delega en host.auditLog.listNonLocalCalls() (punto 4 del encargo)', async () => {
    const host = makeFakeHost();
    registerProvidersHandlers(host as unknown as RuntimeHost);

    const result = await invoke('providers:auditLog', undefined) as NonLocalCallAuditEntry[];
    expect(host.auditLog.listNonLocalCalls).toHaveBeenCalled();
    expect(result).toEqual([
      { id: 1, ts: 123, providerId: 'openrouter_1', modelName: 'llama-3.1-8b', locality: 'cloud', runId: 'run_1' },
    ]);
  });

  it('providers:list refleja lo agregado', async () => {
    const host = makeFakeHost();
    registerProvidersHandlers(host as unknown as RuntimeHost);
    await invoke('providers:add', { preset: 'openai', label: 'A', baseUrl: 'https://api.openai.com' });

    const list = await invoke('providers:list', undefined) as ProviderConfig[];
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe('A');
  });
});
