// Test de AutoUpdaterService: flujo update-available → update-downloaded → diálogo, error de red
// silencioso, y postergar/reintentar el aviso por un run activo (punto 2 del encargo). Sin mockear
// 'electron' ni 'electron-updater' — ver comentario de cabecera de AutoUpdaterService.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoUpdaterService, type DialogLike, type MinimalAutoUpdater, type UpdateInfoLike } from './AutoUpdaterService.js';

interface FakeAutoUpdaterEvents {
  error: Error;
  'update-available': UpdateInfoLike;
  'update-downloaded': UpdateInfoLike;
}

type FakeAutoUpdater = MinimalAutoUpdater & {
  emit<E extends keyof FakeAutoUpdaterEvents>(event: E, arg: FakeAutoUpdaterEvents[E]): void;
};

function createFakeAutoUpdater(): FakeAutoUpdater {
  const handlers: Record<string, ((arg: any) => void)[]> = { error: [], 'update-available': [], 'update-downloaded': [] };
  const fake: FakeAutoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    on(event: string, listener: (arg: any) => void) {
      handlers[event]?.push(listener);
      return fake;
    },
    emit(event, arg) {
      for (const h of handlers[event] ?? []) h(arg);
    },
  };
  return fake;
}

function createFakeDialog(response: number) {
  const showMessageBox = vi.fn().mockResolvedValue({ response });
  const dialog: DialogLike = { showMessageBox };
  return dialog as DialogLike & { showMessageBox: typeof showMessageBox };
}

describe('AutoUpdaterService', () => {
  let log: (line: string) => void;

  beforeEach(() => {
    log = vi.fn<(line: string) => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() activa autoDownload/autoInstallOnAppQuit y chequea de una', () => {
    const autoUpdater = createFakeAutoUpdater();
    const service = new AutoUpdaterService({ autoUpdater, dialog: createFakeDialog(1), log });

    service.start();

    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('update-available solo loguea, no muestra diálogo', () => {
    const autoUpdater = createFakeAutoUpdater();
    const dialog = createFakeDialog(1);
    const service = new AutoUpdaterService({ autoUpdater, dialog, log });
    service.start();

    autoUpdater.emit('update-available', { version: '0.2.0' });

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('0.2.0'));
  });

  it('update-downloaded muestra el diálogo con la versión y los botones esperados', async () => {
    const autoUpdater = createFakeAutoUpdater();
    const dialog = createFakeDialog(1);
    const service = new AutoUpdaterService({ autoUpdater, dialog, log });
    service.start();

    autoUpdater.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledTimes(1));

    const options = dialog.showMessageBox.mock.calls[0]?.[0];
    expect(options?.message).toContain('0.2.0');
    expect(options?.buttons).toEqual(['Reiniciar ahora', 'Más tarde']);
  });

  it('elegir "Reiniciar ahora" (response 0) llama quitAndInstall', async () => {
    const autoUpdater = createFakeAutoUpdater();
    const dialog = createFakeDialog(0);
    const service = new AutoUpdaterService({ autoUpdater, dialog, log });
    service.start();

    autoUpdater.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1));
  });

  it('elegir "Más tarde" (response 1) NO llama quitAndInstall (se instala solo al salir)', async () => {
    const autoUpdater = createFakeAutoUpdater();
    const dialog = createFakeDialog(1);
    const service = new AutoUpdaterService({ autoUpdater, dialog, log });
    service.start();

    autoUpdater.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledTimes(1));
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('un error de red se loguea y NUNCA muestra un diálogo', () => {
    const autoUpdater = createFakeAutoUpdater();
    const dialog = createFakeDialog(1);
    const service = new AutoUpdaterService({ autoUpdater, dialog, log });
    service.start();

    autoUpdater.emit('error', new Error('ENOTFOUND api.github.com'));

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOTFOUND'));
  });

  it('con un run activo, pospone el diálogo hasta que termina', async () => {
    const autoUpdater = createFakeAutoUpdater();
    const dialog = createFakeDialog(1);
    let activeRun = true;
    const service = new AutoUpdaterService({ autoUpdater, dialog, log, hasActiveRun: () => activeRun });
    service.start();

    autoUpdater.emit('update-downloaded', { version: '0.2.0' });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pospuesto'));

    activeRun = false;
    service.retryPendingNotification();
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledTimes(1));
  });

  it('sin hasActiveRun, muestra el diálogo enseguida ("si no, solo avisá")', async () => {
    const autoUpdater = createFakeAutoUpdater();
    const dialog = createFakeDialog(1);
    const service = new AutoUpdaterService({ autoUpdater, dialog, log });
    service.start();

    autoUpdater.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledTimes(1));
  });

  it('no vuelve a mostrar el diálogo dos veces para la misma versión', async () => {
    const autoUpdater = createFakeAutoUpdater();
    const dialog = createFakeDialog(1);
    const service = new AutoUpdaterService({ autoUpdater, dialog, log });
    service.start();

    autoUpdater.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalledTimes(1));
    autoUpdater.emit('update-downloaded', { version: '0.2.0' });
    service.retryPendingNotification();

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('chequea de nuevo cada checkIntervalMs (6 horas por defecto)', () => {
    vi.useFakeTimers();
    const autoUpdater = createFakeAutoUpdater();
    const service = new AutoUpdaterService({ autoUpdater, dialog: createFakeDialog(1), log, checkIntervalMs: 1000 });
    service.start();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(2000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(4);
  });

  it('stop() detiene el intervalo', () => {
    vi.useFakeTimers();
    const autoUpdater = createFakeAutoUpdater();
    const service = new AutoUpdaterService({ autoUpdater, dialog: createFakeDialog(1), log, checkIntervalMs: 1000 });
    service.start();
    service.stop();

    vi.advanceTimersByTime(5000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});
