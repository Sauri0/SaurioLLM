// Tool builtin read_file(path, start_line?, end_line?) — packages/runtime/src/tools/builtin/read_file.ts.
// Define: doc 07 §3 (maxReadLines por defecto 250, "sin rango explícito y archivo más largo que el
// límite: se devuelve el tramo inicial + aviso") y doc 09 §3.2 (límite duro de WorkspaceFs.readFile,
// 5 MB por defecto; por encima exige start_line/end_line). Registra el hash leído en el ReadTracker
// para que edit_file/write_file/delete_file puedan detectar "cambió desde que lo leíste" (doc 05 §2.8).
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';
import { ToolExecutionError } from '../errors.js';

const ArgsSchema = z.object({
  path: z.coerce.string().min(1),
  start_line: z.coerce.number().int().min(1).optional(),
  end_line: z.coerce.number().int().min(1).optional(),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

function sliceLines(content: string, start?: number, end?: number, cap = 250): { text: string; total: number; truncated: boolean } {
  const lines = content.split(/\r\n|\n/);
  const total = lines.length;
  const from = start ? Math.max(1, start) : 1;
  const requestedTo = end ? Math.min(total, end) : total;
  const to = Math.min(requestedTo, from + cap - 1);
  const truncated = to < requestedTo || (!start && !end && total > cap);
  const text = lines.slice(from - 1, to).join('\n');
  return { text, total, truncated };
}

async function readRangeStreaming(abs: string, start: number, end: number): Promise<string> {
  const rl = createInterface({ input: createReadStream(abs, { encoding: 'utf8' }), crlfDelay: Infinity });
  const out: string[] = [];
  let n = 0;
  for await (const line of rl) {
    n++;
    if (n >= start && n <= end) out.push(line);
    if (n > end) break;
  }
  rl.close();
  return out.join('\n');
}

export function createReadFileTool(deps: BuiltinToolsDeps): ToolDefinition<Args> {
  return {
    name: 'read_file',
    description: 'Lee un archivo de texto del workspace, opcionalmente por rango de líneas (start_line/end_line).',
    inputSchema: z.toJSONSchema(ArgsSchema),
    argsSchema: ArgsSchema,
    category: 'read',
    mutating: false,
    idempotent: true,
    allowedInModes: ['plan', 'ask', 'edit', 'agent'],
    source: { kind: 'builtin' },
    async handler(args: Args, ctx: ToolContext) {
      if (ctx.fs.isProtected(args.path) || ctx.fs.isIgnored(args.path)) {
        return { content: [{ type: 'text', text: `ruta protegida o ignorada: "${args.path}"` }], isError: true };
      }
      try {
        const { content, hash } = await ctx.fs.readFile(args.path);
        deps.readTracker.record(ctx.runId, args.path, hash);
        const { text, total, truncated } = sliceLines(content, args.start_line, args.end_line, deps.maxReadLines);
        const suffix = truncated
          ? `\n[archivo de ${total} líneas; usá start_line/end_line para ver el resto]`
          : '';
        return { content: [{ type: 'text', text: text + suffix }], isError: false, truncated };
      } catch (err) {
        if (err instanceof ToolExecutionError && err.code === 'result_too_large') {
          if (!args.start_line || !args.end_line) {
            return {
              content: [{ type: 'text', text: `${err.message}. Especificá start_line y end_line.` }],
              isError: true,
            };
          }
          const abs = ctx.fs.resolve(args.path);
          const span = Math.min(args.end_line - args.start_line + 1, deps.maxReadLines);
          const text = await readRangeStreaming(abs, args.start_line, args.start_line + span - 1);
          return { content: [{ type: 'text', text }], isError: false, truncated: span < (args.end_line - args.start_line + 1) };
        }
        if (err instanceof ToolExecutionError) {
          return { content: [{ type: 'text', text: err.message }], isError: true };
        }
        throw err;
      }
    },
  };
}
