import { describe, expect, it } from 'vitest';
import { shouldStartAutoUpdater } from './shouldStartAutoUpdater.js';

describe('shouldStartAutoUpdater', () => {
  it('arranca en un build empaquetado, sin ajustes ni variables de entorno', () => {
    expect(shouldStartAutoUpdater({ isPackaged: true })).toBe(true);
  });

  it('no arranca sin empaquetar y sin feed de desarrollo', () => {
    expect(shouldStartAutoUpdater({ isPackaged: false })).toBe(false);
  });

  it('arranca sin empaquetar SI hay un feed de desarrollo explícito (prueba manual)', () => {
    expect(shouldStartAutoUpdater({ isPackaged: false, devFeedUrl: 'http://127.0.0.1:8080' })).toBe(true);
  });

  it('SAURIO_NO_UPDATE=1 desactiva incluso empaquetado', () => {
    expect(shouldStartAutoUpdater({ isPackaged: true, noUpdateEnv: '1' })).toBe(false);
  });

  it('cualquier otro valor de SAURIO_NO_UPDATE no desactiva', () => {
    expect(shouldStartAutoUpdater({ isPackaged: true, noUpdateEnv: '0' })).toBe(true);
    expect(shouldStartAutoUpdater({ isPackaged: true, noUpdateEnv: 'true' })).toBe(true);
  });

  it('updates.auto === false desactiva', () => {
    expect(shouldStartAutoUpdater({ isPackaged: true, settingsAuto: false })).toBe(false);
  });

  it('updates.auto sin setear (undefined) NO desactiva (default true, opt-out)', () => {
    expect(shouldStartAutoUpdater({ isPackaged: true, settingsAuto: undefined })).toBe(true);
  });

  it('updates.auto === true, o cualquier valor que no sea exactamente false, no desactiva', () => {
    expect(shouldStartAutoUpdater({ isPackaged: true, settingsAuto: true })).toBe(true);
    expect(shouldStartAutoUpdater({ isPackaged: true, settingsAuto: 'no' })).toBe(true);
    expect(shouldStartAutoUpdater({ isPackaged: true, settingsAuto: 0 })).toBe(true);
  });
});
