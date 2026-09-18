// Test de LocalSettingsStore (fallback de settings:get/set mientras no hay SettingsRepository real;
// ver deviation en host/RuntimeHost.ts).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalSettingsStore } from './LocalSettingsStore.js';

describe('LocalSettingsStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'saurio-settings-test-'));
    filePath = path.join(dir, 'settings.local.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('get() sobre una clave nunca seteada devuelve undefined', () => {
    const store = new LocalSettingsStore(filePath);
    expect(store.get('app.gpuMitigationDisabled')).toBeUndefined();
  });

  it('set()/get() global redondean el valor', () => {
    const store = new LocalSettingsStore(filePath);
    store.set('app.gpuMitigationDisabled', true);
    expect(store.get('app.gpuMitigationDisabled')).toBe(true);
  });

  it('la misma clave con distinto projectId no se pisa', () => {
    const store = new LocalSettingsStore(filePath);
    store.set('k', 'global-value');
    store.set('k', 'project-value', 'proj-1');
    expect(store.get('k')).toBe('global-value');
    expect(store.get('k', 'proj-1')).toBe('project-value');
  });

  it('persiste entre instancias (relee el archivo)', () => {
    const store1 = new LocalSettingsStore(filePath);
    store1.set('theme', 'dark');

    const store2 = new LocalSettingsStore(filePath);
    expect(store2.get('theme')).toBe('dark');
  });

  it('si el archivo no existe todavía, load() no tira', () => {
    const store = new LocalSettingsStore(path.join(dir, 'no-existe.json'));
    expect(() => store.load()).not.toThrow();
    expect(store.get('x')).toBeUndefined();
  });
});
