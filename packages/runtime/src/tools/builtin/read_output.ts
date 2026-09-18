// Tool builtin read_output(toolCallId, start?, end?) — packages/runtime/src/tools/builtin/read_output.ts.
// Define: doc 07 §3 y columna vertebral §4 ("resultados de tools: result_preview... completo en
// tool-outputs/<toolCallId>.txt si supera 30.000 chars"). `ToolContext` no expone la carpeta `appData`
// (vive fuera de tools/, en el proceso main/RuntimeHost); se inyecta como `deps.toolOutputsDir` al
// crear el registro de builtins — ver deviations. Relee del disco, nunca vuelve a ejecutar el comando.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';

const ArgsSchema = z.object({
  toolCallId: z.coerce.string().min(1),
  start: z.coerce.number().int().min(1).optional(),
  end: z.coerce.number().int().min(1).optional(),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

export function createReadOutputTool(deps: BuiltinToolsDeps): ToolDefinition<Args> {
  return {
    name: 'read_output',
    description: 'Relee la salida completa persistida de una tool call anterior (truncada por tamaño), por rango de líneas.',
    inputSchema: z.toJSONSchema(ArgsSchema),
    argsSchema: ArgsSchema,
    category: 'read',
    mutating: false,
    idempotent: true,
    allowedInModes: ['plan', 'ask', 'edit', 'agent'],
    source: { kind: 'builtin' },
    async handler(args: Args, _ctx: ToolContext) {
      const filePath = path.join(deps.toolOutputsDir, `${args.toolCallId}.txt`);
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch {
        return { content: [{ type: 'text', text: `no hay salida persistida para "${args.toolCallId}"` }], isError: true };
      }
      const lines = raw.split(/\r\n|\n/);
      const total = lines.length;
      const from = args.start ? Math.max(1, args.start) : 1;
      const requestedTo = args.end ? Math.min(total, args.end) : total;
      const to = Math.min(requestedTo, from + deps.maxCommandLines - 1);
      const truncated = to < requestedTo;
      const text = lines.slice(from - 1, to).join('\n');
      const suffix = truncated ? `\n[salida de ${total} líneas; pedí más con start/end]` : '';
      return { content: [{ type: 'text', text: text + suffix }], isError: false, truncated };
    },
  };
}
