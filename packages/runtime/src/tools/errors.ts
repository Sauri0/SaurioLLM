// Códigos de error de tool calls y excepción tipada — packages/runtime/src/tools/errors.ts.
// Define: doc 09 §3.2-3.3 (path_locked, edit_conflict, path_denied, disk_full) y doc 10 §"Nomenclatura
// agregada" (ToolCallErrorCode: disk_full, db_locked, result_too_large, edit_conflict, path_denied,
// timeout, process_killed, unknown). ToolCallErrorCode vive formalmente en @saurio/shared/domain.ts según
// doc 10, pero esa tabla es responsabilidad del módulo de fallos-y-recuperación (fuera de mi alcance:
// "no edites packages/shared salvo que tu tarea lo diga"); se define acá, local a tools/, como el propio
// documento 09 permite para el contrato de las builtins — ver deviations en la salida de este módulo.
export const ToolCallErrorCode = [
  'disk_full',
  'db_locked',
  'result_too_large',
  'edit_conflict',
  'path_denied',
  'path_locked',
  'timeout',
  'process_killed',
  'not_found',
  'invalid_args',
  'unknown',
] as const;
export type ToolCallErrorCode = (typeof ToolCallErrorCode)[number];

/** Error tipado que lanzan los handlers builtin; el runtime (fuera de este módulo) lo traduce a
 *  `tool_calls.error_json` / `ToolResult.isError`. Los handlers de este módulo SIEMPRE devuelven un
 *  `ToolResult` con `isError: true` en vez de dejar escapar esta excepción — ver builtin/*.ts. */
export class ToolExecutionError extends Error {
  readonly code: ToolCallErrorCode;
  constructor(code: ToolCallErrorCode, message: string) {
    super(message);
    this.name = 'ToolExecutionError';
    this.code = code;
  }
}
