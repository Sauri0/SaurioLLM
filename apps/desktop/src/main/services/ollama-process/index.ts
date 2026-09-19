// OllamaProcessManager — PRIORIDAD CERO punto 1 (bloqueo real reportado por el usuario tras instalar
// v0.1: "Ollama instalado pero apagado" — la app no lo detectaba ni lo arrancaba sola, dejando al
// usuario sin ninguna forma de usar la app sin abrir una terminal a mano). Reemplaza el placeholder
// v0.3 de este archivo: se adelanta a esta pasada porque es un bloqueo de uso básico, no una mejora.
//
// Alcance deliberadamente chico: detecta si Ollama ya responde en loopback; si no, busca el
// ejecutable (PATH primero, carpeta de instalación por defecto de Windows después) y lo arranca
// oculto (`windowsHide`, sin consola visible, doc "arranque transparente"), sin polling agresivo:
// una sola ventana de espera con reintento corto. Nunca mata ni reinicia una instancia que esta
// clase no arrancó (no guarda PID de nada ajeno) — ver `stop()`.
//
// Tarea "carga de modelo/oom_load", punto 4: captura stdout/stderr del `ollama serve` que ESTA
// clase arranca en `userData/logs/ollama-serve.log` (`logsDir`, inyectado por el host), y expone
// `readInferenceComputeLine()` para que `HardwareProbe` (packages/runtime/src/models, doc 16 §12.2,
// puerto `OllamaInferenceComputeSource` ya soportado ahí) pueda leer la línea real
// `msg="inference compute"` que `ollama serve` loguea por dispositivo detectado — sin ese log, la
// iGPU/VRAM de equipos sin `nvidia-smi` queda invisible (doc 16 §12.2, hallazgo real de un usuario
// con Intel Arc). En modo "attach" (Ollama arrancado por fuera de la app — típicamente la app de
// bandeja oficial de Windows) se lee en SOLO LECTURA `%LOCALAPPDATA%\Ollama\server.log`, nunca se
// escribe ahí.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileHidden } from '../process/spawnHidden.js';

