// Bootstrap del proceso main (doc 02 §1: apps/desktop/src/main/index.ts, doc 01 §5 "Seguridad de Electron").
// app.setName('SaurioLLM') va ANTES de cualquier app.getPath('userData') (doc 02 §6.1), para que
// %APPDATA%\SaurioLLM sea siempre la carpeta de datos del usuario, sin depender de cómo se corra la app.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, MessageChannelMain, Notification, session, safeStorage } from 'electron';
import { ipcContract } from '@saurio/shared';
import { allowFrame, observeResponses, registerHandler } from './ipc/registerHandler.js';
import { registerAppHandlers } from './ipc/app.js';
import { registerProjectHandlers } from './ipc/project.js';
import { registerAgentsHandlers } from './ipc/agents.js';
import { registerChatHandlers } from './ipc/chat.js';
import { registerRunHandlers } from './ipc/run.js';
import { registerPermissionHandlers } from './ipc/permission.js';
import { registerCheckpointHandlers } from './ipc/checkpoint.js';
import { registerModelsHandlers, type LibraryUpdateEmitter } from './ipc/models.js';
import { registerProvidersHandlers } from './ipc/providers.js';
import { registerMetricsHandlers } from './ipc/metrics.js';
import { registerSettingsHandlers } from './ipc/settings.js';
import { registerBenchHandlers } from './ipc/bench.js';
import { registerOllamaHandlers } from './ipc/ollama.js';
import { registerEngineHandlers } from './ipc/engine.js';
import { ManagedOllamaInstaller, MANAGED_OLLAMA_URL } from './services/ollama-process/ManagedOllamaInstaller.js';
import { OllamaProcessManager } from './services/ollama-process/index.js';
import { registerTerminalHandlers, type TerminalPortOpener } from './ipc/terminal.js';
import { registerFilesHandlers, closeAllFileWatchers, type FilesChangeEmitter } from './ipc/files.js';
import { RuntimeHost, type HostAdapter } from './host/RuntimeHost.js';
import { createGlobalRuntime } from './host/createRuntime.js';
import { RunEventBatcher } from './host/RunEventBatcher.js';
import { LocalSettingsStore } from './services/settings/LocalSettingsStore.js';
import { SecureKeyStore } from './services/providers/SecureKeyStore.js';
import { TerminalService } from './services/terminal/index.js';
import { SystemSampler } from './services/system-sampler/index.js';
import { SqlMetricsMinuteRepository } from './services/metrics/SqlMetricsMinuteRepository.js';
import { MetricsTicker } from './services/metrics/MetricsTicker.js';
import { createSmokeRecorder, isSmokeRun } from './smoke.js';
import { startAutoUpdater } from './services/updater/index.js';
import { createSafeShutdownController, createShutdown, type SafeShutdownController } from './host/shutdown.js';

app.setName('SaurioLLM');

/**
 * BUG REAL (usuario real, notebook Windows 11 sin NVIDIA, v0.2.0): al cerrar la app aparecía el
 * diálogo nativo de Electron "A JavaScript error occurred in the main process" con el `TypeError`
 * real de abajo (ver ./host/shutdown.ts para la causa raíz de orden de apagado). Ese diálogo lo
 * muestra el listener de `uncaughtException` que Electron registra POR SU CUENTA al arrancar
 * (`@electron/internal/browser/init`); para poder decidir nosotros qué pasa con un error durante el
 * cierre hay que reemplazar ese listener por uno propio (si solo agregáramos el nuestro, el de
 * Electron seguiría corriendo también y el diálogo aparecería igual).
 *
 * Con el orden de apagado ya arreglado (./host/shutdown.ts) este handler no debería tener nada que
 * atrapar durante un cierre normal — queda como red de seguridad ("nunca mostrar el diálogo nativo al
 * cerrar", punto 1 del encargo) para cualquier otro error inesperado que aparezca en ese momento.
 * Fuera del cierre, se seguía necesitando alguna señal de que algo salió mal: se muestra el mismo
 * diálogo pero armado por nosotros (mismo criterio que Electron, sin depender de su listener interno).
 */
