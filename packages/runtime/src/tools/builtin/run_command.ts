// Tool builtin run_command(command, cwd?, timeout?) — packages/runtime/src/tools/builtin/run_command.ts.
// Define: doc 05 §2.8 punto 32 (spawn pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command,
// timeout 120s por defecto/600s configurable, salida en vivo por emit, kill de árbol con
// taskkill /PID <pid> /T /F) y CLAUDE.md/N:\saurio-smoke\RESULTADOS-electron.md (COMPROBADO: pwsh 7 NO
// está instalado en esta máquina — usar powershell.exe por defecto y pwsh.exe solo si existe) y doc 09
// §6 (CommandParser: patrones de instalación/migración/git destructivo para `classify`, heurística
// abierta, no exhaustiva).
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Risk } from '@saurio/shared';
import type { ToolClassification, ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';

const ArgsSchema = z.object({
  command: z.coerce.string().min(1),
  cwd: z.coerce.string().optional(),
  timeout: z.coerce.number().int().positive().optional(),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

const MAX_OUTPUT_CHARS = 30_000;
const HALF_KEEP = 15_000;

function commandExists(name: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let cachedShell: { exe: string; buildArgs: (cmd: string) => string[] } | undefined;

/** COMPROBADO EN EQUIPO (N:\saurio-smoke\RESULTADOS-electron.md): pwsh 7 no está instalado acá;
 *  usar powershell.exe por defecto y pwsh.exe solo si existe. bash en POSIX. */
function resolveShell(): { exe: string; buildArgs: (cmd: string) => string[] } {
  if (cachedShell) return cachedShell;
  if (process.platform === 'win32') {
    const exe = commandExists('pwsh') ? 'pwsh.exe' : 'powershell.exe';
    cachedShell = { exe, buildArgs: (cmd) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd] };
  } else {
    cachedShell = { exe: 'bash', buildArgs: (cmd) => ['-c', cmd] };
  }
  return cachedShell;
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
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ya murió */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ya murió */ } }
  }
}

function spawnAndCollect(exe: string, args: string[], cwd: string, timeoutMs: number, signal: AbortSignal, onChunk: (text: string) => void): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, detached: process.platform !== 'win32' });
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

    child.stdout.on('data', (chunk: Buffer) => { const t = chunk.toString('utf8'); out += t; onChunk(t); });
    child.stderr.on('data', (chunk: Buffer) => { const t = chunk.toString('utf8'); out += t; onChunk(t); });
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

      const outcome = await spawnAndCollect(shell.exe, shell.buildArgs(args.command), cwd, timeoutMs, ctx.signal, (chunk) => {
        ctx.emit({ toolCallId: ctx.toolCallId, text: chunk });
      });

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

      if (outcome.cancelled) {
        return { content: [{ type: 'text', text: `comando cancelado\n${preview}` }], isError: true, truncated, fullOutputPath };
      }
      if (outcome.timedOut) {
        return { content: [{ type: 'text', text: `comando excedió el timeout de ${timeoutMs}ms y fue terminado\n${preview}` }], isError: true, truncated, fullOutputPath };
      }
      const isError = outcome.exitCode !== 0;
      return {
        content: [{ type: 'text', text: `[exit ${outcome.exitCode ?? 'null'}]\n${preview}` }],
        isError,
        truncated,
        fullOutputPath,
        structured: { exitCode: outcome.exitCode, signal: outcome.signal },
      };
    },
  };
}
