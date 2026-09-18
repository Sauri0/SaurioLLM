// Agent Runtime: puertos locales de inyección de dependencias — packages/runtime/src/agent/ports.ts.
// No definidos por doc 04 ni por packages/shared/persistence: son tipos locales al módulo (regla del
// encargo: "si necesitás un tipo nuevo, definilo local a tu módulo y anotalo en deviations").
// RunController necesita, además de las interfaces ya tipadas en tools/permissions/checkpoint/context/
// gateway/persistence, tres cosas que ningún documento nombra como interfaz propia:
//   1) una forma de leer/escribir la fila `runs` (persistence/types.ts no tiene RunRepository: la
//      columna vertebral trata `runs` como proyección de `run_events`, pero recover() necesita poder
//      listar runs activos y el loop necesita poder actualizar iteration/state/effectiveConfig sin
//      pasar por EventStore para los campos que no son un RunEvent en sí, p. ej. heartbeat_at);
//   2) resolver el `AgentConfig` a partir de `chat.agentId` (no hay AgentRepository documentado);
//   3) el diagnóstico por hash de tool calls `orphaned` (doc 10 §5.4), que depende de WorkspaceFs y
//      del BlobStore — ambos viven en otros módulos (tools/checkpoint) fuera del alcance de esta tarea.
import type { Mode, ModelRef, RunState } from '@saurio/shared';
import type { AgentConfig, EffectiveConfig, RunError, ToolCallRecord } from './types.js';
import type { Checkpoint } from '@saurio/shared';

/** Proyección mínima de la fila `runs` que RunController necesita leer/escribir. Superset intencional
 *  de doc 10 §5.0 (`owner_session_id`/`heartbeat_at`) para que `recover()` pueda implementarse igual
 *  que en la columna, aunque la detección multi-instancia real (`app.requestSingleInstanceLock`) viva
 *  en el bootstrap de `main/index.ts`, fuera de `packages/runtime/src/agent/`. */
export interface RunRecord {
  id: string;
  chatId: string;
  parentRunId?: string;
  agentId: string;
  mode: Mode;
  state: RunState;
  stateReason?: string;
  iteration: number;
  lastEventSeq: number;
  effectiveConfig?: EffectiveConfig;
  error?: RunError;
  ownerSessionId?: string;
  heartbeatAt?: number;
  createdAt: number;
}

export interface RunRepository {
  create(run: RunRecord): Promise<RunRecord>;
  get(id: string): Promise<RunRecord | undefined>;
  update(id: string, patch: Partial<Omit<RunRecord, 'id'>>): Promise<RunRecord>;
  /** Runs en un estado "activo" (doc 05 §1 / doc 10 §2): todo lo que no sea terminal. */
  listActive(): Promise<RunRecord[]>;
}

/** No hay tabla `agents` tipada en persistence/types.ts (fuera del alcance de esta tarea); este
 *  puerto es lo mínimo que el paso 5 de doc 05 §2.2 necesita para resolver el `AgentConfig` activo
 *  de un chat antes de construir el `EffectiveConfig`. */
export interface AgentConfigResolver {
  resolve(agentId: string): Promise<AgentConfig>;
}

export type OrphanDiagnosisCode =
  | 'applied' | 'not_applied' | 'applied_unregistered' | 'divergent' | 'unknown';

/** Resultado de las cuatro reglas de doc 10 §5.4 para un `tool_calls.orphaned` de una tool de archivo. */
export interface OrphanDiagnosis { code: OrphanDiagnosisCode; message: string }

/** Puerto opcional: si no se provee, `recover()` marca todo `orphaned` de archivo como `'unknown'`
 *  ("estado distinto a ambos, ¿editado después?", doc 10 §5.4 última fila) en vez de comparar hashes
 *  — comparar hashes requiere `WorkspaceFs` (tools/) y `BlobStore` (checkpoint/), ninguno de los dos
 *  asignado a este módulo. */
export interface OrphanDiagnostics {
  diagnose(record: ToolCallRecord, checkpoint: Checkpoint | undefined): Promise<OrphanDiagnosis>;
}

/** Puerto local (doc 16 §4 ítem "capado automático de numCtx", ADR-7): `RunController` necesita el
 *  `contextMax` real del modelo (`/api/show` -> `ModelDescription.contextMax`, doc 04 §3) para capar
 *  `EffectiveConfig.numCtx` hacia abajo, pero `ModelManager` vive en packages/runtime/src/models
 *  (fuera del alcance de esta tarea). Este puerto es la vista mínima que `agent/` necesita; el host
 *  lo implementa envolviendo `ModelManager.describeModel` (ver eval/harness.ts para un ejemplo real).
 *  Opcional en `RunControllerDeps`: sin él, el comportamiento previo se mantiene (no se capea nada). */
export interface ModelContextProbe {
  getContextMax(ref: ModelRef): Promise<number | undefined>;
}

/** Puerto local (doc 16 §4 ítem 16 / doc 10 §3, §5.2: "expected_pre_hash sobrevive a un reinicio"):
 *  al registrar (write-ahead) una tool call mutante de archivo (`edit_file`/`write_file`/
 *  `delete_file`), `RunController` necesita saber "¿cuál fue el último hash que ESTE run vio para
 *  `relPath`?" para escribirlo en `tool_calls.expected_pre_hash` en el mismo alta que `tool.registered`
 *  (doc 10 §3: "escrita en el mismo INSERT..."). Ese estado de "última lectura por run" es del
 *  `ReadTracker` (packages/runtime/src/tools/readTracker.ts), fuera de esta zona — esta interfaz es
 *  estructuralmente idéntica a `ReadTracker.lastHash` a propósito, para que quien arma
 *  `RunControllerDeps` (createRuntime.ts/eval/harness.ts) pueda pasar la MISMA instancia que ya
 *  inyecta en `createBuiltinTools({ readTracker })` sin adaptar nada. Opcional: sin este puerto,
 *  `expected_pre_hash` queda `NULL` (comportamiento previo — el chequeo de conflicto sigue
 *  dependiendo solo del `ReadTracker` en memoria del lado de `tools/`, ver `BuiltinToolsDeps.
 *  expectedPreHash`). */
export interface LastReadHashes {
  lastHash(runId: string, relPath: string): string | undefined;
}

export interface Clock { now(): number }
export interface IdGenerator { next(): string }

export const systemClock: Clock = { now: () => Date.now() };

let counter = 0;
/** Generador de ids determinístico y sin dependencias externas para el runtime; producción puede
 *  inyectar uuid vía `IdGenerator`, los tests inyectan uno secuencial para asserts estables. */
export const defaultIdGenerator: IdGenerator = {
  next: () => `id_${Date.now().toString(36)}_${(counter++).toString(36)}`,
};
