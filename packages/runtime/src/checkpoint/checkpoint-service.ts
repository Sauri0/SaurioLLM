// CheckpointService: begin/before/after/commit/diff/planRevert/revert — packages/runtime/src/checkpoint/checkpoint-service.ts.
// Define: doc 09 §3 (flujo checkpoint/escritura/diff) y §5 (semántica exacta de REVERT). Implementa
// la interfaz fija `CheckpointService` de packages/runtime/src/checkpoint/types.ts (no modificable).
// Persistencia vía `CheckpointStoreRepository`/`BlobStore` inyectados (no se acopla a drizzle, doc 09
// "Imprescindible para el MVP").
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Checkpoint, CheckpointFile, DiffResult, RevertConflict, RevertPlan, RevertResult, UncoveredEffect,
} from '@saurio/shared';
import type { CheckpointHandle } from '../tools/types.js';
import type { CheckpointService, RevertResolution } from './types.js';
import type { BlobStore } from './types.js';
import type { CheckpointStoreRepository, StoredCheckpoint, ToolCallLookup } from './repositories.js';
import type { GitHead, GitHeadReader } from './git.js';
import { atomicUnlink, atomicWrite, statOrUndefined } from './fs-atomic.js';
import { computeDiffStats, computeUnifiedDiff } from './diff.js';
import { detectContentProfile, hashFileStreaming, type Eol } from './hash.js';
import { promises as fs } from 'node:fs';

const DEFAULT_BLOB_LIMIT_BYTES = 20 * 1024 * 1024; // doc 09 §3.2 / §6: umbral de pre-imagen

interface PendingFileState {
  relPath: string;
  existedBefore: boolean;
  preHash?: string;
  preEol?: Eol;
  preBom?: boolean;
  change?: CheckpointFile['change'];
  postHash?: string;
  blobMissing?: boolean;
}

interface PendingCheckpoint {
  checkpointId: string;
  runId: string;
  chatId: string;
  toolCallId: string;
  createdAt: number;
  files: Map<string, PendingFileState>;
  gitHead?: GitHead;
}

export interface CheckpointServiceDeps {
  /** Raíz del workspace del proyecto; todas las `relPath` se resuelven contra ella. */
  projectRoot: string;
  blobStore: BlobStore;
  store: CheckpointStoreRepository;
  /** `begin(runId, toolCallId, paths)` no recibe `chatId` (interfaz fija de doc 04 §9), pero
   *  `checkpoints.chat_id` es NOT NULL (doc 03 §4.5) — se resuelve vía esta función inyectada en vez
   *  de acoplar el servicio a un `RunRepository` fuera del alcance de este módulo. Ver deviations. */
  resolveChatId(runId: string): Promise<string> | string;
  now?(): number;
  genId?(): string;
  /** Bytes; por defecto 20 MB (doc 09 §3.2, configurable en Settings). */
  blobSizeLimitBytes?: number;
  /** Doc 09 §2.2/§5.3: opcional — sin esto, `checkpoints.git_head` queda `undefined` y
   *  `RevertPlan.branchChanged` nunca se completa (comportamiento previo a esta tarea, no un error:
   *  un proyecto sin `.git` no tiene nada que comparar). */
  gitHead?: GitHeadReader;
  /** Doc 09 §5.3 ("uncoveredEffects"): opcional — sin esto, `RevertPlan.uncoveredEffects` queda
   *  siempre `[]` en vez de listar los `run_command` del rango de la selección. */
  toolCalls?: ToolCallLookup;
}

/** Implementación de `CheckpointService` sobre el filesystem real + repositorios inyectados. */
export class FsCheckpointService implements CheckpointService {
  private readonly pending = new Map<string, PendingCheckpoint>();
  private readonly projectRoot: string;
  private readonly blobStore: BlobStore;
  private readonly store: CheckpointStoreRepository;
  private readonly resolveChatId: (runId: string) => Promise<string> | string;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly blobLimit: number;
  private readonly gitHeadReader: GitHeadReader | undefined;
  private readonly toolCalls: ToolCallLookup | undefined;

