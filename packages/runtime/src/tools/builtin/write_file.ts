// Tool builtin write_file(path, content) — packages/runtime/src/tools/builtin/write_file.ts.
// Define: doc 05 §2.8 punto 32 ("misma regla de conflicto que edit_file, sin el matching en cascada...
// si expected_pre_hash es NULL o difiere del hash actual, falla con edit_conflict; único caso exento:
// write_file sobre un path que todavía no existe, donde el chequeo es 'el archivo sigue sin existir'").
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';
import { ToolExecutionError } from '../errors.js';
import { resolveExpectedHash } from './conflictCheck.js';

const ArgsSchema = z.object({
  path: z.coerce.string().min(1),
  content: z.string(),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

export function createWriteFileTool(deps: BuiltinToolsDeps): ToolDefinition<Args> {
  return {
    name: 'write_file',
    description: 'Escribe el contenido completo de un archivo (lo crea si no existe, lo reemplaza entero si existe).',
    inputSchema: z.toJSONSchema(ArgsSchema),
    argsSchema: ArgsSchema,
    category: 'write',
    mutating: true,
    idempotent: false,
    allowedInModes: ['edit', 'agent'],
    source: { kind: 'builtin' },
    classify(args: Args) {
      return { category: 'write', risk: 'medium', summary: `escribir "${args.path}"`, paths: [args.path] };
    },
    async handler(args: Args, ctx: ToolContext) {
      if (ctx.fs.isProtected(args.path)) {
        return { content: [{ type: 'text', text: `ruta protegida: "${args.path}"` }], isError: true };
      }
      let release: (() => void) | undefined;
      try {
        release = await deps.pathLock.acquire(args.path, deps.pathLockTimeoutMs);

        let existing: { content: string; hash: string; eol: 'LF' | 'CRLF'; bom: boolean } | undefined;
        try {
          existing = await ctx.fs.readFile(args.path);
        } catch (err) {
          if (err instanceof ToolExecutionError && err.code === 'not_found') existing = undefined;
          else if (err instanceof ToolExecutionError) return { content: [{ type: 'text', text: err.message }], isError: true };
          else throw err;
        }

        if (existing) {
          const lastHash = await resolveExpectedHash(deps, ctx, args.path);
          if (lastHash === undefined || lastHash !== existing.hash) {
            return {
              content: [{ type: 'text', text: 'el archivo cambió desde que lo leíste (o nunca lo leíste en este run); usá read_file antes de escribir' }],
              isError: true,
            };
          }
        }

        await ctx.checkpoint.before(args.path);
        await ctx.fs.writeFileAtomic(args.path, args.content, existing ? { eol: existing.eol, bom: existing.bom } : undefined);
        await ctx.checkpoint.after(args.path);

        const refreshed = await ctx.fs.readFile(args.path);
        deps.readTracker.record(ctx.runId, args.path, refreshed.hash);

        return {
          content: [{ type: 'text', text: `"${args.path}" ${existing ? 'reescrito' : 'creado'}` }],
          isError: false,
          structured: { change: existing ? 'modified' : 'created' },
        };
      } catch (err) {
        if (err instanceof ToolExecutionError) return { content: [{ type: 'text', text: err.message }], isError: true };
        throw err;
      } finally {
        release?.();
      }
    },
  };
}
