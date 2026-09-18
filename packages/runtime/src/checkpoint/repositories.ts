// Interfaces de repositorio locales al módulo checkpoint — packages/runtime/src/checkpoint/repositories.ts.
// Define: doc 09 §2.2 (blobs.refcount), doc 03 §4.5 (checkpoints/checkpoint_files). No modifica
// persistence/types.ts (contrato existente, fuera de alcance de esta tarea): esa interfaz
// `CheckpointRepository` solo cubre create/get/listByChat/updateStatus sobre el objeto `Checkpoint`
// completo (doc 04 §9). CheckpointService necesita además: (a) leer varios checkpoints por id en una
// sola consulta para `planRevert`/`revert` (doc 09 §5.3, §5.5), y (b) un timestamp de creación para
// ordenar "del más nuevo al más viejo" — `Checkpoint` (packages/shared/src/domain.ts) no lo incluye
// porque no cruza IPC. Por la regla "si necesitás un tipo nuevo, definilo local a tu módulo", se
// define acá `StoredCheckpoint` (superset de `Checkpoint` con `createdAt`) y un repositorio propio
// `CheckpointStoreRepository`; una implementación real sobre SQLite se conecta en una fase posterior
// de persistencia — ver deviations.
import type { Checkpoint, CheckpointFile, ToolCallRecord } from '@saurio/shared';
import type { GitHead } from './git.js';

export interface StoredCheckpoint extends Checkpoint {
  createdAt: number;
  /** Doc 09 §2.2: `git_head` guardado en `begin()`, si el proyecto tiene `.git` y `GitHeadReader`
   *  está inyectado. No forma parte de `Checkpoint` (packages/shared, cruza IPC) porque es una señal
   *  interna que solo consume `planRevert()` (sección 5.3) para `branchChanged` — no algo que la UI
   *  necesite mostrar por checkpoint individual. */
  gitHead?: GitHead;
}

export interface CheckpointCommitInput {
  id: string;
  runId: string;
  chatId: string;
  toolCallId?: string;
  kind: Checkpoint['kind'];
  files: CheckpointFile[];
  stats: Checkpoint['stats'];
  createdAt: number;
  gitHead?: GitHead;
}

/** Fila mínima para atribuir un conflicto a "otro run" (doc 09 §5.3, "Atribución del conflicto") —
 *  ver `CheckpointStoreRepository.findLatestFileMatch`. */
export interface FileMatchAttribution { runId: string; chatId: string; createdAt: number }

export interface CheckpointStoreRepository {
  /** Persiste un checkpoint ya cerrado (equivalente a `checkpoints.status = 'active'`, doc 09 §3.5). */
  commit(input: CheckpointCommitInput): Promise<StoredCheckpoint>;
  get(id: string): Promise<StoredCheckpoint | undefined>;
  getMany(ids: string[]): Promise<StoredCheckpoint[]>;
  listByChat(chatId: string): Promise<StoredCheckpoint[]>;
  updateStatus(id: string, status: Checkpoint['status']): Promise<void>;
  /** Doc 09 §5.3: la fila `checkpoint_files` MÁS RECIENTE (de cualquier checkpoint, de cualquier
   *  run) cuyo `post_hash` sea igual a `postHash` para `relPath` — permite distinguir "el usuario
   *  editó después" (ninguna fila así) de "modificado por otro run" (sí existe una). */
  findLatestFileMatch(relPath: string, postHash: string): Promise<FileMatchAttribution | undefined>;
}

/** Puerto mínimo que `planRevert()` necesita para `uncoveredEffects` (doc 09 §5.3): las tool calls
 *  `run_command` del/de los run(s) de la selección. Estructuralmente idéntico a
 *  `persistence/types.ts#ToolCallRepository.listByRun` — se define acá en vez de importar esa
 *  interfaz completa (fuera del alcance conceptual de checkpoint/: no necesita upsert/get/etc.). */
export interface ToolCallLookup {
  listByRun(runId: string): Promise<ToolCallRecord[]>;
}

export interface BlobRecord {
  hash: string;
  size: number;
  createdAt: number;
  refcount: number;
}

/** Contador de referencias de `blobs` (doc 09 §2.2). Síncrono a propósito: es lo que exige la firma
 *  fija `BlobStore.addRef/releaseRef` (packages/runtime/src/checkpoint/types.ts, no modificable). */
export interface BlobRefStore {
  get(hash: string): BlobRecord | undefined;
  /** Crea con refcount=1 si no existe; si existe, incrementa refcount y conserva size/createdAt. */
  upsertRef(hash: string, size: number, createdAt: number): number;
  /** Nunca baja de 0 (doc 03 §4.5: en el MVP nunca se decrementa por debajo de eso, no hay GC de blobs). */
  releaseRef(hash: string): number;
}