let isQuitting = false;
let safeShutdownController: SafeShutdownController | undefined;
app.on('before-quit', (event) => {
  if (!safeShutdownController) {
    isQuitting = true;
    return;
  }
  safeShutdownController.handleBeforeQuit(event);
});

process.removeAllListeners('uncaughtException');
process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException', error);
  if (isQuitting) {
    return; // apagado en curso: nunca el diálogo nativo — ya quedó logueado arriba.
  }
  try {
    dialog.showErrorBox('SaurioLLM: error interno', `Ocurrió un error inesperado.\n\n${error.stack ?? error.message}`);
  } catch {
    // dialog puede no estar disponible todavía (antes de app.whenReady()); ya se logueó arriba.
  }
});

/**
 * SAURIO_USER_DATA=<carpeta>: fuerza `userData` a una carpeta aislada, ANTES de cualquier
 * `app.getPath('userData')` (tiene que llamarse antes de `app.whenReady()`, doc Electron
 * `app.setPath`). Existe para que los smokes (`SAURIO_SMOKE_UI=1`, `SAURIO_SMOKE=1`) no compartan
 * `%APPDATA%\SaurioLLM` con una instancia real que el usuario tenga abierta — sin esto, el
 * single-instance lock de Electron (mismo `userData`) hace que la segunda instancia se cierre sola
 * sin dibujar nada, dando `rootHtmlLength=0` aunque el código esté bien.
 */
if (process.env['SAURIO_USER_DATA']) {
  app.setPath('userData', process.env['SAURIO_USER_DATA']);
}

/**
 * HALLAZGO (N:\saurio-smoke\RESULTADOS-electron.md): en esta máquina la virtualización de GPU de
 * Electron 44 falla (ContextResult::kFatalFailure) y el renderer muere sin
 * `app.disableHardwareAcceleration()`. La mitigación se activa por defecto (antes solo corría con
 * SAURIO_SMOKE=1) para que un usuario con el mismo problema pueda probar la app igual; se desactiva
 * con el setting `app.gpuMitigationDisabled` (persistido en settings.local.json vía LocalSettingsStore,
 * ver host/RuntimeHost.ts) para no perjudicar a un usuario con GPU funcional que la note innecesaria.
 * También se puede desactivar por sesión con la variable de entorno `SAURIO_GPU=1` (equivalente
 * efímero al setting, sin tocar settings.local.json; útil para probar si la GPU de un equipo
 * concreto funciona sin la mitigación).
 */
function shouldApplyGpuMitigation(): boolean {
  if (process.env['SAURIO_SMOKE'] === '1') return true;
  if (process.env['SAURIO_GPU'] === '1') return false;
  const store = new LocalSettingsStore(path.join(app.getPath('userData'), 'settings.local.json'));
  const disabled = store.get('app.gpuMitigationDisabled');
  return disabled !== true;
}

if (shouldApplyGpuMitigation()) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('in-process-gpu');
}

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

const DEFAULT_WINDOW_STATE: WindowState = { width: 1280, height: 800 };

function windowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/** Persistencia manual de estado de ventana (bounds); Electron 44 no expone una API nativa para esto. */
function loadWindowState(): WindowState {
  try {
    const raw = readFileSync(windowStatePath(), 'utf-8');
    return { ...DEFAULT_WINDOW_STATE, ...(JSON.parse(raw) as Partial<WindowState>) };
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
}

function saveWindowState(win: BrowserWindow): void {
  const bounds = win.getBounds();
  try {
    writeFileSync(windowStatePath(), JSON.stringify(bounds satisfies WindowState));
  } catch (error) {
    console.error('[main] no se pudo guardar window-state.json', error);
  }
}

function createHostAdapter(): HostAdapter {
  const userDataDir = app.getPath('userData');
  return {
    paths: {
      userDataDir,
      dbPath: path.join(userDataDir, 'saurio.db'),
      blobsDir: path.join(userDataDir, 'blobs'),
      toolOutputsDir: path.join(userDataDir, 'tool-outputs'),
      logsDir: path.join(userDataDir, 'logs'),
      cacheDir: path.join(userDataDir, 'cache'),
      repoMapCacheDir: path.join(userDataDir, 'cache', 'repo-map'),
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    },
    async showOpenDirectoryDialog(options) {
      const result = await dialog.showOpenDialog({
        title: options?.title,
        defaultPath: options?.defaultPath,
        properties: ['openDirectory'],
      });
      return { canceled: result.canceled, path: result.filePaths[0] };
    },
    notify({ title, body }) {
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    },
  };
}

function createMainWindow(): BrowserWindow {
  const state = loadWindowState();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    // Tamaño mínimo de ventana (pasada de diseño): por debajo de esto el layout de 3 columnas
    // (sidebar 220px + panel derecho 380px) no tiene espacio útil para el centro de chat.
    minWidth: 960,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.on('close', (event) => {
    saveWindowState(win);
    // Al cerrar con la X todavía no hubo `before-quit`: conservar la ventana mientras se consulta
    // por runs activos evita que "Seguir trabajando" deje un proceso sin interfaz.
    if (safeShutdownController && !safeShutdownController.isFinalizing()) {
      event.preventDefault();
      void safeShutdownController.requestQuit();
    }
  });

  if (process.env['SAURIO_SMOKE'] === '1') {
    win.webContents.on('did-finish-load', () => console.log('[main][smoke] did-finish-load'));
    win.webContents.on('did-fail-load', (_e, code, desc) => console.log('[main][smoke] did-fail-load', code, desc));
    win.webContents.on('render-process-gone', (_e, details) => console.log('[main][smoke] render-process-gone', JSON.stringify(details)));
    win.webContents.on('console-message', (_e, level, message, line, sourceId) =>
      console.log('[renderer][smoke]', level, message, `${sourceId}:${line}`),
    );
    win.webContents.on('preload-error', (_e, preloadPath, error) =>
      console.log('[main][smoke] preload-error', preloadPath, error),
    );
    win.once('ready-to-show', () => console.log('[main][smoke] ready-to-show'));
  } else {
    // Integración (HALLAZGO GPU, ver arriba): sin SAURIO_SMOKE también queremos saber si el renderer
    // se muere en la máquina de un usuario real, para poder diagnosticarlo desde logs/main.log.
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[main] render-process-gone', JSON.stringify(details));
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[main] did-fail-load', code, desc);
    });
  }

  // Diagnóstico de renderer en desarrollo (no empaquetado): reenvía console.log/warn/error del
  // renderer (incluidas violaciones de CSP, que Chromium reporta como console-message 'error') a
  // stdout del main, para poder diagnosticar una ventana en blanco sin DevTools. Solo !app.isPackaged
  // para no filtrar nada a producción.
  if (!app.isPackaged && process.env['SAURIO_SMOKE'] !== '1') {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log('[renderer][dev]', level, message, `${sourceId}:${line}`);
    });
  }

  allowFrame(win.webContents.mainFrame);

  // SAURIO_SMOKE=1: se agrega ?smoke=1 para que App.tsx dispare 'app:ping' solo, sin intervención
  // manual (el smoke test de verificación del scaffolding necesita que el ping salga del renderer).
  // SAURIO_SMOKE_STATE=<json>: herramienta de verificación visual (pasada de diseño UI) — se agrega
  // ?demoState=<json> para que el renderer (demo/demoState.ts) siembre proyecto/chat/mensajes/tarjetas
  // de ejemplo en los stores de zustand sin depender de Ollama ni del runtime real.
  const query: Record<string, string> = {};
  if (process.env['SAURIO_SMOKE'] === '1') query['smoke'] = '1';
  const smokeState = process.env['SAURIO_SMOKE_STATE'];
  if (smokeState) query['demoState'] = smokeState;
  const hasQuery = Object.keys(query).length > 0;

  if (process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL']);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: hasQuery ? query : undefined });
  }

  return win;
}

/**
 * CSP script-src 'self', sin eval ni scripts remotos (doc 01 §5) — en producción.
 *
 * En dev (`electron-vite dev`, con ELECTRON_RENDERER_URL apuntando al servidor de Vite) el renderer
 * se sirve desde http://localhost:5173 y @vitejs/plugin-react inyecta su preámbulo de React Refresh
 * como script INLINE: con `script-src 'self'` a secas el navegador lo bloquea y la app muere con
 * "@vitejs/plugin-react can't detect preamble" [COMPROBADO EN EQUIPO durante la integración del MVP].
 * Solo en ese caso se agregan 'unsafe-inline' y el origen del dev server; el build empaquetado
 * (sin ELECTRON_RENDERER_URL) conserva la política estricta del doc 01 §5.
 */