  constructor(deps: CheckpointServiceDeps) {
    this.projectRoot = deps.projectRoot;
    this.blobStore = deps.blobStore;
    this.store = deps.store;
    this.resolveChatId = deps.resolveChatId;
    this.now = deps.now ?? (() => Date.now());
    this.genId = deps.genId ?? (() => randomUUID());
    this.blobLimit = deps.blobSizeLimitBytes ?? DEFAULT_BLOB_LIMIT_BYTES;
    this.gitHeadReader = deps.gitHead;
    this.toolCalls = deps.toolCalls;
  }

  async begin(runId: string, toolCallId: string, paths: string[]): Promise<CheckpointHandle> {
    const chatId = await this.resolveChatId(runId);
    const checkpointId = this.genId();
    // Doc 09 §2.2: "tomadas en el momento del begin()" — de solo lectura, nunca bloquea la tool call
    // mutante si `git` no está disponible o el proyecto no tiene `.git` (`GitHeadReader.read` nunca
    // lanza, devuelve `undefined`).
    const gitHead = await this.gitHeadReader?.read(this.projectRoot);
    const pending: PendingCheckpoint = {
      checkpointId, runId, chatId, toolCallId, createdAt: this.now(), files: new Map(), gitHead,
    };
    for (const relPath of paths) {
      pending.files.set(relPath, { relPath, existedBefore: false });
    }
    this.pending.set(checkpointId, pending);

    return {
      checkpointId,
      before: (relPath: string) => this.snapshotBefore(pending, relPath),
      after: (relPath: string) => this.snapshotAfter(pending, relPath),
    };
  }

  async commit(handle: CheckpointHandle): Promise<Checkpoint> {
    const pending = this.pending.get(handle.checkpointId);
    if (!pending) throw new Error(`checkpoint_not_pending: ${handle.checkpointId}`);
    this.pending.delete(handle.checkpointId);

    const files: CheckpointFile[] = [];
    let added = 0;
    let removed = 0;
    for (const state of pending.files.values()) {
      // Hallazgo E2E (2026-09-18, eval/harness.ts paso (d)/(e)): `begin()` siembra un placeholder
      // `{ existedBefore: false }` para CADA path declarado, antes de que la tool corra (doc 09 §3:
      // el handle tiene que existir antes de que el handler pueda llamar `before`/`after`). Si el
      // handler nunca llega a escribir ese path (match ambiguo, ruta protegida, lock, etc. — vuelve
      // con isError ANTES de `ctx.checkpoint.before/after`), `state.change` sigue `undefined` acá:
      // no hay preHash/postHash reales, solo el placeholder. Antes de este fix ese placeholder se
      // registraba igual como `change: 'created'` (por el fallback `existedBefore ? 'modified' :
      // 'created'`), generando un checkpoint fantasma con diff vacío (+0 -0) aunque el archivo ya
      // existiera y no hubiera cambiado — `diff()`/`revert()` (doc 04 §9) quedaban rotos para ese
      // checkpoint. Un path sin `state.change` nunca fue tocado por `before`/`after`: se excluye del
      // checkpoint en vez de inventarle un "created" falso.
      if (state.change === undefined) continue;
      const change = state.change;
      files.push({
        relPath: state.relPath,
        change,
        preHash: state.preHash,
        postHash: state.postHash,
        blobMissing: state.blobMissing || undefined,
      });
      if (!state.blobMissing) {
        const preText = await this.readBlobText(state.preHash);
        const postText = await this.readBlobText(state.postHash);
        const stats = computeDiffStats(preText, postText);
        added += stats.added;
        removed += stats.removed;
      }
    }

    return this.store.commit({
      id: pending.checkpointId,
      runId: pending.runId,
      chatId: pending.chatId,
      toolCallId: pending.toolCallId,
      kind: 'tool',
      files,
      stats: { files: files.length, added, removed },
      createdAt: pending.createdAt,
      gitHead: pending.gitHead,
    });
  }

