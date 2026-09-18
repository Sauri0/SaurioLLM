// Registro de las 10 tools builtin — packages/runtime/src/tools/builtin/index.ts.
// Define: doc 02 §1 (packages/runtime/src/tools/builtin/) y doc 04 §4 (BuiltinToolName: list_files,
// search_code, read_file, read_output, edit_file, write_file, delete_file, run_command, task_update,
// finish). `createBuiltinTools` es lo que `createToolRegistry().register(...)` consume; un archivo por
// tool, como pide la tarea.
import type { ToolDefinition } from '../types.js';
import { type BuiltinToolsDeps, defaultBuiltinToolsDeps } from './deps.js';
import { createListFilesTool } from './list_files.js';
import { createSearchCodeTool } from './search_code.js';
import { createReadFileTool } from './read_file.js';
import { createReadOutputTool } from './read_output.js';
import { createEditFileTool } from './edit_file.js';
import { createWriteFileTool } from './write_file.js';
import { createDeleteFileTool } from './delete_file.js';
import { createRunCommandTool } from './run_command.js';
import { createTaskUpdateTool } from './task_update.js';
import { createFinishTool } from './finish.js';
import { createDelegateTool } from './delegate.js';

export type { BuiltinToolsDeps };
export { defaultBuiltinToolsDeps };
export { classifyCommand } from './run_command.js';

/** Cada builtin declara su propio `ToolDefinition<Args>` (tipado fuerte para tests y para quien la
 *  instancia); el registro las guarda como `ToolDefinition<unknown>` (doc 04 §4) porque el runtime
 *  invoca `handler` recién después de validar `args` con `argsSchema` (doc 05 §2.5 paso 21) — el cast
 *  es el mismo patrón que cualquier registro heterogéneo de handlers tipados por variante. */
function erase<A>(def: ToolDefinition<A>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

/** Instancia las 10 builtins del MVP + `delegate` (doc 19 §2.5, E3a) con dependencias compartidas
 *  (ReadTracker, PathLock, límites de ContextPolicy). Doc 04 §4, BuiltinToolName. `delegate` se
 *  registra siempre (para que `tools.list({names: agent.allowedTools})` pueda resolverla), pero NO
 *  forma parte de `DEFAULT_ALLOWED_TOOLS` (agent/defaults.ts) — solo la ve un agente que la pida
 *  explícita en su `allowedTools`. */
export function createBuiltinTools(overrides: Partial<BuiltinToolsDeps> = {}): ToolDefinition[] {
  const deps = defaultBuiltinToolsDeps(overrides);
  return [
    erase(createListFilesTool(deps)),
    erase(createSearchCodeTool(deps)),
    erase(createReadFileTool(deps)),
    erase(createReadOutputTool(deps)),
    erase(createEditFileTool(deps)),
    erase(createWriteFileTool(deps)),
    erase(createDeleteFileTool(deps)),
    erase(createRunCommandTool(deps)),
    erase(createTaskUpdateTool(deps)),
    erase(createFinishTool(deps)),
    erase(createDelegateTool(deps)),
  ];
}
