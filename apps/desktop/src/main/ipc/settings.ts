// Handlers IPC del dominio "settings" (doc 02 §1: apps/desktop/src/main/ipc/settings.ts, doc 01 §6).
// settings:get/set usan SettingsRepository si la integración ya lo conectó; si no, caen a
// LocalSettingsStore (RuntimeHost.settings, archivo JSON en userData) — ver deviation en
// host/RuntimeHost.ts. profiles:* (v0.2) también se registran acá: doc 02 §1 no les da un archivo
// propio dentro de ipc/ (la lista nombrada es project/chat/run/permission/checkpoint/models/
// terminal/metrics/settings/bench) y son ajustes-adyacentes, como el resto de este archivo.
import { ipc } from '@saurio/shared';
import { NotImplementedYetError } from '../host/RuntimeHost.js';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import { registerHandler } from './registerHandler.js';
import { readSetting, writeSetting } from '../services/settings/settingsAccess.js';

export function registerSettingsHandlers(host: RuntimeHost): void {
  registerHandler('settings:get', ipc['settings:get'], async (input) => {
    return readSetting(host, input.key, input.projectId);
  });

  registerHandler('settings:set', ipc['settings:set'], async (input) => {
    await writeSetting(host, input.key, input.value, input.projectId);
  });

  registerHandler('profiles:list', ipc['profiles:list'], async () => {
    throw new NotImplementedYetError('profiles:list', 'v0.2');
  });
  registerHandler('profiles:save', ipc['profiles:save'], async () => {
    throw new NotImplementedYetError('profiles:save', 'v0.2');
  });
  registerHandler('profiles:setDefault', ipc['profiles:setDefault'], async () => {
    throw new NotImplementedYetError('profiles:setDefault', 'v0.2');
  });
}