function applyContentSecurityPolicy(): void {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  const policy = rendererUrl
    ? [`script-src 'self' 'unsafe-inline' 'unsafe-eval' ${new URL(rendererUrl).origin}`]
    : ["script-src 'self'"];

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': policy,
      },
    });
  });
}

/**
 * Canal de prueba 'app:ping' (packages/shared/src/ipc.ts). El cierre automático con SAURIO_SMOKE=1
 * ya no vive acá: lo maneja el recorder de ./smoke.ts, que espera a que respondan TODOS los canales
 * verificados ('app:ping' y 'models:list') antes de cerrar la app.
 */
/** Punto 5 del encargo (doc 16): `out/` (dentro de `app.getAppPath()`) es escribible en dev, pero
 *  una vez empaquetada la app vive dentro de `app.asar` (solo lectura) — escribir ahí tira
 *  `EROFS`/`ENOENT` en silencio y los smokes (`smoke-*.json`, capturas relativas) nunca aparecen.
 *  Se resuelve, en orden: `SAURIO_USER_DATA` (si está seteada, para no depender de dónde corra el
 *  proceso — mismo criterio que ya aísla `userData` para estas corridas), `app.getPath('userData')`
 *  cuando la app está empaquetada (siempre escribible, no está dentro del asar), o `out/` sin cambios
 *  en dev/sin empaquetar (comportamiento previo). */
function smokeOutDir(): string {
  const userDataOverride = process.env['SAURIO_USER_DATA'];
  if (userDataOverride) return userDataOverride;
  if (app.isPackaged) return app.getPath('userData');
  return path.join(app.getAppPath(), 'out');
}

function registerPingHandler(): void {
  registerHandler('app:ping', ipcContract['app:ping'], () => ({
    pong: true as const,
    receivedAt: Date.now(),
    versions: {
      node: process.versions.node,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    },
  }));
}

/** Con SAURIO_SMOKE=1: escribe smoke-app-ping.json y smoke-models-list.json (en `smokeOutDir()`,
 *  ver arriba) a medida que esos canales responden, y cierra la app sola cuando ya respondieron
 *  los dos. */
function installSmokeRecorder(): void {
  if (!isSmokeRun()) return;
  const recorder = createSmokeRecorder(smokeOutDir(), ['app:ping', 'models:list'], () => {
    console.log('[main][smoke] todos los canales verificados respondieron; cerrando');
    setTimeout(() => app.quit(), 50);
  });
  observeResponses((channel, output) => recorder.record(channel, output));
}

/** Con SAURIO_SMOKE_UI=1: espera a que cargue la página y da un margen para que React monte y los
 *  efectos async (IPC) se asienten, lee `document.getElementById('root').innerHTML.length` en el
 *  renderer y lo escribe en `smoke-ui.json` (en `smokeOutDir()`, ver arriba) antes de cerrar la app.
 *  Sirve para verificar de forma automatizada que la UI se dibuja de verdad (root con contenido) en
 *  vez de quedar en blanco, tanto en `pnpm dev` como sobre el build empaquetado. */
function installUiSmokeCheck(win: BrowserWindow): void {
  if (process.env['SAURIO_SMOKE_UI'] !== '1') return;
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void win.webContents
        .executeJavaScript('document.getElementById("root") ? document.getElementById("root").innerHTML.length : -1')
        .then((rootHtmlLength: number) => {
          const outPath = path.join(smokeOutDir(), 'smoke-ui.json');
          writeFileSync(outPath, JSON.stringify({ rootHtmlLength, checkedAt: Date.now() }));
          console.log('[main][smoke-ui] rootHtmlLength=', rootHtmlLength, '->', outPath);
        })
        .catch((error) => {
          console.error('[main][smoke-ui] executeJavaScript falló', error);
        })
        .finally(() => {
          setTimeout(() => app.quit(), 50);
        });
    }, 1500);
  });
}

