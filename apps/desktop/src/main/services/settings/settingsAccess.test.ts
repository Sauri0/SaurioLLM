import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocalSettingsStore } from './LocalSettingsStore.js';
import { migrateLegacyBootSettings, readSetting, writeSetting } from './settingsAccess.js';

it('persiste GPU y actualizaciones en el almacén que vuelve a leer el arranque, incluso con SQLite', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saurio-boot-settings-'));
  try {
    const file = path.join(dir, 'settings.local.json');
    const repository = { get: vi.fn(), set: vi.fn() };
    const stores = { settings: new LocalSettingsStore(file), settingsRepository: repository };
    await writeSetting(stores, 'app.gpuMitigationDisabled', true);
    await writeSetting(stores, 'updates.auto', false);
    const reopened = { ...stores, settings: new LocalSettingsStore(file) };
    expect(await readSetting(reopened, 'app.gpuMitigationDisabled')).toBe(true);
    expect(await readSetting(reopened, 'updates.auto')).toBe(false);
    expect(repository.set).not.toHaveBeenCalled();
    await writeSetting(stores, 'models.localOnly', true);
    expect(repository.set).toHaveBeenCalledWith('models.localOnly', true, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('no confirma como guardado un ajuste cuando falla la escritura', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saurio-settings-fail-'));
  try {
    const store = new LocalSettingsStore(path.join(dir, 'missing', 'settings.json'));
    expect(() => store.set('updates.auto', false)).toThrow();
    expect(store.get('updates.auto')).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('migra los ajustes de arranque de SQLite sin pisar el almacén local', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saurio-boot-settings-migrate-'));
  try {
    const file = path.join(dir, 'settings.local.json');
    const repository = {
      get: vi.fn(async (key: string) => ({
        'app.gpuMitigationDisabled': true,
        'updates.auto': false,
      })[key]),
      set: vi.fn(),
    };
    const settings = new LocalSettingsStore(file);
    await expect(migrateLegacyBootSettings({ settings, settingsRepository: repository })).resolves.toEqual([
      'app.gpuMitigationDisabled', 'updates.auto',
    ]);
    const reopened = new LocalSettingsStore(file);
    expect(reopened.get('app.gpuMitigationDisabled')).toBe(true);
    expect(reopened.get('updates.auto')).toBe(false);

    reopened.set('updates.auto', true);
    await expect(migrateLegacyBootSettings({ settings: reopened, settingsRepository: repository })).resolves.toEqual([]);
    expect(reopened.get('updates.auto')).toBe(true);
    expect(repository.get).toHaveBeenCalledWith('app.gpuMitigationDisabled');
    expect(repository.get).toHaveBeenCalledWith('updates.auto');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
