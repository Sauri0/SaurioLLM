// TerminalService: envuelve node-pty y expone su salida por MessagePort (doc 02 §1, ADR-010, doc 01
// §4.10). Terminal interactiva del usuario, independiente de `run_command` (que en packages/runtime
// usa child_process.spawn sin pty). pwsh por defecto, fallback powershell (doc 01 §5, tabla de
// procesos; N:\saurio-smoke\RESULTADOS-electron.md: "pwsh 7 NO está instalado en esta máquina").
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import * as pty from 'node-pty';

export interface TerminalSpawnOptions {
  cwd: string;
  shell?: string;
  cols?: number;
  rows?: number;
}

/** Factory inyectable: en producción es `pty.spawn`; los tests pasan un fake para no depender de
 *  un shell real instalado en la máquina que corre `vitest`. */
export type PtySpawnFn = (shell: string, args: string[], options: pty.IPtyForkOptions) => pty.IPty;

const defaultPtySpawn: PtySpawnFn = (shell, args, options) => pty.spawn(shell, args, options);

/** true si `cmd` resuelve a un ejecutable en PATH. Windows: `where`; POSIX: `command -v`. */
export function commandExists(cmd: string, execSync: typeof execFileSync = execFileSync): boolean {
  try {
    if (process.platform === 'win32') {
      execSync('where', [cmd], { stdio: 'ignore' });
    } else {
      execSync('command', ['-v', cmd], { stdio: 'ignore', shell: '/bin/sh' } as never);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resuelve el shell a lanzar: el que pida `preferred`, si no en Windows intenta `pwsh.exe` y cae a
 * `powershell.exe` (medido en esta máquina: pwsh 7 no está instalado), y en POSIX usa `$SHELL` o `bash`.
 */
export function resolveShell(preferred: string | undefined, exists: (cmd: string) => boolean = commandExists): string {
  if (preferred) return preferred;
  if (process.platform === 'win32') {
    return exists('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
  }
  return process.env['SHELL'] ?? 'bash';
}

interface TerminalSession {
  readonly id: string;
  readonly proc: pty.IPty;
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(private readonly spawnPty: PtySpawnFn = defaultPtySpawn) {}

  /** Crea una sesión de terminal; `onData` recibe cada chunk de salida (para reenviar por MessagePort),
   *  `onExit` se llama una vez cuando el proceso termina. */
  create(
    id: string,
    options: TerminalSpawnOptions,
    onData: (chunk: string) => void,
    onExit: (exitCode: number) => void,
  ): void {
    if (this.sessions.has(id)) {
      throw new Error(`saurio: ya existe una sesión de terminal con id "${id}"`);
    }
    const shell = resolveShell(options.shell);
    const proc = this.spawnPty(shell, [], {
      name: 'xterm-color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd,
      env: process.env as Record<string, string>,
    });
    proc.onData(onData);
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      onExit(exitCode);
    });
    this.sessions.set(id, { id, proc });
  }

  write(id: string, data: string): void {
    this.getSession(id).proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.getSession(id).proc.resize(cols, rows);
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.proc.kill();
    this.sessions.delete(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Cierra todas las sesiones abiertas (apagado de la app). */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private getSession(id: string): TerminalSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`saurio: no existe una sesión de terminal con id "${id}"`);
    return session;
  }
}

/** Genera un id de terminal razonablemente único sin depender de `crypto.randomUUID` en tests. */
export function generateTerminalId(): string {
  return `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const hostPlatform = os.platform();
