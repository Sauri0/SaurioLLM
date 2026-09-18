// Tool builtin delete_file(path) — packages/runtime/src/tools/builtin/delete_file.ts.
// Define: doc 05 §2.8 punto 32 (misma regla de conflicto que write_file: hash vs última lectura
// registrada en este run) y doc 09 §3.3 (mismo mecanismo de checkpoint que edit_file/write_file:
// before(relPath) guarda el blob de la pre-imagen -> fs.unlink -> commit; sin cuarentena para el
// caso normal, ver doc 09 §6 para blob_missing > 20 MB, resuelto dentro de CheckpointService).
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';
import { ToolExecutionError } from '../errors.js';
import { resolveExpectedHash } from './conflictCheck.js';

const ArgsSchema = z.object({
  path: z.coerce.string().min(1),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

export function createDeleteFileTool(deps: BuiltinToolsDeps): ToolDefinition<Args> {
  return {
    name: 'delete_file',
    description: 'Borra un archivo del workspace (reversible vía checkpoint mientras pese hasta 20 MB).',
    inputSchema: z.toJSONSchema(ArgsSchema),
    argsSchema: ArgsSchema,
    category: 'delete',
    mutating: true,
    idempotent: false,
    allowedInModes: ['edit', 'agent'],
    source: { kind: 'builtin' },
    classify(args: Args) {
      return { category: 'delete', risk: 'high', summary: `borrar "${args.path}"`, paths: [args.path] };
    },
    async handler(args: Args, ctx: ToolContext) {
      if (ctx.fs.isProtected(args.path)) {
        return { content: [{ type: 'text', text: `ruta protegida: "${args.path}"` }], isError: true };
      }
      let release: (() => void) | undefined;
      try {
        release = await deps.pathLock.acquire(args.path, deps.pathLockTimeoutMs);

        let existing;
        try {
          existing = await ctx.fs.readFile(args.path);
        } catch (err) {
          if (err instanceof ToolExecutionError) return { content: [{ type: 'text', text: err.message }], isError: true };
          throw err;
        }

        const lastHash = await resolveExpectedHash(deps, ctx, args.path);
        if (lastHash === undefined || lastHash !== existing.hash) {
          return {
            content: [{ type: 'text', text: 'el archivo cambió desde que lo leíste (o nunca lo leíste en este run); usá read_file antes de borrar' }],
            isError: true,
          };
        }

        await ctx.checkpoint.before(args.path);
        await ctx.fs.deleteFile(args.path);
        await ctx.checkpoint.after(args.path);
        deps.readTracker.record(ctx.runId, args.path, '');

        return { content: [{ type: 'text', text: `"${args.path}" borrado` }], isError: false, structured: { change: 'deleted' } };
      } catch (err) {
        if (err instanceof ToolExecutionError) return { content: [{ type: 'text', text: err.message }], isError: true };
        throw err;
      } finally {
        release?.();
      }
    },
  };
}
