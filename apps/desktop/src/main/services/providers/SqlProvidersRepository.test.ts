// Test de SqlProvidersRepository contra SQLite real (migraciones reales de packages/runtime/src/
// persistence, tabla `providers` ya migrada) — apps/desktop/src/main/services/providers/
// SqlProvidersRepository.test.ts. Mismo patrón que apps/desktop/src/main/host/createRuntime.test.ts:
// `openPersistence` sobre una carpeta temporal, sin mockear nada de packages/runtime.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPersistence, type PersistenceHandle } from '@saurio/runtime/persistence/index';
import { SqlProvidersRepository, isLoopbackUrl, ProviderInUseError, OLLAMA_PROVIDER_ID, toProviderConfig } from './SqlProvidersRepository.js';

describe('isLoopbackUrl', () => {
  it('reconoce 127.0.0.1/localhost como loopback', () => {
    expect(isLoopbackUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLoopbackUrl('http://localhost:1234')).toBe(true);
  });
  it('un host remoto no es loopback', () => {
    expect(isLoopbackUrl('https://api.openai.com')).toBe(false);
    expect(isLoopbackUrl('https://openrouter.ai/api')).toBe(false);
  });
  it('una URL inválida no lanza, devuelve false', () => {
    expect(isLoopbackUrl('no-es-una-url')).toBe(false);
  });
});

describe('SqlProvidersRepository', () => {
  let tmp: string;
  let persistence: PersistenceHandle;
  let repo: SqlProvidersRepository;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'saurio-providers-repo-'));
    persistence = openPersistence(path.join(tmp, 'saurio.db'));
    repo = new SqlProvidersRepository(persistence.driver);
  });

  afterEach(() => {
    persistence.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('insert()/get() guardan preset/label/headers en config_json y is_loopback derivado del baseUrl', () => {
    repo.insert({ id: 'openai', kind: 'openai-compat', baseUrl: 'https://api.openai.com', preset: 'openai', label: 'OpenAI' });
    const stored = repo.get('openai');
    expect(stored).toEqual({
      id: 'openai', kind: 'openai-compat', baseUrl: 'https://api.openai.com', isLoopback: false,
      enabled: true, mode: 'attach', preset: 'openai', label: 'OpenAI', headers: undefined,
    });
  });

  it('list() devuelve todos los providers insertados', () => {
    repo.insert({ id: 'openai', kind: 'openai-compat', baseUrl: 'https://api.openai.com', preset: 'openai', label: 'OpenAI' });
    repo.insert({ id: 'anthropic', kind: 'cloud', baseUrl: 'https://api.anthropic.com', preset: 'anthropic', label: 'Anthropic' });
    expect(repo.list().map((p) => p.id).sort()).toEqual(['anthropic', 'openai']);
  });

  it('update() cambia baseUrl/label/enabled/headers y recalcula is_loopback', () => {
    repo.insert({ id: 'lmstudio', kind: 'openai-compat', baseUrl: 'https://example.com', preset: 'custom', label: 'LM Studio' });
    const updated = repo.update('lmstudio', { baseUrl: 'http://127.0.0.1:1234', enabled: false, headers: { 'X-Title': 'Saurio' } });
    expect(updated.baseUrl).toBe('http://127.0.0.1:1234');
    expect(updated.isLoopback).toBe(true);
    expect(updated.enabled).toBe(false);
    expect(updated.headers).toEqual({ 'X-Title': 'Saurio' });
    expect(updated.label).toBe('LM Studio'); // no se tocó, se conserva
  });

  it('remove() borra un provider agregado por el usuario', () => {
    repo.insert({ id: 'groq', kind: 'openai-compat', baseUrl: 'https://api.groq.com', preset: 'custom', label: 'Groq' });
    repo.remove('groq');
    expect(repo.get('groq')).toBeUndefined();
  });

  it('remove() nunca borra el provider "ollama" sembrado por defecto', () => {
    repo.insert({ id: OLLAMA_PROVIDER_ID, kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', preset: 'ollama', label: 'Ollama (local)' });
    expect(() => repo.remove(OLLAMA_PROVIDER_ID)).toThrow(ProviderInUseError);
    expect(repo.get(OLLAMA_PROVIDER_ID)).toBeDefined();
  });

  it('toProviderConfig() nunca incluye la clave real, solo hasApiKey/apiKeyLast4', () => {
    repo.insert({ id: 'anthropic', kind: 'cloud', baseUrl: 'https://api.anthropic.com', preset: 'anthropic', label: 'Anthropic' });
    const stored = repo.get('anthropic')!;
    const config = toProviderConfig(stored, 'cloud', true, 'ab12');
    expect(config).toEqual({
      id: 'anthropic', preset: 'anthropic', kind: 'cloud', label: 'Anthropic', baseUrl: 'https://api.anthropic.com',
      enabled: true, locality: 'cloud', hasApiKey: true, apiKeyLast4: 'ab12', headers: undefined, removable: true,
    });
    expect(JSON.stringify(config)).not.toMatch(/sk-/);
  });
});