/** Herramienta de verificación visual de la pasada de diseño UI: con SAURIO_SMOKE_SHOT=<ruta.png>,
 *  espera a que cargue la página y da el mismo margen que installUiSmokeCheck (1500 ms, para que
 *  React monte, los estilos apliquen y — en modo demo — se siembren los stores), captura la ventana
 *  con `webContents.capturePage()` y guarda el PNG en esa ruta antes de cerrar la app sola. No
 *  depende de SAURIO_SMOKE ni de SAURIO_SMOKE_UI: puede usarse solo, o junto con SAURIO_SMOKE_STATE
 *  para capturar la UI con contenido de ejemplo sin necesitar Ollama corriendo. */
function installSmokeShot(win: BrowserWindow): void {
  const shotPath = process.env['SAURIO_SMOKE_SHOT'];
  if (!shotPath) return;
  // SAURIO_SMOKE_CLICK=<selector CSS>[|<selector CSS>...]: hace click en cada selector, en orden,
  // antes de capturar (p. ej. '[title="Modelos"]|text=Explorar' para abrir una sub-pestaña anidada).
  // `scroll=<selector>` hace scrollIntoView en vez de click (para llegar a una sección larga del
  // panel, p. ej. `scroll=#saurio-settings-providers`) — agregado en esta tarea para poder capturar
  // Ajustes > Proveedores sin depender de la altura de la ventana. Solo para verificación visual
  // manual; nunca se usa en el flujo normal de la app.
  const clickSelectors = process.env['SAURIO_SMOKE_CLICK']?.split('|') ?? [];
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      let clickThenCapture = Promise.resolve();
      for (const selector of clickSelectors) {
        clickThenCapture = clickThenCapture
          .then(() => win.webContents.executeJavaScript(
            selector.startsWith('text=')
              ? `[...document.querySelectorAll('button,div[role="tab"]')].find(e => e.textContent?.trim() === ${JSON.stringify(selector.slice(5))})?.click()`
              : selector.startsWith('scroll=')
                ? `document.querySelector(${JSON.stringify(selector.slice(7))})?.scrollIntoView()`
                : `document.querySelector(${JSON.stringify(selector)})?.click()`,
          ))
          .then(() => new Promise((resolve) => setTimeout(resolve, 300)));
      }
      void clickThenCapture.then(() => win.webContents.capturePage())
        .then((image) => {
          const outPath = path.isAbsolute(shotPath) ? shotPath : path.join(smokeOutDir(), shotPath);
          writeFileSync(outPath, image.toPNG());
          console.log('[main][smoke-shot] captura guardada ->', outPath);
        })
        .catch((error) => {
          console.error('[main][smoke-shot] capturePage falló', error);
        })
        .finally(() => {
          setTimeout(() => app.quit(), 50);
        });
    }, 1500);
  });
}

/** Abre un MessagePortMain por terminal (doc 04 §16, PreloadApi.onTerminalPort) y lo transfiere al
 *  renderer con `webContents.postMessage('terminal:port', { terminalId }, [port1])`. */
function createTerminalPortOpener(win: BrowserWindow): TerminalPortOpener {
  return {
    openPort(terminalId) {
      const { port1, port2 } = new MessageChannelMain();
      win.webContents.postMessage('terminal:port', { terminalId }, [port2]);
      port1.start();
      return {
        onData(cb) {
          port1.on('message', (event) => cb(event.data as string));
        },
        postData(chunk) {
          port1.postMessage(chunk);
        },
        close() {
          port1.close();
        },
      };
    },
  };
}

