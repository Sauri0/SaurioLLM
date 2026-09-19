// Tool builtin run_command(command, cwd?, timeout?) — packages/runtime/src/tools/builtin/run_command.ts.
// Define: doc 05 §2.8 punto 32 (spawn pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command,
// timeout 120s por defecto/600s configurable, salida en vivo por emit, kill de árbol con
// taskkill /PID <pid> /T /F) y CLAUDE.md/N:\saurio-smoke\RESULTADOS-electron.md (COMPROBADO: pwsh 7 NO
// está instalado en esta máquina — usar powershell.exe por defecto y pwsh.exe solo si existe) y doc 09
// §6 (CommandParser: patrones de instalación/migración/git destructivo para `classify`, heurística
// abierta, no exhaustiva).
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Risk } from '@saurio/shared';
import type { ToolClassification, ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';
import { execFileSyncHidden } from '../../util/spawnHidden.js';

const ArgsSchema = z.object({
  command: z.coerce.string().min(1),
  cwd: z.coerce.string().optional(),
  timeout: z.coerce.number().int().positive().optional(),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

const MAX_OUTPUT_CHARS = 30_000;
const HALF_KEEP = 15_000;

/** BUG REAL v0.2.0 ("ventanas de consola parpadeando al iniciar"): `where`/`taskkill` son ejecutables
 *  de consola en Windows — sin `windowsHide: true` abren una ventana visible un instante. Se usa el
 *  wrapper único del paquete (`execFileSyncHidden`) en vez de `execFileSync` directo. */
function commandExists(name: string): boolean {
  try {
    execFileSyncHidden(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let cachedShell: { exe: string; buildArgs: (cmd: string) => string[] } | undefined;

/** Feedback real v0.2.1, punto 6: "quitar códigos ANSI en origen" — `$PSStyle.OutputRendering` solo
 *  existe en PowerShell 7.2+ (pwsh.exe); asignarlo contra powershell.exe 5.1 (sin `$PSStyle`) rompería
 *  el comando, así que solo se antepone cuando de verdad se va a correr pwsh. */
const PWSH_PLAINTEXT_PREFIX = "$PSStyle.OutputRendering='PlainText';";

/** COMPROBADO EN EQUIPO (N:\saurio-smoke\RESULTADOS-electron.md): pwsh 7 no está instalado acá;
 *  usar powershell.exe por defecto y pwsh.exe solo si existe. bash en POSIX. Exportada (además de
 *  usarla `run_command` acá abajo) para que `agent/environmentPrompt.ts` describa el shell REAL en
 *  el system prompt (punto 3 del encargo) sin duplicar la detección de `pwsh`/`where`. */
export function resolveShell(): { exe: string; buildArgs: (cmd: string) => string[] } {
  if (cachedShell) return cachedShell;
  if (process.platform === 'win32') {
    const isPwsh = commandExists('pwsh');
    const exe = isPwsh ? 'pwsh.exe' : 'powershell.exe';
    cachedShell = {
      exe,
      buildArgs: (cmd) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', isPwsh ? `${PWSH_PLAINTEXT_PREFIX}${cmd}` : cmd],
    };
  } else {
    cachedShell = { exe: 'bash', buildArgs: (cmd) => ['-c', cmd] };
  }
  return cachedShell;
}

/** Red de seguridad además de NO_COLOR/TERM=dumb/$PSStyle (arriba): algunos programas emiten
 *  secuencias ANSI igual (no todos respetan esas convenciones). Regex estándar (equivalente al
 *  paquete `ansi-regex`) — feedback real v0.2.1, punto 6: "la salida de run_command llega con
 *  códigos ANSI ([32;1m...)". */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~])/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '');
}

/** Feedback real v0.2.1, punto 5: "si run_command cambia archivos dentro del workspace, no se inventa
 *  un checkpoint: se informa". `run_command` no puede detectar cambios con el mecanismo before/after
 *  de `checkpoint.ts` (no sabe de antemano qué paths va a tocar), así que usa `git status --porcelain`
 *  como evidencia barata y de solo lectura cuando el proyecto es un repo git; si no hay `.git` o `git`
 *  no está instalado, no hay forma barata de saberlo y se omite la nota (limitación documentada, no se
 *  inventa un escaneo recursivo del filesystem por costo). */
function gitStatusSnapshot(cwd: string): string | undefined {
  try {
    return execFileSyncHidden('git', ['status', '--porcelain'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } catch {
    return undefined;
  }
}

const INSTALL_PATTERN = /\b(npm|pnpm|yarn|pip|pip3|cargo|go)\s+(install|add|get)\b/i;
const MIGRATION_PATTERN = /\b(prisma\s+migrate|drizzle-kit|alembic)\b/i;
const GIT_DESTRUCTIVE_PATTERN = /\bgit\s+(reset\s+--hard|clean\s+-f|checkout\s+--)/i;
const DELETE_PATTERN = /\b(rm\s+-rf?|Remove-Item)\b/i;

/** Heurística abierta, no exhaustiva (doc 09 §6). */
export function classifyCommand(command: string): ToolClassification {
  if (GIT_DESTRUCTIVE_PATTERN.test(command)) {
    return { category: 'terminal', risk: 'high', summary: 'comando git destructivo', command };
  }
  if (DELETE_PATTERN.test(command)) {
    return { category: 'terminal', risk: 'high', summary: 'borrado por comando', command };
  }
  if (INSTALL_PATTERN.test(command)) {
    return { category: 'terminal', risk: 'medium', summary: 'instala/modifica dependencias (no reversible por checkpoint)', command };
  }
  if (MIGRATION_PATTERN.test(command)) {
    return { category: 'terminal', risk: 'medium', summary: 'migración de base de datos (no reversible por checkpoint)', command };
  }
  const risk: Risk = 'low';
  return { category: 'terminal', risk, summary: 'comando de terminal', command };
}

interface RunOutcome { exitCode: number | null; signal: NodeJS.Signals | null; text: string; timedOut: boolean; cancelled: boolean }

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try { execFileSyncHidden('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ya murió */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ya murió */ } }
  }
}

function spawnAndCollect(exe: string, args: string[], cwd: string, timeoutMs: number, signal: AbortSignal, onChunk: (text: string) => void): Promise<RunOutcome> {
  return new Promise((resolve) => {
    // Feedback real v0.2.1, punto 6: NO_COLOR/TERM=dumb en el entorno del hijo — convención que
    // respetan la mayoría de las CLIs modernas (npm, git, eslint, etc.) para no emitir ANSI. No es
    // suficiente por sí sola (algunos programas la ignoran), por eso además está `$PSStyle` en pwsh
    // (resolveShell) y el strip por regex más abajo (`stripAnsi`) como última red de seguridad.
    const child = spawn(exe, args, {
      cwd, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    let out = '';
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      if (child.pid) killTree(child.pid);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => { const t = stripAnsi(chunk.toString('utf8')); out += t; onChunk(t); });
    child.stderr.on('data', (chunk: Buffer) => { const t = stripAnsi(chunk.toString('utf8')); out += t; onChunk(t); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, signal: sig, text: out, timedOut, cancelled });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: null, signal: null, text: out + `\n[error al lanzar el proceso: ${err.message}]`, timedOut, cancelled });
    });
  });
}

function truncateHeadTail(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  const head = text.slice(0, HALF_KEEP);
  const tail = text.slice(text.length - HALF_KEEP);
  return { text: `${head}\n…[salida truncada, ${text.length} chars totales; usá read_output para el resto]…\n${tail}`, truncated: true };
}

export function createRunCommandTool(deps: BuiltinToolsDeps): ToolDefinition<Args> {
  return {
    name: 'run_command',
    description: 'Ejecuta un comando de shell en el workspace y devuelve su salida (stdout+stderr combinados).',
    inputSchema: z.toJSONSchema(ArgsSchema),
    argsSchema: ArgsSchema,
    category: 'terminal',
    mutating: true,
    idempotent: false,
    allowedInModes: ['agent'],
    source: { kind: 'builtin' },
    classify(args: Args) {
      return classifyCommand(args.command);
    },
    async handler(args: Args, ctx: ToolContext) {
      const shell = resolveShell();
      const cwd = args.cwd ? ctx.fs.resolve(args.cwd) : ctx.cwd;
      const timeoutMs = Math.min(args.timeout ?? deps.defaultCommandTimeoutMs, deps.maxCommandTimeoutMs);

      const gitStatusBefore = gitStatusSnapshot(cwd);
      const outcome = await spawnAndCollect(shell.exe, shell.buildArgs(args.command), cwd, timeoutMs, ctx.signal, (chunk) => {
        ctx.emit({ toolCallId: ctx.toolCallId, text: chunk });
      });
      const gitStatusAfter = gitStatusSnapshot(cwd);
      // Punto 5 del encargo: `run_command` es `mutating: true` pero nunca puebla `checkpoint.before/
      // after` (no sabe de antemano qué paths va a tocar) — RunController ya no crea un checkpoint
      // vacío para esto (agent/RunController.ts, gate por `checkpoint.files.length > 0`); acá se avisa
      // con evidencia real cuando hay repo git y el estado cambió, en vez de inventar un escaneo caro
      // del filesystem o quedarse callado.
      const possiblyChangedFiles = gitStatusBefore !== undefined && gitStatusAfter !== undefined && gitStatusBefore !== gitStatusAfter;

      let fullOutputPath: string | undefined;
      const { text: preview, truncated } = truncateHeadTail(outcome.text);
      if (truncated) {
        try {
          await mkdir(deps.toolOutputsDir, { recursive: true });
          fullOutputPath = path.join(deps.toolOutputsDir, `${ctx.toolCallId}.txt`);
          await writeFile(fullOutputPath, outcome.text, 'utf8');
        } catch (err) {
          ctx.log(err);
        }
      }

      const changedFilesNote = possiblyChangedFiles
        ? '\n[Nota: este comando cambió archivos dentro del workspace; el revert de checkpoints no lo cubre.]'
        : '';

      if (outcome.cancelled) {
        return { content: [{ type: 'text', text: `comando cancelado\n${preview}${changedFilesNote}` }], isError: true, truncated, fullOutputPath };
      }
      if (outcome.timedOut) {
        return { content: [{ type: 'text', text: `comando excedió el timeout de ${timeoutMs}ms y fue terminado\n${preview}${changedFilesNote}` }], isError: true, truncated, fullOutputPath };
      }
      const isError = outcome.exitCode !== 0;
      return {
        content: [{ type: 'text', text: `[exit ${outcome.exitCode ?? 'null'}]\n${preview}${changedFilesNote}` }],
        isError,
        truncated,
        fullOutputPath,
        structured: { exitCode: outcome.exitCode, signal: outcome.signal },
      };
    },
  };
}