  async diff(checkpointId: string, relPath: string): Promise<DiffResult> {
    const checkpoint = await this.store.get(checkpointId);
    if (!checkpoint) throw new Error(`checkpoint_not_found: ${checkpointId}`);
    const file = checkpoint.files.find((f) => f.relPath === relPath);
    if (!file) throw new Error(`checkpoint_file_not_found: ${relPath}`);

    const preText = await this.readBlobText(file.preHash);
    const postText = await this.readBlobText(file.postHash);
    const stats = computeDiffStats(preText, postText);
    return { unified: computeUnifiedDiff(relPath, preText, postText), added: stats.added, removed: stats.removed };
  }

  /** Doc 09 §5.3: algoritmo de `expectedHash` — simula la secuencia de revert (más nuevo -> más
   *  viejo) por archivo para no reportar conflictos falsos cuando varios checkpoints tocan el mismo
   *  path. Un archivo va a `conflicts` si, en algún punto de esa simulación, el `post` esperado no
   *  coincide con lo que hay. También calcula `uncoveredEffects` (run_command del rango de la
   *  selección) y `branchChanged` (si el repositorio cambió de rama/commit desde algún checkpoint de
   *  la selección) — ninguno de los dos escribe nada, `planRevert` sigue siendo de solo lectura. */
  async planRevert(checkpointIds: string[]): Promise<RevertPlan> {
    const ordered = await this.orderedCheckpoints(checkpointIds);
    const byPath = this.groupFilesByPath(ordered);

    const restorable: string[] = [];
    const conflicts: RevertConflict[] = [];

    for (const [relPath, entries] of byPath) {
      const currentHash = await this.hashCurrent(relPath);
      let expected: string | null = currentHash;
      let conflictEntry: { file: CheckpointFile } | undefined;

      for (const entry of entries) {
        const effectivePost = entry.file.change === 'deleted' ? null : entry.file.postHash ?? null;
        if (effectivePost !== expected) {
          conflictEntry = entry;
          break;
        }
        expected = entry.file.change === 'created' ? null : entry.file.preHash ?? null;
      }

      if (conflictEntry) {
        // Doc 09 §5.3 "Atribución del conflicto": antes de asumir "el usuario editó después", se
        // busca la fila `checkpoint_files` más reciente (de CUALQUIER checkpoint) cuyo `post_hash`
        // coincida con el hash actual — si existe, el contenido de hoy también lo dejó un agente.
        const attribution = currentHash ? await this.store.findLatestFileMatch(relPath, currentHash) : undefined;
        conflicts.push({
          relPath,
          pre: conflictEntry.file.preHash,
          post: conflictEntry.file.postHash,
          current: currentHash ?? '',
          ...(attribution
            ? { editedBy: { runId: attribution.runId, chatId: attribution.chatId, at: attribution.createdAt } }
            : {}),
        });
      } else {
        restorable.push(relPath);
      }
    }

    const uncoveredEffects = await this.computeUncoveredEffects(ordered);
    const branchChanged = await this.computeBranchChanged(ordered);

    return { restorable, conflicts, uncoveredEffects, ...(branchChanged ? { branchChanged } : {}) };
  }

  /** Doc 09 §5.3 "uncoveredEffects": tool calls `run_command` (`done`/`failed`) del/de los run(s) de
   *  la selección, cuyo `finishedAt` cae entre el `created_at` del checkpoint más viejo y el del más
   *  nuevo — el revert de archivos no deshace estos efectos (doc 09 §6). Sin `deps.toolCalls`
   *  (opcional), devuelve `[]` en vez de fallar: es un enriquecimiento, no un requisito para poder
   *  revertir archivos. */
  private async computeUncoveredEffects(ordered: StoredCheckpoint[]): Promise<UncoveredEffect[]> {
    if (!this.toolCalls || ordered.length === 0) return [];
    const createdAts = ordered.map((c) => c.createdAt);
    const rangeStart = Math.min(...createdAts);
    const rangeEnd = Math.max(...createdAts);
    const runIds = [...new Set(ordered.map((c) => c.runId))];

    const effects: UncoveredEffect[] = [];
    for (const runId of runIds) {
      const calls = await this.toolCalls.listByRun(runId);
      for (const call of calls) {
        if (call.toolName !== 'run_command') continue;
        if (call.status !== 'done' && call.status !== 'failed') continue;
        if (call.finishedAt === undefined || call.finishedAt < rangeStart || call.finishedAt > rangeEnd) continue;
        const args = call.args as { command?: string } | undefined;
        effects.push({
          toolCallId: call.id, toolName: call.toolName, command: args?.command,
          category: call.category, finishedAt: call.finishedAt,
        });
      }
    }
    return effects.sort((a, b) => a.finishedAt - b.finishedAt);
  }