app.whenReady().then(async () => {
  applyContentSecurityPolicy();
  installSmokeRecorder();
  registerPingHandler();
  registerAppHandlers();

  const hostAdapter = createHostAdapter();
  const engineSettings = new LocalSettingsStore(path.join(hostAdapter.paths.userDataDir, 'settings.local.json'));
  const engineInstaller = new ManagedOllamaInstaller(hostAdapter.paths.userDataDir);
  const managedEngine = !process.env['SAURIO_OLLAMA_URL'] && engineSettings.get('engine.mode') === 'managed';
  const engineUrl = managedEngine ? MANAGED_OLLAMA_URL : process.env['SAURIO_OLLAMA_URL'];
  const engineExecutable = engineInstaller.executablePath();

  // Tarea "carga de modelo/oom_load" punto 4: se crea ANTES de `createGlobalRuntime` (antes vivía
  // más abajo, junto a `registerOllamaHandlers`) para poder pasarle `readInferenceComputeLine()` a
  // `HardwareProbe` como `inferenceComputeSource` (doc 16 §12.2, puerto ya soportado ahí pero nunca
  // cableado en la app real). `logsDir` captura el stdout/stderr real de `ollama serve` cuando ESTA
  // clase lo arranca (`userData/logs/ollama-serve.log`); `SAURIO_OLLAMA_URL` (punto 5, solo pruebas)
  // apunta el health-check a un puerto vacío para simular "apagado" sin tocar Ollama real.
  const ollamaProcessManager = new OllamaProcessManager({
    baseUrl: engineUrl,
    attachOnly: Boolean(process.env['SAURIO_OLLAMA_URL']),
    binaryPath: managedEngine ? () => engineExecutable : undefined,
    processEnv: managedEngine ? { ...process.env, OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_MODELS: engineInstaller.modelsDir,
      OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1' } : undefined,
    logsDir: hostAdapter.paths.logsDir,
  });

  // Integración del MVP: se construyen las instancias reales (saurio.db + migraciones, gateway con
  // OllamaProvider, ModelManager, telemetría) y se le inyectan al host. Si la base no abre (disco
  // lleno, esquema más nuevo — doc 10 §5), la app arranca igual con los canales registrados y el
  // error se muestra en consola, en vez de morir antes de crear la ventana.
  let runtime: ReturnType<typeof createGlobalRuntime> | undefined;
  try {
    // Punto 1 del encargo ("almacén seguro de claves en main con Electron safeStorage"): `safeStorage`
    // solo se importa acá (único lugar con Electron real, doc 02 §1 ADR-002 — createRuntime.ts recibe
    // la instancia ya armada para que createRuntime.test.ts siga sin depender de Electron).
    const secureKeyStore = new SecureKeyStore(path.join(hostAdapter.paths.userDataDir, 'provider-keys.enc.json'), safeStorage);
    runtime = createGlobalRuntime(hostAdapter, {
      ollamaBaseUrl: engineUrl,
      managedModelsFolder: managedEngine ? engineInstaller.modelsDir : undefined,
      secureKeyStore,
      inferenceComputeSource: { read: () => ollamaProcessManager.readInferenceComputeLine() },
    });
  } catch (error) {
    console.error('[main] no se pudo inicializar el runtime (persistencia/gateway)', error);
  }

  const host = new RuntimeHost(hostAdapter, { runtime, defaultWorkingDir: app.getPath('home'), onProjectChanged: closeAllFileWatchers });
  let recovered;
  try {
    recovered = await host.init();
  } catch (error) {
    console.error('[main] falló la inicialización del runtime (migraciones/recover)', error);
  }
  if (recovered && (recovered.orphaned.length > 0 || recovered.abandoned.length > 0)) {
    console.log(
      `[main] recover(): ${recovered.orphaned.length} tool call(s) huérfanas, ${recovered.abandoned.length} abandonadas`,
    );
  }

  registerProjectHandlers(host);
  registerAgentsHandlers(host);
  registerChatHandlers(host);
  registerRunHandlers(host);
  registerPermissionHandlers(host);
  registerCheckpointHandlers(host);
  registerProvidersHandlers(host);
  registerSettingsHandlers(host);
  registerBenchHandlers(host);

  // PRIORIDAD CERO punto 1/7 (bloqueo real: "Ollama instalado pero apagado" — la app no lo detectaba
  // ni lo arrancaba sola). `ollamaProcessManager` ya se construyó más arriba (para poder pasarle
  // `inferenceComputeSource` a `createGlobalRuntime`); acá se registra el canal y se dispara el
  // arranque automático. El canal queda registrado ANTES de saber si el arranque automático tuvo
  // éxito (la UI puede reintentar manualmente con el mismo canal). El arranque automático en sí es
  // "fire and forget": no bloquea la creación de la ventana ni el resto del arranque — puede tardar
  // hasta 15s (OllamaProcessManager.ensureRunning) y el usuario no debería esperar eso a pantalla
  // negra; `layout/StatusBar.tsx` muestra "Iniciando motor local…" mientras tanto (poll propio).
  //
  // Tarea "carga de modelo/oom_load" punto 5: con `SAURIO_OLLAMA_URL` seteada (simulación de
  // "apagado" apuntando a un puerto vacío, solo para pruebas) el arranque automático se salta a
  // propósito — si no, `checkHealth()` fallaría contra el puerto falso y `ensureRunning()` intentaría
  // encontrar y arrancar un `ollama serve` REAL (bind al puerto real de Ollama, ignorando la URL de
  // prueba), justo lo que esta variable existe para evitar.
  registerOllamaHandlers(ollamaProcessManager);
  registerEngineHandlers(engineInstaller, ollamaProcessManager, host.settings, runtime);
  if (process.env['SAURIO_OLLAMA_URL']) {
    console.log('[main] SAURIO_OLLAMA_URL seteada: se salta el arranque automático de ollama serve (simulación de "apagado")');
  } else {
    void ollamaProcessManager.ensureRunning().then(
      (result) => console.log('[main] ollama:ensureRunning (automático al arrancar)', result),
      (error) => console.error('[main] ollama:ensureRunning (automático al arrancar) falló', error),
    );
  }
  const terminalService = new TerminalService();

  const win = createMainWindow();
  installUiSmokeCheck(win);
  installSmokeShot(win);

  const systemSampler = new SystemSampler();
  const minuteRepo = runtime ? new SqlMetricsMinuteRepository(runtime.persistence.driver) : undefined;
  minuteRepo?.pruneOlderThan30Days(); // doc 14 §5: retención de 30 días, una vez al arrancar
  const metricsTicker = new MetricsTicker(systemSampler, host, minuteRepo, (snapshot) => {
    if (!win.isDestroyed()) win.webContents.send('metrics:tick', snapshot);
  });
  registerMetricsHandlers(host, systemSampler, metricsTicker);
  const eventBatcher = new RunEventBatcher((events) => {
    if (!win.isDestroyed()) win.webContents.send('runtime:event', events);
  });
  win.on('closed', () => eventBatcher.dispose());
  host.onRunEvent((event) => eventBatcher.push(event));

  // `terminal:create` arranca en la raíz del proyecto abierto (doc 02 §1); si todavía no se abrió
  // ninguno, en el home del usuario.
  registerTerminalHandlers(terminalService, createTerminalPortOpener(win), () => host.activeProjectRoot ?? app.getPath('home'));

  const filesEmitter: FilesChangeEmitter = {
    emit(event) {
      if (!win.isDestroyed()) win.webContents.send('files:changed', event);
    },
  };
  registerFilesHandlers(host, filesEmitter);

  // Stale-while-revalidate de "Explorar" (doc 16 §16.5): `OllamaLibraryClient` es Node puro
  // (packages/runtime) y no conoce `BrowserWindow`; recién acá, con `win` ya creada, se reenvía al
  // renderer la sincronización que terminó en segundo plano (mismo patrón que `filesEmitter` arriba).
  // `registerModelsHandlers` se llama recién acá (no en el bloque de arriba junto al resto de los
  // `register*Handlers`) precisamente porque necesita `win` para poder pasarle este emitter.
  const libraryUpdateEmitter: LibraryUpdateEmitter = {
    emitUpdated(result) {
      if (!win.isDestroyed()) win.webContents.send('models:libraryUpdated', result);
    },
    emitFailed(message) {
      if (!win.isDestroyed()) win.webContents.send('models:libraryUpdateFailed', { error: message });
    },
  };
  registerModelsHandlers(host, libraryUpdateEmitter);

  // Punto 3 del encargo ("modelo descargado que no aparece"): al terminar una descarga (evento
  // 'done') hay que invalidar la caché de `ModelManager.listInstalled()` (compartida por
  // models:list/catalog/libraryCatalog — ver ipc/models.ts) y avisarle al renderer con
  // `models:changed`, para que `modelsStore` (sidebar, cabecera del chat, pantalla de inicio) y la
  // pestaña "Instalados" (que además escucha este mismo evento, ver ModelsPanel.tsx) se actualicen
  // solos, sin reiniciar la app. Se resuelve ANTES de reenviar 'download:done' al renderer para que,
  // si algún panel vuelve a pedir el catálogo en reacción a ese evento, la caché ya esté fresca.
  async function broadcastModelsChanged(): Promise<void> {
    if (!runtime) return;
    try {
      const installed = await runtime.modelManager.listInstalled(true);
      const loaded = await runtime.modelManager.listLoaded().catch(() => []);
      if (!win.isDestroyed()) win.webContents.send('models:changed', { installed, loaded });
    } catch (error) {
      console.error('[main] no se pudo refrescar models:list tras una descarga', error);
    }
  }

  // download:progress/done/failed (doc 13 §5, punto 1 del encargo): DownloadManager es Node puro
  // (packages/runtime) y no conoce BrowserWindow; recién acá, con `win` ya creada, se reenvían sus
  // eventos al renderer (mismo patrón que `filesEmitter` arriba).
  const unsubscribeDownloads = host.onDownloadEvent({
    onProgress: (job) => { if (!win.isDestroyed()) win.webContents.send('download:progress', job); },
    onDone: (job) => {
      void broadcastModelsChanged().finally(() => {
        if (!win.isDestroyed()) win.webContents.send('download:done', job);
      });
    },
    onFailed: (job) => { if (!win.isDestroyed()) win.webContents.send('download:failed', job); },
  });
  win.on('closed', () => unsubscribeDownloads());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  // Apagado único, ordenado e idempotente (bug real v0.2.0: diálogo nativo "The database connection
  // is not open" al cerrar — ver ./host/shutdown.ts para la causa raíz y el orden correcto). Se
  // registra acá, al final del arranque, porque recién acá existen todas las piezas a apagar — pero
  // el ORDEN de apagado real lo decide `createShutdown`, no el orden de estas líneas.
  const finalizeShutdown = createShutdown({
    stopTickers: () => metricsTicker.dispose(),
    cleanupExtras: () => {
      terminalService.closeAll();
      closeAllFileWatchers();
      eventBatcher.dispose();
      unsubscribeDownloads();
    },
    closePersistence: () => host.dispose(),
    stopOwnOllama: async () => {
      engineInstaller.cancel();
      await ollamaProcessManager.stop();
    },
  });
  const showMessageBox = (options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> => {
    const owner = BrowserWindow.getFocusedWindow() ?? (win.isDestroyed() ? undefined : win);
    return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
  };
  safeShutdownController = createSafeShutdownController({
    listActiveRuns: () => host.listActiveRuns(),
    confirmActiveRuns: async (count) => {
      const result = await showMessageBox({
        type: 'warning',
        title: 'Hay trabajo en curso',
        message: count === 1 ? 'Hay una tarea activa.' : `Hay ${count} tareas activas.`,
        detail: 'Podés seguir trabajando o detener las tareas y cerrar cuando sus últimos eventos queden guardados.',
        buttons: ['Seguir trabajando', 'Detener y cerrar'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1 ? 'stop_and_quit' : 'continue_working';
    },
    cancelActiveRunsAndWait: () => host.cancelAllActiveRunsAndWait(),
    showShutdownError: async (error) => {
      console.error('[main] no se pudo completar el cierre seguro', error);
      const message = error instanceof Error ? error.message : String(error);
      const result = await showMessageBox({
        type: 'error',
        title: 'No se pudo cerrar de forma segura',
        message: 'SaurioLLM sigue abierto para no perder trabajo.',
        detail: `${message}\n\nPodés reintentar o seguir trabajando.`,
        buttons: ['Seguir trabajando', 'Reintentar'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1 ? 'retry' : 'continue_working';
    },
    finalize: finalizeShutdown,
    onFinalizing: () => { isQuitting = true; },
    // Segunda pasada: el controlador ya marcó `finalizing`, por lo que before-quit y close dejan
    // avanzar a Electron. electron-updater mantiene autoInstallOnAppQuit para el camino "Más tarde".
    resumeQuit: () => app.quit(),
  });

  // El actualizador se inicia después de instalar la puerta de cierre; su "Reiniciar ahora" queda
  // sujeto a la misma comprobación y, además, ActiveRunTracker ya posterga el aviso con runs activos.
  startAutoUpdater({ host });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