export interface EnsureRunningResult {
  running: boolean;
  startedByApp: boolean;
  /** Código estable para que la UI decida el copy, no un mensaje para mostrar directo:
   *  'ollama_not_installed' | 'external_unavailable' | 'timeout_starting' |
   *  'spawn_failed:<detalle SO>' | 'process_exited:<código>'. */
  error?: string;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
// El primer arranque del portable en Windows puede incluir detección de hardware y antivirus. El
// manual ya declara hasta ~30 s; el manager debe conceder esa misma ventana antes de matar su child.
const START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const LOG_FILE_NAME = 'ollama-serve.log';
/** Nombre real del log de la app de bandeja oficial de Ollama en Windows [COMPROBADO EN EQUIPO,
 *  ver doc 16 §12.2 nota de esta tarea] — carpeta `%LOCALAPPDATA%\Ollama\server.log`. */
const ATTACH_LOG_RELATIVE_PATH = ['Ollama', 'server.log'];

export interface OllamaProcessManagerOptions {
  baseUrl?: string;
  /** En modo administrado no se busca ni se ejecuta el Ollama global del usuario. */
  binaryPath?: () => string | undefined;
  processEnv?: NodeJS.ProcessEnv;
  /** Sólo comprueba el endpoint configurado. Nunca busca ni arranca un proceso local. */
  attachOnly?: boolean;
  /** Inyectable para tests: evita spawnear un proceso real. */
  spawnFn?: typeof spawn;
  /** Inyectable para tests: evita depender de que `ollama` esté instalado en la máquina que corre vitest. */
  execFileFn?: typeof execFile;
  /** Inyectable para probar la terminación del árbol sin ejecutar `taskkill` real. */
  execFileHiddenFn?: typeof execFileHidden;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** `hostAdapter.paths.logsDir` (userData/logs) — si se provee, el stdout/stderr del `ollama serve`
   *  que ESTA clase arranca se agrega (append) a `ollama-serve.log` ahí. Sin esto, el comportamiento
   *  es el previo (stdio ignorado). */
  logsDir?: string;
  /** Inyectable para tests: reemplaza `fs.createWriteStream`. */
  createLogStream?: (path: string) => WriteStream;
  /** Inyectable para tests: reemplaza `fs/promises.readFile`. */
  readFileFn?: typeof readFile;
  /** Inyectables para tests del ciclo de vida; producción conserva los tiempos documentados. */
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  stopTimeoutMs?: number;
}

export interface OllamaProcessConfiguration {
  baseUrl: string;
  binaryPath?: () => string | undefined;
  processEnv?: NodeJS.ProcessEnv;
  attachOnly?: boolean;
}

export class OllamaProcessManager {
  private baseUrl: string;
  private binaryPath?: () => string | undefined;
  private processEnv?: NodeJS.ProcessEnv;
  private attachOnly: boolean;
  private readonly spawnFn: typeof spawn;
  private readonly execFileFn: typeof execFile;
  private readonly execFileHiddenFn: typeof execFileHidden;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logsDir: string | undefined;
  private readonly createLogStream: (path: string) => WriteStream;
  private readonly readFileFn: typeof readFile;
  private readonly startTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly stopTimeoutMs: number;
  /** Coalesce: si `ensureRunning()` se llama varias veces en paralelo (arranque de la app + el
   *  usuario clickeando "Iniciar Ollama" a la vez), todas esperan la misma corrida en vez de
   *  spawnear dos procesos `ollama serve` a la vez. */
  private inFlight: Promise<EnsureRunningResult> | undefined;
  /** Solo se completa cuando ESTA clase arrancó el proceso — nunca el PID de una instancia ajena
   *  (ver `stop()`, punto 4 del encargo: "detené SOLO el Ollama que la app inició"). */
  private child: ChildProcess | undefined;
  private stopInFlight: { child: ChildProcess; promise: Promise<boolean> } | undefined;
  private ownLogPath: string | undefined;
  private childLogCleanup: (() => void) | undefined;

  constructor(opts: OllamaProcessManagerOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.binaryPath = opts.binaryPath;
    this.processEnv = opts.processEnv;
    this.attachOnly = opts.attachOnly ?? false;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.execFileFn = opts.execFileFn ?? execFile;
    this.execFileHiddenFn = opts.execFileHiddenFn ?? execFileHidden;
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
    this.logsDir = opts.logsDir;
    this.createLogStream = opts.createLogStream ?? ((p) => createWriteStream(p, { flags: 'a' }));
    this.readFileFn = opts.readFileFn ?? readFile;
    this.startTimeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 5000;
  }

  /** Snapshot reversible de la configuración activa. Las funciones y el entorno se conservan por
   *  referencia para que el coordinador pueda restaurarlos si falla un cambio de motor. */
  configuration(): OllamaProcessConfiguration {
    return {
      baseUrl: this.baseUrl,
      binaryPath: this.binaryPath,
      processEnv: this.processEnv,
      attachOnly: this.attachOnly,
    };
  }

  /** `true` si `GET /api/version` responde 2xx dentro de `timeoutMs` — mismo endpoint que
   *  `OllamaProvider.health()` (packages/runtime), pero implementado acá sin depender de ese paquete
   *  (este archivo es apps/desktop puro, sin runtime real inyectado en todos los tests de main). */
  async checkHealth(timeoutMs = 1500): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private resolveOnPath(): Promise<boolean> {
    return new Promise((resolve) => {
      this.execFileFn('ollama', ['--version'], { windowsHide: true, timeout: 3000 }, (err) => resolve(!err));
    });
  }

