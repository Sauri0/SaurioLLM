// startAutoUpdater — apps/desktop/src/main/services/updater/index.ts.
// Único punto de esta carpeta que importa 'electron' y 'electron-updater' de verdad; arma
// `AutoUpdaterService` (lógica testeada sin Electron, ver AutoUpdaterService.ts) con las piezas reales.
// Este archivo es el que agrega `apps/desktop/src/main/index.ts` con SU ÚNICA línea de import y SU
// ÚNICA llamada (encargo de esta tarea): `startAutoUpdater({ host })`, sin nada más alrededor.
import path from 'node:path';
import { app, dialog } from 'electron';
// FIX DE BLOQUEO TOTAL DE ARRANQUE (encontrado al verificar la PRIORIDAD CERO de esta sesión, ajeno
// a esa zona pero imposible de no arreglar: rompía el 100% de los arranques, con o sin Ollama):
// 'electron-updater' es CommonJS; `import { autoUpdater } from 'electron-updater'` compila pero
// revienta en runtime bajo ESM real ("Named export 'autoUpdater' not found") apenas Electron carga
// out/main/index.js — confirmado corriendo `pnpm --filter @saurio/desktop run dev` de verdad
// (SAURIO_SMOKE=1): la app moría antes de crear la ventana, en TODOS los casos, no solo con Ollama
// apagado. Import por default + destructuring, patrón estándar de interop ESM/CJS para este paquete
// [VERIFICADO EN DOC OFICIAL: github.com/electron-userland/electron-builder "ESM" / issues conocidos
// de electron-updater con "type": "module"].
import electronUpdaterPkg from 'electron-updater';
import { AutoUpdaterService } from './AutoUpdaterService.js';
import { ActiveRunTracker } from './activeRunTracker.js';
import { createFileLogger } from './fileLogger.js';
import { shouldStartAutoUpdater } from './shouldStartAutoUpdater.js';
import { LocalSettingsStore } from '../settings/LocalSettingsStore.js';
import type { RuntimeHost } from '../../host/RuntimeHost.js';

const { autoUpdater } = electronUpdaterPkg;

/** Misma clave que documenta docs/MANUAL.md (ajuste "Buscar actualizaciones automáticamente"). Vive
 *  local a este módulo — el registro central de claves de settings (packages/shared/src/settingsKeys.ts)
 *  queda fuera de la zona de esta tarea; nada impide moverla ahí más adelante. */
const UPDATES_AUTO_SETTINGS_KEY = 'updates.auto';

export interface StartAutoUpdaterOptions {
  /** Se pasa el `RuntimeHost` ya armado (apps/desktop/src/main/host/RuntimeHost.ts) para enterarse de
   *  runs activos vía `onRunEvent` y así no interrumpir uno con el diálogo de reinicio (punto 2 del
   *  encargo). Opcional: sin `host`, el aviso se muestra apenas termina de descargar. */
  host?: RuntimeHost;
}

/** Arranca el chequeo/descarga/aviso de actualizaciones. No hace nada si `shouldStartAutoUpdater`
 *  decide que no corresponde (no empaquetado, `SAURIO_NO_UPDATE=1`, o ajuste `updates.auto: false`). */
export function startAutoUpdater(options: StartAutoUpdaterOptions = {}): AutoUpdaterService | undefined {
  const devFeedUrl = process.env['SAURIO_UPDATE_DEV_FEED'];
  const userDataDir = app.getPath('userData');
  const settingsStore = new LocalSettingsStore(path.join(userDataDir, 'settings.local.json'));

  if (
    !shouldStartAutoUpdater({
      isPackaged: app.isPackaged,
      devFeedUrl,
      noUpdateEnv: process.env['SAURIO_NO_UPDATE'],
      settingsAuto: settingsStore.get(UPDATES_AUTO_SETTINGS_KEY),
    })
  ) {
    return undefined;
  }

  if (devFeedUrl) {
    // Punto 4 del encargo ("prueba local de punta a punta... provider generic vía variable de entorno
    // de desarrollo"): SAURIO_UPDATE_DEV_FEED apunta a un server HTTP estático local con su propio
    // latest.yml, en vez del feed real de GitHub Releases. `forceDevUpdateConfig` es necesario porque
    // sin empaquetar, electron-updater por defecto ni siquiera intenta chequear (ver
    // shouldStartAutoUpdater, que ya exige `devFeedUrl` para entrar acá sin `isPackaged`).
    autoUpdater.setFeedURL({ provider: 'generic', url: devFeedUrl });
    autoUpdater.forceDevUpdateConfig = true;
  }

  const log = createFileLogger(path.join(userDataDir, 'logs', 'updater.log'));
  const tracker = new ActiveRunTracker(() => service.retryPendingNotification());
  const service = new AutoUpdaterService({
    autoUpdater,
    dialog,
    log,
    hasActiveRun: () => tracker.hasActiveRun(),
  });

  if (options.host) {
    tracker.attach((cb) => options.host!.onRunEvent(cb));
  }

  log(`arrancando (isPackaged=${app.isPackaged}, devFeedUrl=${devFeedUrl ?? '(ninguno)'})`);
  service.start();
  return service;
}
