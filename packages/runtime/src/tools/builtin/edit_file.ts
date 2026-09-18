// Tool builtin edit_file(path, old_string, new_string, replace_all?) — tools/builtin/edit_file.ts.
// Define: doc 05 §2.8 punto 32 (relee del disco, hash vs última lectura, matching en cascada,
// escritura atómica con reintentos, sin fallback in-place) y doc 09 §3 (checkpoint.before/after,
// lock por rel_path). Única tool mutante por turno según columna vertebral, decisión 2.
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';
import { ToolExecutionError } from '../errors.js';
import { replaceAtCascade } from '../matching.js';
import { resolveExpectedHash } from './conflictCheck.js';

const ArgsSchema = z.object({
  path: z.coerce.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.coerce.boolean().optional(),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

export function createEditFileTool(deps: BuiltinToolsDeps): ToolDefinition<Args> {
  return {
    name: 'edit_file',
    description: 'Reemplaza old_string por new_string en un archivo existente, con matching tolerante en cascada.',
    inputSchema: z.toJSONSchema(ArgsSchema),
    argsSchema: ArgsSchema,
    category: 'write',
    mutating: true,
    idempotent: false,
    allowedInModes: ['edit', 'agent'],
    source: { kind: 'builtin' },
    classify(args: Args) {
      return { category: 'write', risk: 'medium', summary: `editar "${args.path}"`, paths: [args.path] };
    },
    async handler(args: Args, ctx: ToolContext) {
      if (ctx.fs.isProtected(args.path)) {
        return { content: [{ type: 'text', text: `ruta protegida: "${args.path}"` }], isError: true };
      }
      let release: (() => void) | undefined;
      try {
        release = await deps.pathLock.acquire(args.path, deps.pathLockTimeoutMs);

        let current;
        try {
          current = await ctx.fs.readFile(args.path);
        } catch (err) {
          if (err instanceof ToolExecutionError) return { content: [{ type: 'text', text: err.message }], isError: true };
          throw err;
        }

        const lastHash = await resolveExpectedHash(deps, ctx, args.path);
        if (lastHash === undefined || lastHash !== current.hash) {
          return {
            content: [{ type: 'text', text: 'el archivo cambió desde que lo leíste (o nunca lo leíste en este run); usá read_file antes de editar' }],
            isError: true,
          };
        }

        const result = replaceAtCascade(current.content, args.old_string, args.new_string, args.replace_all ?? false);
        if (result.level === null) {
          // Doc 16 §4 ítem 6: cuando el fallo es por ambigüedad, se listan las coincidencias
          // numeradas (línea + vista previa) para que el modelo pueda agregar contexto en vez de
          // repetir la misma llamada (hallazgo real 2026-09-18, doc 16 §6: el LoopDetector abortó
          // un run porque el modelo reintentó 4 veces la misma llamada ambigua sin cambiar nada).
          const candidatesText = result.candidates && result.candidates.length > 0
            ? `\nCoincidencias encontradas:\n${result.candidates.map((c, i) => `${i + 1}. línea ${c.line}: ${c.preview}`).join('\n')}\nAgregá más líneas de contexto (antes y/o después) a old_string para desambiguar, o usá replace_all: true si querés reemplazar todas.`
            : '';
          return { content: [{ type: 'text', text: `no se pudo aplicar el cambio: ${result.reason}${candidatesText}` }], isError: true };
        }

        await ctx.checkpoint.before(args.path);
        await ctx.fs.writeFileAtomic(args.path, result.content, { eol: current.eol, bom: current.bom });
        await ctx.checkpoint.after(args.path);

        const refreshed = await ctx.fs.readFile(args.path);
        deps.readTracker.record(ctx.runId, args.path, refreshed.hash);

        return {
          content: [{ type: 'text', text: `"${args.path}" editado (match_level: ${result.level}, ${result.count} reemplazo(s))` }],
          isError: false,
          structured: { matchLevel: result.level, count: result.count },
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
