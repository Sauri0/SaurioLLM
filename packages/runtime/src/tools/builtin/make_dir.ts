// Tool builtin make_dir(paths) — packages/runtime/src/tools/builtin/make_dir.ts.
// Punto 4 del encargo (feedback real v0.2.1: "creá 5 carpetas con 5 nombres propios" terminó
// encadenando `mkdir -p A/B/C && ...` por run_command, sintaxis bash inválida en PowerShell, y
// reportó mal el resultado): tool dedicada para crear una o varias carpetas dentro del workspace,
// sin pasar por un comando de shell — el system prompt (agent/environmentPrompt.ts) ya le dice al
// modelo que la prefiera sobre run_command para esto.
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';
import { ToolExecutionError } from '../errors.js';

const ArgsSchema = z.object({
  paths: z.array(z.coerce.string().min(1)).min(1),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

export function createMakeDirTool(_deps: BuiltinToolsDeps): ToolDefinition<Args> {
  return {
    name: 'make_dir',
    description: 'Crea una o varias carpetas (con sus intermedias) dentro del workspace, sin usar comandos de shell.',
    inputSchema: z.toJSONSchema(ArgsSchema),
    argsSchema: ArgsSchema,
    category: 'write',
    mutating: true,
    idempotent: true,
    allowedInModes: ['edit', 'agent'],
    source: { kind: 'builtin' },
    classify(args: Args) {
      return { category: 'write', risk: 'low', summary: `crear ${args.paths.length} carpeta(s)`, paths: args.paths };
    },
    async handler(args: Args, ctx: ToolContext) {
      const created: string[] = [];
      const failed: { path: string; error: string }[] = [];
      for (const relPath of args.paths) {
        if (ctx.fs.isProtected(relPath)) {
          failed.push({ path: relPath, error: 'ruta protegida' });
          continue;
        }
        try {
          // Deliberadamente sin `ctx.checkpoint.before/after`: ese mecanismo hashea CONTENIDO de
          // archivo (checkpoint-service.ts `snapshotBefore/After` hacen `fs.readFile(abs)`, que
          // falla con EISDIR contra un directorio) y una carpeta vacía no tiene diff que mostrar ni
          // sentido real de "revert" en este sistema. Al no declarar el path como tocado, el
          // checkpoint de esta tool call queda con `files: []` y RunController no emite
          // `checkpoint.created` (mismo gate del punto 5) — no se inventa un checkpoint que no cubre
          // nada real.
          await ctx.fs.makeDir(relPath);
          created.push(relPath);
        } catch (err) {
          const message = err instanceof ToolExecutionError ? err.message : err instanceof Error ? err.message : String(err);
          failed.push({ path: relPath, error: message });
        }
      }
      const summary = [
        created.length > 0 ? `creadas: ${created.join(', ')}` : undefined,
        failed.length > 0 ? `fallidas: ${failed.map((f) => `${f.path} (${f.error})`).join(', ')}` : undefined,
      ].filter(Boolean).join(' | ') || 'nada para crear';
      return {
        content: [{ type: 'text', text: summary }],
        isError: failed.length > 0 && created.length === 0,
        structured: { created, failed },
      };
    },
  };
}
