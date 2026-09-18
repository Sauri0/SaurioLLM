// Persistencia: EventStore y repositorios — packages/runtime/src/persistence/types.ts.
// Define: doc 04 §6 (EventStore/EventProjector) + doc 03 (nombres de tabla, solo para nomenclatura,
// según el alcance de esta tarea). Solo interfaces/tipos (sin implementación); driver.ts/schema.ts
// (better-sqlite3 + drizzle-orm) se implementan en una fase posterior.
import type {
  RunEvent, DistributiveOmit, Project, Chat, ChatMessage, ToolCallRecord, Checkpoint, Task,
} from '@saurio/shared';

export type { RunEvent, DistributiveOmit };

/** Proyector: aplica un RunEvent a las tablas relacionales dentro de la misma transacción SQLite
 *  que insertó el evento. `saurio db rebuild` vuelve a correr todos los eventos con este contrato. */
export interface EventProjector { apply(event: RunEvent): void }

export interface EventStore {
  append(event: DistributiveOmit<RunEvent, 'seq'>): RunEvent;  // persiste + proyecta en una transacción
  since(runId: string, seq: number): RunEvent[];
  lastSeq(runId: string): number;
}

// ── Repositorios (doc 04 no los nombra como interfaz; se derivan acá de las tablas de doc 03 §4
// para que persistence/{schema,repositories}.ts tenga un contrato fijo — ver deviations) ──────────

export interface ProjectRepository {
  create(project: Project): Promise<Project>;
  get(id: string): Promise<Project | undefined>;
  list(): Promise<Project[]>;
  touchLastOpened(id: string, at: number): Promise<void>;
}

export interface ChatRepository {
  create(chat: Chat): Promise<Chat>;
  get(id: string): Promise<Chat | undefined>;
  listByProject(projectId: string): Promise<Chat[]>;
  update(id: string, patch: Partial<Omit<Chat, 'id' | 'projectId'>>): Promise<Chat>;
}

export interface MessageRepository {
  append(chatId: string, message: ChatMessage): Promise<ChatMessage>;
  listByChat(chatId: string): Promise<ChatMessage[]>;
  /** Doc 07 §7.2/§7.4 (compactación): marca los mensajes reemplazados con `compacted_by =
   *  summaryMessageId`; nunca los borra (auditoría completa, doc 03 §4.3). Agregado en esta tarea
   *  (doc 16 §4 ítem 5) — la columna `compacted_by` ya existía en el DDL desde la migración 1, pero
   *  ningún método de este contrato la escribía todavía. */
  markCompacted(ids: string[], summaryMessageId: string): Promise<void>;
}

export interface ToolCallRepository {
  upsert(record: ToolCallRecord): Promise<ToolCallRecord>;
  get(id: string): Promise<ToolCallRecord | undefined>;
  listByRun(runId: string): Promise<ToolCallRecord[]>;
  /** Filas cuyo estado quedó abierto ('running'/'awaiting_permission'/'approved') al reiniciar
   *  la app (doc 05 §1, doc 10 §5.3): distingue orphaned (proceso murió) de abandoned (nunca corrió). */
  listOpenAtStartup(): Promise<ToolCallRecord[]>;
}

export interface CheckpointRepository {
  create(checkpoint: Checkpoint): Promise<Checkpoint>;
  get(id: string): Promise<Checkpoint | undefined>;
  listByChat(chatId: string): Promise<Checkpoint[]>;
  updateStatus(id: string, status: Checkpoint['status']): Promise<void>;
}

export interface TaskRepository {
  upsertMany(chatId: string, tasks: Task[]): Promise<Task[]>;
  listByChat(chatId: string): Promise<Task[]>;
}

export interface SettingsRepository {
  get(key: string, projectId?: string): Promise<unknown>;
  set(key: string, value: unknown, projectId?: string): Promise<void>;
}

export interface ProfileRepository {                    // v0.2: tabla `profiles` (doc 03 §4)
  list(projectId?: string): Promise<unknown[]>;
  save(profile: unknown): Promise<unknown>;
  setDefault(projectId: string, profileId: string): Promise<void>;
}

export interface BenchmarkRepository {                  // v0.3: tabla `benchmark_runs` (doc 03 §4)
  save(run: unknown): Promise<unknown>;
  listByModel(modelName?: string): Promise<unknown[]>;
}

export interface DownloadRepository {                   // v0.2: tabla `downloads` (doc 03 §4)
  save(job: unknown): Promise<unknown>;
  get(id: string): Promise<unknown | undefined>;
}