  /** Doc 09 §5.3/§5.4 "branchChanged": presente solo si el proyecto tiene `.git` (algún checkpoint
   *  de la selección guardó `gitHead`, doc 09 §2.2) y el `HEAD`/rama actual difiere del guardado. Sin
   *  `deps.gitHead` (opcional), o si ningún checkpoint de la selección tiene `gitHead` (proyecto sin
   *  `.git` en el momento del checkpoint), devuelve `undefined` — ninguna de las dos lecturas usadas
   *  acá escribe en `.git` (doc 09 §7.1). */
  private async computeBranchChanged(
    ordered: StoredCheckpoint[],
  ): Promise<RevertPlan['branchChanged']> {
    const was = ordered.find((c) => c.gitHead !== undefined)?.gitHead;
    if (!was || !this.gitHeadReader) return undefined;
    const now = await this.gitHeadReader.read(this.projectRoot);
    if (!now) return undefined;
    if (now.sha === was.sha && now.branch === was.branch) return undefined;
    return { was, now };
  }

  /** Doc 09 §5.2, §5.5, §5.6: aplica del más nuevo al más viejo, restaura el estado previo al
   *  checkpoint más viejo de la selección para cada archivo con resolución 'restore', y el propio
   *  revert genera un nuevo checkpoint `kind: 'revert'` (por eso es en sí mismo reversible). */
  async revert(checkpointIds: string[], resolution: Record<string, RevertResolution>): Promise<RevertResult> {
    const ordered = await this.orderedCheckpoints(checkpointIds);
    const byPath = this.groupFilesByPath(ordered);

    const totals = new Map<string, { total: number; restored: number }>();
    for (const checkpoint of ordered) totals.set(checkpoint.id, { total: 0, restored: 0 });
    for (const [, entries] of byPath) {
      for (const entry of entries) totals.get(entry.checkpoint.id)!.total += 1;
    }

    const restored: string[] = [];
    const skipped: string[] = [];
    const revertFiles: CheckpointFile[] = [];

    for (const [relPath, entries] of byPath) {
      const decision = resolution[relPath] ?? 'skip';
      if (decision !== 'restore') {
        skipped.push(relPath);
        continue;
      }

      // doc 09 §5.5: el objetivo final es el estado "pre" del checkpoint MÁS VIEJO de la selección
      // que toca este archivo — no una reescritura intermedia por cada checkpoint.
      const oldest = entries[entries.length - 1]!;
      const abs = this.absPath(relPath);
      const beforeHash = await this.hashCurrent(relPath);
      let afterHash: string | null = null;

      if (oldest.file.change === 'created') {
        // doc 09 §5.2: 'created' -> el archivo que creó el agente se borra, no hay "pre" que restaurar.
        await atomicUnlink(abs);
      } else {
        if (!oldest.file.preHash) throw new Error(`revert_missing_pre_hash: ${relPath}`);
        const content = await this.blobStore.get(oldest.file.preHash);
        if (!content) throw new Error(`revert_blob_missing: ${relPath}`);
        await atomicWrite(abs, content, this.genId());
        afterHash = oldest.file.preHash;
      }

      restored.push(relPath);
      for (const entry of entries) totals.get(entry.checkpoint.id)!.restored += 1;

      revertFiles.push({
        relPath,
        change: beforeHash === null ? 'created' : afterHash === null ? 'deleted' : 'modified',
        preHash: beforeHash ?? undefined,
        postHash: afterHash ?? undefined,
      });
    }

    let added = 0;
    let removed = 0;
    for (const file of revertFiles) {
      const preText = await this.readBlobText(file.preHash);
      const postText = await this.readBlobText(file.postHash);
      const stats = computeDiffStats(preText, postText);
      added += stats.added;
      removed += stats.removed;
    }

    const anchor = ordered[0];
    const revertCheckpointId = this.genId();
    await this.store.commit({
      id: revertCheckpointId,
      runId: anchor?.runId ?? '',
      chatId: anchor?.chatId ?? '',
      kind: 'revert',
      files: revertFiles,
      stats: { files: revertFiles.length, added, removed },
      createdAt: this.now(),
    });

    // doc 09 §5.7: 'reverted' si TODOS los archivos de ese checkpoint se restauraron, 'partial' si
    // solo algunos; si ninguno se restauró (todo `keep_mine`/`skip`) el checkpoint queda como estaba.
    for (const checkpoint of ordered) {
      const t = totals.get(checkpoint.id)!;
      if (t.restored === 0) continue;
      await this.store.updateStatus(checkpoint.id, t.restored === t.total ? 'reverted' : 'partial');
    }

    return { restored, skipped, revertCheckpointId };
  }

