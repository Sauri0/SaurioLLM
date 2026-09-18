// Tool builtin finish(summary, tasks?) — packages/runtime/src/tools/builtin/finish.ts.
// Define: doc 05 §2.4/§2.14 ("finish(summary) mueve el run a completed") y columna vertebral §5
// (`Plan { runId, summary, tasks }`, salida estructurada del modo plan). El runId lo agrega el
// AgentRuntime al persistir (no lo conoce esta tool); acá se devuelve `{ summary, tasks }` en
// `structured` para que el runtime arme el `Plan` completo — doc 07 §3 confirma que `finish` es la
// tool de terminación explícita del set de exploración/plan/agent.
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';

const TaskSchema = z.object({
  title: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done', 'skipped']),
}).strict();

const ArgsSchema = z.object({
  summary: z.string().min(1),
  tasks: z.array(TaskSchema).optional(),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

export function createFinishTool(_deps: BuiltinToolsDeps): ToolDefinition<Args> {
  return {
    name: 'finish',
    description: 'Termina el turno/run con una respuesta final (y, en modo plan, un checklist de tareas propuesto).',
    inputSchema: z.toJSONSchema(ArgsSchema),
    argsSchema: ArgsSchema,
    category: 'read',
    mutating: false,
    idempotent: true,
    allowedInModes: ['plan', 'ask', 'edit', 'agent'],
    source: { kind: 'builtin' },
    async handler(args: Args, _ctx: ToolContext) {
      return {
        content: [{ type: 'text', text: args.summary }],
        isError: false,
        structured: { summary: args.summary, tasks: args.tasks ?? [] },
      };
    },
  };
}
