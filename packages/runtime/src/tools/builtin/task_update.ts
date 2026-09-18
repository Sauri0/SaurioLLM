// Tool builtin task_update(steps[]) — packages/runtime/src/tools/builtin/task_update.ts.
// Define: doc 04 §10 (TaskManager: "proyección tasks del plan visible; tool task_update") y doc 05
// §2.9 punto 35 ("si la tool fue task_update, se actualiza la proyección tasks y se emite
// tasks.updated"). La escritura de la proyección `tasks` y el evento son responsabilidad del
// AgentRuntime/TaskManager (packages/runtime/src/tasks/, fuera de mi alcance); este handler valida y
// devuelve la lista en `structured` para que el runtime la persista — no toca SQLite directamente.
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';

const StepSchema = z.object({
  title: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done', 'skipped']),
}).strict();

const ArgsSchema = z.object({
  steps: z.array(StepSchema).min(1),
}).strict();
type Args = z.infer<typeof ArgsSchema>;

export function createTaskUpdateTool(_deps: BuiltinToolsDeps): ToolDefinition<Args> {
  return {
    name: 'task_update',
    description: 'Actualiza el checklist de tareas visible del run (título + estado de cada paso).',
    inputSchema: z.toJSONSchema(ArgsSchema),
    argsSchema: ArgsSchema,
    category: 'read',
    mutating: false,
    idempotent: true,
    allowedInModes: ['plan', 'edit', 'agent'],
    source: { kind: 'builtin' },
    async handler(args: Args, _ctx: ToolContext) {
      const lines = args.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.title}`);
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false,
        structured: { steps: args.steps },
      };
    },
  };
}