  // ── privado ────────────────────────────────────────────────────────────

  private absPath(relPath: string): string {
    return path.join(this.projectRoot, relPath);
  }

  private async snapshotBefore(pending: PendingCheckpoint, relPath: string): Promise<void> {
    const abs = this.absPath(relPath);
    const stat = await statOrUndefined(abs);
    if (!stat) {
      pending.files.set(relPath, { relPath, existedBefore: false });
      return;
    }
    if (stat.size > this.blobLimit) {
      const hash = await hashFileStreaming(abs);
      pending.files.set(relPath, { relPath, existedBefore: true, preHash: hash, blobMissing: true });
      return;
    }
    const content = await fs.readFile(abs);
    const profile = detectContentProfile(content);
    const { hash } = await this.blobStore.put(content);
    pending.files.set(relPath, {
      relPath, existedBefore: true, preHash: hash, preEol: profile.eol, preBom: profile.bom,
    });
  }

  private async snapshotAfter(pending: PendingCheckpoint, relPath: string): Promise<void> {
    const state = pending.files.get(relPath) ?? { relPath, existedBefore: false };
    const abs = this.absPath(relPath);
    const stat = await statOrUndefined(abs);

    if (!stat) {
      state.change = state.existedBefore ? 'deleted' : 'created';
      state.postHash = undefined;
      pending.files.set(relPath, state);
      return;
    }

    if (stat.size > this.blobLimit) {
      state.postHash = await hashFileStreaming(abs);
      state.blobMissing = true;
    } else {
      const content = await fs.readFile(abs);
      const put = await this.blobStore.put(content);
      state.postHash = put.hash;
    }
    state.change = state.existedBefore ? 'modified' : 'created';
    pending.files.set(relPath, state);
  }

  private async readBlobText(hash?: string): Promise<string> {
    if (!hash) return '';
    const content = await this.blobStore.get(hash);
    return content ? content.toString('utf8') : '';
  }

  private async hashCurrent(relPath: string): Promise<string | null> {
    const abs = this.absPath(relPath);
    const stat = await statOrUndefined(abs);
    if (!stat) return null;
    return hashFileStreaming(abs);
  }

  private async orderedCheckpoints(checkpointIds: string[]): Promise<StoredCheckpoint[]> {
    const checkpoints = await this.store.getMany(checkpointIds);
    // doc 09 §5.5: del más nuevo al más viejo.
    return [...checkpoints].sort((a, b) => b.createdAt - a.createdAt);
  }

  private groupFilesByPath(
    ordered: StoredCheckpoint[],
  ): Map<string, { checkpoint: StoredCheckpoint; file: CheckpointFile }[]> {
    const byPath = new Map<string, { checkpoint: StoredCheckpoint; file: CheckpointFile }[]>();
    for (const checkpoint of ordered) {
      for (const file of checkpoint.files) {
        const list = byPath.get(file.relPath) ?? [];
        list.push({ checkpoint, file });
        byPath.set(file.relPath, list);
      }
    }
    return byPath;
  }
}
