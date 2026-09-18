// shouldStartAutoUpdater — apps/desktop/src/main/services/updater/shouldStartAutoUpdater.ts.
// Decisión pura (sin Electron, sin electron-updater) de si conviene arrancar el servicio de
// auto-actualización, para poder testearla sin mockear módulos nativos. Encierra las tres condiciones
// del punto 2 del encargo:
//  - "solo cuando app.isPackaged" (con una salida para pruebas locales de punta a punta del punto 4,
//    ver docs/INSTALAR.md "Prueba manual" — `devFeedUrl` viene de una variable de entorno de
//    desarrollo, nunca se usa en producción).
//  - variable de entorno `SAURIO_NO_UPDATE=1` para desactivar.
//  - ajuste `updates.auto` (por defecto true) en settings.local.json.
export interface ShouldStartAutoUpdaterInput {
  isPackaged: boolean;
  /** `process.env['SAURIO_UPDATE_DEV_FEED']` — URL de un feed genérico local (electron-builder
   *  `provider: generic`), solo para la prueba manual de punta a punta descrita en docs/INSTALAR.md. */
  devFeedUrl?: string | undefined;
  /** `process.env['SAURIO_NO_UPDATE']` tal cual, sin parsear. */
  noUpdateEnv?: string | undefined;
  /** Valor crudo de `LocalSettingsStore.get('updates.auto')` — `undefined` (nunca seteado) cuenta como
   *  "true" (el ajuste es opt-out, por defecto activado); cualquier valor que no sea `false` también
   *  se trata como activado (un valor corrupto/inesperado no debería desactivar la actualización). */
  settingsAuto?: unknown;
}

export function shouldStartAutoUpdater(input: ShouldStartAutoUpdaterInput): boolean {
  if (!input.isPackaged && !input.devFeedUrl) return false;
  if (input.noUpdateEnv === '1') return false;
  if (input.settingsAuto === false) return false;
  return true;
}
