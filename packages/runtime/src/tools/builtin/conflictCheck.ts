// Chequeo compartido de "¿cambió el archivo desde que lo leíste?" para edit_file/write_file/
// delete_file — packages/runtime/src/tools/builtin/conflictCheck.ts.
// Define: doc 05 §2.8 punto 32, doc 10 §3/§5.2, doc 16 §4 ítem 16. Antes cada handler comparaba
// directo contra `deps.readTracker.lastHash(ctx.runId, relPath)` (un `Map` en memoria del proceso que
// un reinicio real borra). Ahora, cuando `deps.expectedPreHash` está inyectado (BuiltinToolsDeps),
// la fuente de verdad es `tool_calls.expected_pre_hash` de LA FILA que se está ejecutando
// (`ctx.toolCallId`) — persistida en SQLite por `RunController.executeOneToolCall` al registrar la
// tool call (doc 10 §3: "escrita en el mismo INSERT que produce tool.registered"), así que sobrevive
// a un reinicio real (doc 10 §5.2: responder una `PermissionRequest` rehidratada no depende de que el
// `ReadTracker` de ESTE proceso siga teniendo el estado del proceso anterior).
// Sin `deps.expectedPreHash` (opcional), el comportamiento es exactamente el previo a esta tarea:
// comparar contra `readTracker.lastHash(ctx.runId, relPath)`.
import type { ToolContext } from '../types.js';
import type { BuiltinToolsDeps } from './deps.js';

/** `undefined`: el run nunca leyó `relPath` (o nunca hubo state persistido para esta tool call) —
 *  mismo significado en ambas fuentes (doc 10 §3: "NULL si el run nunca leyó ese path"). */
export async function resolveExpectedHash(
  deps: BuiltinToolsDeps, ctx: ToolContext, relPath: string,
): Promise<string | undefined> {
  if (deps.expectedPreHash) {
    return deps.expectedPreHash.get(ctx.toolCallId);
  }
  return deps.readTracker.lastHash(ctx.runId, relPath);
}
