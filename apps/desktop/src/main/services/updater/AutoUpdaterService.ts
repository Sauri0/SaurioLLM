// AutoUpdaterService — apps/desktop/src/main/services/updater/AutoUpdaterService.ts.
// Núcleo del punto 2 del encargo, deliberadamente sin importar 'electron' ni 'electron-updater': recibe
// TODO lo que toca esas dependencias por parámetro (interfaces mínimas `MinimalAutoUpdater`/
// `DialogLike`, más abajo), para poder testear el flujo entero (update-available → downloaded →
// diálogo; error de red; postergado por run activo) sin mockear módulos nativos. El único lugar que
// construye una instancia real es `./index.ts` (la fábrica `startAutoUpdater`, que sí importa Electron
// y electron-updater de verdad).
//
// NOTA DE FIRMA (documentada también en docs/INSTALAR.md): esta app no está firmada digitalmente.
// electron-updater verifica la integridad del artefacto descargado contra el `sha512` que trae
// `latest.yml` (generado por electron-builder en el build, ver electron-builder.yml) — eso confirma que
// el .exe descargado es exactamente el que se publicó, pero NO es una firma de editor: Windows no
// reconoce ninguna identidad verificada detrás del binario (mismo SmartScreen que ya documenta
// docs/INSTALAR.md para la instalación manual).

export interface UpdateInfoLike {
  version: string;
}

/** Subconjunto de `AppUpdater` (electron-updater) que este servicio necesita — evita depender del tipo
 *  completo de la librería en la firma pública, y hace trivial fabricar un fake en los tests. */
export interface MinimalAutoUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'update-available', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown;
  checkForUpdates(): unknown;
  quitAndInstall(): void;
}

export interface MessageBoxResult {
  response: number;
}

/** Subconjunto de `Electron.Dialog` — un solo método, con la firma mínima que usa este servicio. */
export interface DialogLike {
  showMessageBox(options: {
    type: 'info';
    title: string;
    message: string;
    detail?: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
  }): Promise<MessageBoxResult>;
}

export interface AutoUpdaterServiceOptions {
  autoUpdater: MinimalAutoUpdater;
  dialog: DialogLike;
  log: (line: string) => void;
  /** Punto 2 del encargo ("nunca interrumpir un run activo"): si no se pasa, el servicio nunca
   *  pospone — muestra el diálogo apenas termina de descargar (el "si no, solo avisá" del encargo). */
  hasActiveRun?: () => boolean;
  /** Default 6 horas (punto 2 del encargo: "al iniciar y cada 6 horas"). */
  checkIntervalMs?: number;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const RESTART_NOW_INDEX = 0;
const LATER_INDEX = 1;

/** Botones "Reiniciar ahora" / "Más tarde" (punto 2 del encargo, texto verbatim del encargo). */
const DIALOG_BUTTONS = ['Reiniciar ahora', 'Más tarde'];

export class AutoUpdaterService {
  private readonly autoUpdater: MinimalAutoUpdater;
  private readonly dialog: DialogLike;
  private readonly log: (line: string) => void;
  private readonly hasActiveRun: (() => boolean) | undefined;
  private readonly checkIntervalMs: number;

  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  /** Versión descargada pendiente de mostrar el diálogo (postergada por un run activo). */
  private pendingVersion: string | undefined;
  private dialogShownForVersion: string | undefined;

  constructor(options: AutoUpdaterServiceOptions) {
    this.autoUpdater = options.autoUpdater;
    this.dialog = options.dialog;
    this.log = options.log;
    this.hasActiveRun = options.hasActiveRun;
    this.checkIntervalMs = options.checkIntervalMs ?? SIX_HOURS_MS;
  }

  /** Engancha los listeners, dispara el primer chequeo y arranca el intervalo de 6 horas. Idempotente
   *  en el sentido de que llamarlo dos veces solo duplica listeners/intervalos — `./index.ts` lo llama
   *  una única vez por proceso. */
  start(): void {
    this.autoUpdater.autoDownload = true;
    this.autoUpdater.autoInstallOnAppQuit = true;

    this.autoUpdater.on('error', (error) => {
      // Punto 2 del encargo: "errores de red silenciosos con log a archivo" — nunca un diálogo, nunca
      // una excepción sin atrapar (electron-updater no garantiza que 'error' tenga siempre listener,
      // pero acá SIEMPRE lo tiene desde este punto en adelante).
      this.log(`error de actualización (silencioso para el usuario): ${error.message}`);
    });

    this.autoUpdater.on('update-available', (info) => {
      this.log(`actualización disponible: ${info.version} (descargando en segundo plano)`);
    });

    this.autoUpdater.on('update-downloaded', (info) => {
      this.log(`actualización descargada: ${info.version}`);
      this.pendingVersion = info.version;
      this.maybeShowDialog();
    });

    this.checkNow();
    this.intervalHandle = setInterval(() => this.checkNow(), this.checkIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  checkNow(): void {
    try {
      const result = this.autoUpdater.checkForUpdates();
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch((error: unknown) => {
          this.log(`checkForUpdates() rechazada (silencioso para el usuario): ${String(error)}`);
        });
      }
    } catch (error) {
      this.log(`checkForUpdates() lanzó de forma síncrona (silencioso para el usuario): ${String(error)}`);
    }
  }

  /** Se llama tanto al terminar una descarga como cuando `ActiveRunTracker` avisa que el último run
   *  activo terminó (ver ./index.ts) — reintenta mostrar un aviso que se había postergado. */
  retryPendingNotification(): void {
    this.maybeShowDialog();
  }

  private maybeShowDialog(): void {
    const version = this.pendingVersion;
    if (!version) return;
    if (this.dialogShownForVersion === version) return; // ya se mostró para esta versión
    if (this.hasActiveRun?.()) {
      this.log(`aviso de actualización ${version} pospuesto: hay un run activo`);
      return;
    }
    this.dialogShownForVersion = version;
    void this.showUpdateDialog(version);
  }

  private async showUpdateDialog(version: string): Promise<void> {
    const result = await this.dialog.showMessageBox({
      type: 'info',
      title: 'SaurioLLM',
      message: `Hay una versión nueva (${version}) lista.`,
      detail: 'Se instala sola al cerrar la app si elegís "Más tarde".',
      buttons: DIALOG_BUTTONS,
      defaultId: RESTART_NOW_INDEX,
      cancelId: LATER_INDEX,
    });
    if (result.response === RESTART_NOW_INDEX) {
      this.log(`usuario eligió reiniciar ahora para instalar ${version}`);
      this.autoUpdater.quitAndInstall();
    } else {
      this.log(`usuario eligió "más tarde" para ${version}; se instala al salir (autoInstallOnAppQuit)`);
    }
  }
}