  /** PATH primero (`ollama --version`); si no, la carpeta de instalación por defecto del instalador
   *  oficial de Windows (`%LOCALAPPDATA%\Programs\Ollama\ollama.exe`, dato del encargo). `undefined`
   *  si no se encuentra en ninguno de los dos lugares — la UI lo lleva al asistente de instalación
   *  (OnboardingWizard, ya existente), nunca instala nada acá. */
  async resolveBinaryPath(): Promise<string | undefined> {
    if (this.binaryPath) return this.binaryPath();
    if (await this.resolveOnPath()) return 'ollama';
    if (this.platform === 'win32') {
      const localAppData = this.env['LOCALAPPDATA'];
      if (localAppData) {
        const candidate = path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe');
        if (existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  }

  /** Idempotente: si ya responde, no hace nada. Si no, busca el binario y lo arranca oculto en
   *  loopback (`ollama serve` no toma `--host` acá a propósito: hereda el bind por defecto de Ollama,
   *  que ya es loopback salvo que el usuario haya configurado `OLLAMA_HOST` distinto — no se fuerza
   *  nada). Devuelve apenas el health check pasa o tras `START_TIMEOUT_MS` sin respuesta. */
  async ensureRunning(): Promise<EnsureRunningResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doEnsureRunning();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async doEnsureRunning(): Promise<EnsureRunningResult> {
    if (await this.checkHealth()) return { running: true, startedByApp: false };

    if (this.attachOnly) {
      return { running: false, startedByApp: false, error: 'external_unavailable' };
    }

    const binary = await this.resolveBinaryPath();
    if (!binary) return { running: false, startedByApp: false, error: 'ollama_not_installed' };

    let startupFailure: { error: string; startedByApp: boolean } | undefined;
    try {
      // Tarea "carga de modelo/oom_load" punto 4: si hay `logsDir`, se captura stdout/stderr en
      // `ollama-serve.log` (append — no se pisa entre arranques) en vez de `stdio: 'ignore'`. Sin
      // `logsDir` (tests, o el host todavía no lo pasó), el comportamiento es el previo.
      let logStream: WriteStream | undefined;
      let logPath: string | undefined;
      if (this.logsDir) {
        try {
          mkdirSync(this.logsDir, { recursive: true });
          logPath = path.join(this.logsDir, LOG_FILE_NAME);
          logStream = this.createLogStream(logPath);
        } catch (err) {
          console.warn('[OllamaProcessManager] no se pudo abrir el log de ollama serve; sigue sin capturar stdout/stderr', err);
        }
      }

      let child: ChildProcess;
      try {
        child = this.spawnFn(binary, ['serve'], {
          detached: true,
          windowsHide: true,
          env: this.processEnv ?? this.env,
          // El portable trae binarios auxiliares junto a ollama.exe. Electron puede heredar un cwd
          // arbitrario (por ejemplo System32 al abrir desde un acceso directo); para una ruta
          // absoluta administrada, el directorio del ejecutable es el contexto determinista.
          cwd: path.isAbsolute(binary) ? path.dirname(binary) : undefined,
          stdio: logStream ? ['ignore', 'pipe', 'pipe'] : 'ignore',
        });
      } catch (err) {
        if (logStream) this.endLogStream(logStream);
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`spawn_failed:${detail}`, { cause: err });
      }
      if (logStream) {
        const onStdout = (chunk: Buffer) => logStream.write(chunk);
        const onStderr = (chunk: Buffer) => logStream.write(chunk);
        child.stdout?.on('data', onStdout);
        child.stderr?.on('data', onStderr);
        this.childLogCleanup = () => {
          child.stdout?.off('data', onStdout);
          child.stderr?.off('data', onStderr);
          this.endLogStream(logStream);
        };
        this.ownLogPath = logPath;
      }
      // Guardamos la referencia SOLO porque nosotros lo arrancamos — `stop()` la usa para detener
      // exactamente este proceso al cerrar la app (punto 4: "detené SOLO el Ollama que la app
      // inició"), nunca una instancia ajena (esta clase nunca guarda el PID de nada que no haya
      // arrancado ella misma). `unref()` sigue dejando que el proceso principal salga sin esperar a
      // este hijo — no lo desactiva `stop()`, que sigue pudiendo matarlo explícitamente antes de salir.
      this.child = child;
      child.unref();
      child.once('error', (error) => {
        startupFailure ??= { error: `spawn_failed:${error.message}`, startedByApp: false };
      });
      child.on('exit', (code, signal) => {
        const detail = code === null ? `signal=${signal ?? 'unknown'}` : String(code);
        startupFailure ??= { error: `process_exited:${detail}`, startedByApp: true };
        if (this.child === child) {
          this.child = undefined;
          this.closeChildLog();
        }
      });
    } catch (err) {
      return { running: false, startedByApp: false, error: err instanceof Error ? err.message : String(err) };
    }

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (startupFailure && !startupFailure.startedByApp) {
        this.child = undefined;
        this.closeChildLog();
        return { running: false, ...startupFailure };
      }
      if (await this.checkHealth(1000)) return { running: true, startedByApp: true };
      if (startupFailure) {
        return { running: false, ...startupFailure };
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    if (startupFailure) return { running: false, ...startupFailure };
    const timedOutChild = this.child;
    if (timedOutChild) await this.stopOwnedChildAndWait(timedOutChild);
    return { running: false, startedByApp: true, error: 'timeout_starting' };
  }

  private endLogStream(stream: WriteStream): void {
    const maybeEnd = (stream as WriteStream & { end?: () => void }).end;
    if (typeof maybeEnd === 'function') maybeEnd.call(stream);
  }

  private closeChildLog(): void {
    const cleanup = this.childLogCleanup;
    this.childLogCleanup = undefined;
    cleanup?.();
  }

  private stopOwnedChildAndWait(child: ChildProcess): Promise<boolean> {
    if (this.stopInFlight?.child === child) return this.stopInFlight.promise;
    const promise = this.doStopOwnedChildAndWait(child).finally(() => {
      if (this.stopInFlight?.child === child) this.stopInFlight = undefined;
    });
    this.stopInFlight = { child, promise };
    return promise;
  }

  private async doStopOwnedChildAndWait(child: ChildProcess): Promise<boolean> {
    if (this.child !== child) return true;
    if (child.exitCode !== null && child.exitCode !== undefined) {
      this.child = undefined;
      this.closeChildLog();
      return true;
    }
    let timeout: NodeJS.Timeout | undefined;
    let onExit: (() => void) | undefined;
    const exited = new Promise<boolean>((resolve) => {
      onExit = () => {
        if (timeout) clearTimeout(timeout);
        resolve(true);
      };
      child.once('exit', onExit);
      timeout = setTimeout(() => resolve(false), this.stopTimeoutMs);
    });
    // El proceso puede salir naturalmente entre el chequeo de `exitCode` y la instalación del
    // listener. En ese caso no invocamos taskkill ni fabricamos un error de cierre.
    if (child.exitCode !== null && child.exitCode !== undefined) onExit?.();
    this.closeChildLog();
    let terminationError: unknown;
    try {
      if (child.exitCode === null || child.exitCode === undefined) {
        if (this.platform === 'win32') {
          const pid = child.pid;
          if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) {
            throw new Error('El proceso propio de Ollama no informó un PID válido.');
          }
          // `/T` incluye únicamente los descendientes del PID que esta instancia spawneó. No se
          // enumera por nombre, puerto ni ejecutable, así que una instalación ajena queda intacta.
          await this.execFileHiddenFn(
            'taskkill.exe',
            ['/PID', String(pid), '/T', '/F'],
            { timeout: this.stopTimeoutMs },
          );
        } else {
          child.kill();
        }
      }
    } catch (err) {
      terminationError = err;
    }
    const didExit = await exited;
    if (onExit) child.off('exit', onExit);
    if (timeout) clearTimeout(timeout);
    if (didExit || (child.exitCode !== null && child.exitCode !== undefined)) {
      if (this.child === child) this.child = undefined;
      return true;
    }
    console.warn(
      '[OllamaProcessManager] no se pudo detener el árbol de ollama serve que arrancó esta app',
      terminationError ?? new Error(`El proceso no terminó en ${this.stopTimeoutMs} ms.`),
    );
    // Se conserva la referencia: configure()/stop() pueden reintentar exactamente este árbol.
    return false;
  }

  /** Tarea "carga de modelo/oom_load" punto 4: detiene SOLO el proceso que ESTA clase arrancó. Si
   *  Ollama ya estaba corriendo antes de que la app arrancara (o lo arrancó el usuario a mano/otra
   *  app/la app de bandeja), `this.child` es `undefined` y este método no hace nada — sigue
   *  cumpliendo "nunca matar instancias ajenas" tal como documentaba la versión anterior de este
   *  archivo, ahora de forma explícita en vez de "no guardar el PID de nadie". Se llama desde
   *  `app.on('before-quit', ...)` en `main/index.ts`. */
  async stop(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    if (!(await this.stopOwnedChildAndWait(child))) {
      throw new Error('El motor local todavía está cerrando. Reintentá en unos segundos.');
    }
  }

  /** El llamador comprueba que no hay runs/descargas antes de cambiar de motor. */
  async configure(
    baseUrl: string,
    binaryPath?: () => string | undefined,
    processEnv?: NodeJS.ProcessEnv,
    attachOnly = false,
  ): Promise<void> {
    if (this.inFlight) throw new Error('Esperá a que termine el arranque del motor antes de cambiarlo.');
    const previous = this.child;
    if (previous && !(await this.stopOwnedChildAndWait(previous))) {
      throw new Error('El motor anterior todavía está cerrando. Reintentá en unos segundos.');
    }
    this.ownLogPath = undefined;
    this.baseUrl = baseUrl;
    this.binaryPath = binaryPath;
    this.processEnv = processEnv;
    this.attachOnly = attachOnly;
  }

  /** Tarea "carga de modelo/oom_load" punto 4: la línea real `msg="inference compute"` que
   *  `ollama serve` loguea por dispositivo detectado (doc 16 §12.2, `HardwareProbe.
   *  parseOllamaInferenceComputeLog`, packages/runtime/src/models — puerto `OllamaInferenceComputeSource`
   *  ya soportado ahí, este método es la implementación real que faltaba cablear). Busca primero en
   *  el log propio (si esta clase arrancó Ollama con `logsDir`); si no hay nada ahí, en modo attach
   *  intenta `%LOCALAPPDATA%\Ollama\server.log` en SOLO LECTURA (nunca se escribe). `undefined` si
   *  ninguna de las dos fuentes tiene la línea — nunca inventa un valor. */
  async readInferenceComputeLine(): Promise<string | undefined> {
    if (this.ownLogPath) {
      const line = await this.readLastInferenceComputeLine(this.ownLogPath);
      if (line) return line;
    }
    if (this.platform === 'win32') {
      const localAppData = this.env['LOCALAPPDATA'];
      if (localAppData) {
        const attachLogPath = path.join(localAppData, ...ATTACH_LOG_RELATIVE_PATH);
        const line = await this.readLastInferenceComputeLine(attachLogPath);
        if (line) return line;
      }
    }
    return undefined;
  }

  private async readLastInferenceComputeLine(filePath: string): Promise<string | undefined> {
    try {
      const text = await this.readFileFn(filePath, 'utf8');
      return extractLastInferenceComputeLine(text);
    } catch {
      return undefined; // el archivo puede no existir todavía, o no ser legible — no es un error.
    }
  }
}

/** Busca la ÚLTIMA línea que contiene `msg="inference compute"` en el texto de un log — "última"
 *  porque `ollama serve` puede loguearla una vez por dispositivo y por cada carga de modelo; la más
 *  reciente es la que refleja el estado actual del equipo. Función pura, exportada para test. */
export function extractLastInferenceComputeLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && line.includes('msg="inference compute"')) return line;
  }
  return undefined;
}
