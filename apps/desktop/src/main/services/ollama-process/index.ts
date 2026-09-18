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

export interface EnsureRunningResult {
  running: boolean;
  startedByApp: boolean;
  /** Código estable para que la UI decida el copy, no un mensaje para mostrar directo:
   *  'ollama_not_installed' | 'timeout_starting' | texto crudo de un error de SO al spawnear. */
  error?: string;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const START_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;
const LOG_FILE_NAME = 'ollama-serve.log';
/** Nombre real del log de la app de bandeja oficial de Ollama en Windows [COMPROBADO EN EQUIPO,
 *  ver doc 16 §12.2 nota de esta tarea] — carpeta `%LOCALAPPDATA%\Ollama\server.log`. */
const ATTACH_LOG_RELATIVE_PATH = ['Ollama', 'server.log'];

export interface OllamaProcessManagerOptions {
  baseUrl?: string;
  /** Inyectable para tests: evita spawnear un proceso real. */
  spawnFn?: typeof spawn;
  /** Inyectable para tests: evita depender de que `ollama` esté instalado en la máquina que corre vitest. */
  execFileFn?: typeof execFile;
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
}

export class OllamaProcessManager {
  private readonly baseUrl: string;
  private readonly spawnFn: typeof spawn;
  private readonly execFileFn: typeof execFile;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logsDir: string | undefined;
  private readonly createLogStream: (path: string) => WriteStream;
  private readonly readFileFn: typeof readFile;
  /** Coalesce: si `ensureRunning()` se llama varias veces en paralelo (arranque de la app + el
   *  usuario clickeando "Iniciar Ollama" a la vez), todas esperan la misma corrida en vez de
   *  spawnear dos procesos `ollama serve` a la vez. */
  private inFlight: Promise<EnsureRunningResult> | undefined;
  /** Solo se completa cuando ESTA clase arrancó el proceso — nunca el PID de una instancia ajena
   *  (ver `stop()`, punto 4 del encargo: "detené SOLO el Ollama que la app inició"). */
  private child: ChildProcess | undefined;
  private ownLogPath: string | undefined;

  constructor(opts: OllamaProcessManagerOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.execFileFn = opts.execFileFn ?? execFile;
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
    this.logsDir = opts.logsDir;
    this.createLogStream = opts.createLogStream ?? ((p) => createWriteStream(p, { flags: 'a' }));
    this.readFileFn = opts.readFileFn ?? readFile;
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

    const binary = await this.resolveBinaryPath();
    if (!binary) return { running: false, startedByApp: false, error: 'ollama_not_installed' };

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

      const child = this.spawnFn(binary, ['serve'], {
        detached: true,
        windowsHide: true,
        stdio: logStream ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      });
      if (logStream) {
        child.stdout?.on('data', (chunk: Buffer) => logStream.write(chunk));
        child.stderr?.on('data', (chunk: Buffer) => logStream.write(chunk));
        this.ownLogPath = logPath;
      }
      // Guardamos la referencia SOLO porque nosotros lo arrancamos — `stop()` la usa para detener
      // exactamente este proceso al cerrar la app (punto 4: "detené SOLO el Ollama que la app
      // inició"), nunca una instancia ajena (esta clase nunca guarda el PID de nada que no haya
      // arrancado ella misma). `unref()` sigue dejando que el proceso principal salga sin esperar a
      // este hijo — no lo desactiva `stop()`, que sigue pudiendo matarlo explícitamente antes de salir.
      this.child = child;
      child.unref();
      child.on('error', () => { /* superficie por el timeout de abajo (health nunca pasa) */ });
      child.on('exit', () => { this.child = undefined; });
    } catch (err) {
      return { running: false, startedByApp: false, error: err instanceof Error ? err.message : String(err) };
    }

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.checkHealth(1000)) return { running: true, startedByApp: true };
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return { running: false, startedByApp: true, error: 'timeout_starting' };
  }

  /** Tarea "carga de modelo/oom_load" punto 4: detiene SOLO el proceso que ESTA clase arrancó. Si
   *  Ollama ya estaba corriendo antes de que la app arrancara (o lo arrancó el usuario a mano/otra
   *  app/la app de bandeja), `this.child` es `undefined` y este método no hace nada — sigue
   *  cumpliendo "nunca matar instancias ajenas" tal como documentaba la versión anterior de este
   *  archivo, ahora de forma explícita en vez de "no guardar el PID de nadie". Se llama desde
   *  `app.on('before-quit', ...)` en `main/index.ts`. */
  stop(): void {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch (err) {
      console.warn('[OllamaProcessManager] no se pudo detener el ollama serve que arrancó esta app', err);
    }
    this.child = undefined;
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
