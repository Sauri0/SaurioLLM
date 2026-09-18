// Dependencias inyectadas en las 10 builtins — packages/runtime/src/tools/builtin/deps.ts.
// Define: doc 07 §3 (límites duros de las tools de exploración: depth<=3, max_results<=50,
// maxReadLines, maxCommandLines) y doc 05 §2.8 punto 32 (timeout de run_command, 120s por defecto,
// configurable hasta 600s). `ToolContext` (tools/types.ts) no declara estos límites ni el `ReadTracker`
// ni el `PathLock` compartido entre edit_file/write_file/delete_file; se inyectan acá al construir el
// registro de builtins en vez de agregar campos a esa interfaz — ver deviations.
import os from 'node:os';
import path from 'node:path';
import { PathLock } from '../pathLock.js';
import { ReadTracker } from '../readTracker.js';

/** Doc 16 §4 ítem 16 / doc 10 §3, §5.2: fuente de verdad persistida de "¿cuál era el hash esperado
 *  de este archivo cuando se registró ESTA tool call?" (`tool_calls.expected_pre_hash`), para que el
 *  chequeo de conflicto de `edit_file`/`write_file`/`delete_file` sobreviva a un reinicio real del
 *  proceso — antes dependía solo del `ReadTracker` en memoria, que un reinicio borra igual que
 *  cualquier otro estado del proceso. `get()` recibe `ctx.toolCallId` (la fila concreta que se está
 *  ejecutando/aprobando), no `runId`+`relPath`: es exactamente la comparación que pide doc 10 §5.2
 *  ("lee la fila que se está aprobando, tanto si el run sigue vivo en memoria como si se
 *  rehidrató"). */
export interface ExpectedPreHashPort {
  get(toolCallId: string): Promise<string | undefined>;
}

export interface BuiltinToolsDeps {
  maxListDepth: number;
  maxSearchResults: number;
  maxReadLines: number;
  maxCommandLines: number;
  defaultCommandTimeoutMs: number;
  maxCommandTimeoutMs: number;
  /** Timeout para tomar el lock por path antes de fallar con 'edit_conflict' (doc 09 §3.3 punto 0). */
  pathLockTimeoutMs: number;
  /** `appData/tool-outputs/` (columna vertebral §4); el runtime real la pasa desde RuntimeHost. */
  toolOutputsDir: string;
  readTracker: ReadTracker;
  pathLock: PathLock;
  /** Opcional: sin este puerto, `edit_file`/`write_file`/`delete_file` siguen comparando solo contra
   *  `readTracker` (comportamiento previo a esta tarea) — ver `resolveExpectedHash` en
   *  `conflictCheck.ts`. Con él, la comparación usa `tool_calls.expected_pre_hash` persistido. */
  expectedPreHash?: ExpectedPreHashPort;
}

export function defaultBuiltinToolsDeps(overrides: Partial<BuiltinToolsDeps> = {}): BuiltinToolsDeps {
  return {
    maxListDepth: 3,
    maxSearchResults: 50,
    maxReadLines: 250,
    maxCommandLines: 250,
    defaultCommandTimeoutMs: 120_000,
    maxCommandTimeoutMs: 600_000,
    pathLockTimeoutMs: 2000,
    toolOutputsDir: path.join(os.tmpdir(), 'saurio-tool-outputs'),
    readTracker: new ReadTracker(),
    pathLock: new PathLock(),
    ...overrides,
  };
}
