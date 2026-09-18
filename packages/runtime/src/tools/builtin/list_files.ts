// Tool builtin list_files(path, depth?) — packages/runtime/src/tools/builtin/list_files.ts.
// Define: doc 07 §3 (tabla de tools de exploración; límite duro depth<=3, se clampa sin error).
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';

const ArgsSchema = z.object({
  path: z.coerce.string().default('.'),
  depth: z.coerce.number().int().min(0).max(3).optional(),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

export function createListFilesTool(deps: BuiltinToolsDeps): ToolDefinition<Args> {
  return {
    name: 'list_files',
    description: 'Lista archivos y carpetas del workspace a partir de una ruta, hasta una profundidad máxima de 3.',
    inputSchema: z.toJSONSchema(ArgsSchema),
    argsSchema: ArgsSchema,
    category: 'read',
    mutating: false,
    idempotent: true,
    allowedInModes: ['plan', 'ask', 'edit', 'agent'],
    source: { kind: 'builtin' },
    async handler(args: Args, ctx: ToolContext) {
      const depth = args.depth ?? deps.maxListDepth;
      const entries = await ctx.fs.listDir(args.path, Math.min(depth, deps.maxListDepth));
      const lines = entries
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((e) => `${e.isDir ? 'd' : 'f'} ${e.path}`);
      return {
        content: [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : '(vacío)' }],
        isError: false,
        structured: entries,
      };
    },
  };
}
