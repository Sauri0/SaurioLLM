import type { SettingsRepository } from '@saurio/runtime/persistence/types';
import type { LocalSettingsStore } from './LocalSettingsStore.js';

const BOOT_SETTINGS = new Set(['app.gpuMitigationDisabled', 'updates.auto']);
interface Stores { settings: LocalSettingsStore; settingsRepository: SettingsRepository | undefined }

/**
 * v0.2.2 guardaba cualquier clave global en SQLite. Las claves de arranque se movieron a JSON para
 * poder decidir antes de abrir la base; al actualizar, se copian una vez sin pisar una elección que
 * ya exista en el almacén local. La fila SQLite se conserva como respaldo histórico.
 *
 * La GPU ya pudo haberse decidido antes de esta migración: el valor trasladado se aplica desde el
 * próximo arranque. `updates.auto`, en cambio, se migra antes de iniciar el updater de este arranque.
 */
export async function migrateLegacyBootSettings(stores: Stores): Promise<string[]> {
  if (!stores.settingsRepository) return [];
  const migrated: string[] = [];
  for (const key of BOOT_SETTINGS) {
    if (stores.settings.get(key) !== undefined) continue;
    const legacyValue = await stores.settingsRepository.get(key);
    if (typeof legacyValue !== 'boolean') continue;
    stores.settings.set(key, legacyValue);
    migrated.push(key);
  }
  return migrated;
}

/** Los ajustes leídos antes de abrir SQLite viven en el mismo JSON que consulta el arranque. */
export async function readSetting(stores: Stores, key: string, projectId?: string): Promise<unknown> {
  if (BOOT_SETTINGS.has(key)) return stores.settings.get(key);
  return stores.settingsRepository ? stores.settingsRepository.get(key, projectId) : stores.settings.get(key, projectId);
}

export async function writeSetting(stores: Stores, key: string, value: unknown, projectId?: string): Promise<void> {
  if (BOOT_SETTINGS.has(key)) {
    if (projectId !== undefined || typeof value !== 'boolean') throw new Error('Este ajuste requiere un valor booleano global.');
    stores.settings.set(key, value);
  } else if (stores.settingsRepository) await stores.settingsRepository.set(key, value, projectId);
  else stores.settings.set(key, value, projectId);
}
