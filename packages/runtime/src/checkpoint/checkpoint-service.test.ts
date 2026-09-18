// Tests de CheckpointService — packages/runtime/src/checkpoint/checkpoint-service.test.ts.
// Cubre doc 09 §5.2 (crear/modificar/borrar), §5.3 (conflicto por edición posterior) y §5.6
// (revert del revert), sobre una carpeta temporal real (os.tmpdir()), sin tocar el repo.
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileBlobStore } from './blob-store.js';
import { FsCheckpointService } from './checkpoint-service.js';
import { InMemoryBlobRefStore, InMemoryCheckpointStore } from './memory-repositories.js';

async function writeFile(root: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

async function readFile(root: string, relPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(root, relPath), 'utf8');
  } catch {
    return undefined;
  }
}

describe('checkpoint/FsCheckpointService', () => {
  let projectRoot: string;
  let blobsDir: string;
  let service: FsCheckpointService;
  let store: InMemoryCheckpointStore;
  let seq: number;

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'saurio-checkpoint-project-'));
    blobsDir = mkdtempSync(path.join(tmpdir(), 'saurio-checkpoint-blobs-'));
    store = new InMemoryCheckpointStore();
    seq = 0;
    service = new FsCheckpointService({
      projectRoot,
      blobStore: new FileBlobStore(blobsDir, new InMemoryBlobRefStore()),
      store,
      resolveChatId: () => 'chat-1',
      now: () => Date.now() + seq++, // createdAt estrictamente creciente entre checkpoints del mismo ms
      genId: () => `cp-${seq}-${Math.random().toString(36).slice(2)}`,
    });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(blobsDir, { recursive: true, force: true });
  });

  /** Simula lo que hace el handler de write_file/edit_file/delete_file (doc 09 §3.2-3.4). */
  async function runToolCall(
    runId: string,
    toolCallId: string,
    relPath: string,
    action: 'write' | 'delete',
    content?: string,
  ) {
    const handle = await service.begin(runId, toolCallId, [relPath]);
    await handle.before(relPath);
    if (action === 'write') {
      await writeFile(projectRoot, relPath, content ?? '');
    } else {
      await fs.rm(path.join(projectRoot, relPath), { force: true });
    }
    await handle.after(relPath);
    return service.commit(handle);
  }

  it('registra un archivo creado, sin pre_hash y con post_hash', async () => {
    const checkpoint = await runToolCall('run-1', 'tc-1', 'a.txt', 'write', 'hola\n');
    expect(checkpoint.files).toHaveLength(1);
    expect(checkpoint.files[0]).toMatchObject({ relPath: 'a.txt', change: 'created' });
    expect(checkpoint.files[0]?.preHash).toBeUndefined();
    expect(checkpoint.files[0]?.postHash).toBeTruthy();
    expect(checkpoint.stats).toEqual({ files: 1, added: 1, removed: 0 });
  });

  it('registra un archivo modificado con pre_hash y post_hash distintos', async () => {
    await writeFile(projectRoot, 'a.txt', 'linea original\n');
    const checkpoint = await runToolCall('run-1', 'tc-2', 'a.txt', 'write', 'linea nueva\n');
    expect(checkpoint.files[0]).toMatchObject({ relPath: 'a.txt', change: 'modified' });
    expect(checkpoint.files[0]?.preHash).toBeTruthy();
    expect(checkpoint.files[0]?.postHash).toBeTruthy();
    expect(checkpoint.files[0]?.preHash).not.toBe(checkpoint.files[0]?.postHash);
  });

  it('registra un archivo borrado, con pre_hash y sin post_hash', async () => {
    await writeFile(projectRoot, 'a.txt', 'contenido\n');
    const checkpoint = await runToolCall('run-1', 'tc-3', 'a.txt', 'delete');
    expect(checkpoint.files[0]).toMatchObject({ relPath: 'a.txt', change: 'deleted' });
    expect(checkpoint.files[0]?.preHash).toBeTruthy();
    expect(checkpoint.files[0]?.postHash).toBeUndefined();
  });

  it('diff() reconstruye el unificado desde los blobs pre/post', async () => {
    await writeFile(projectRoot, 'a.txt', 'uno\ndos\n');
    const checkpoint = await runToolCall('run-1', 'tc-4', 'a.txt', 'write', 'uno\ntres\n');
    const result = await service.diff(checkpoint.id, 'a.txt');
    expect(result.unified).toContain('-dos');
    expect(result.unified).toContain('+tres');
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  describe('revert', () => {
    it('crear -> revert: borra el archivo creado por el agente', async () => {
      const checkpoint = await runToolCall('run-1', 'tc-1', 'new.txt', 'write', 'contenido\n');

      const plan = await service.planRevert([checkpoint.id]);
      expect(plan.restorable).toEqual(['new.txt']);
      expect(plan.conflicts).toEqual([]);

      const result = await service.revert([checkpoint.id], { 'new.txt': 'restore' });
      expect(result.restored).toEqual(['new.txt']);
      expect(result.skipped).toEqual([]);
      expect(await readFile(projectRoot, 'new.txt')).toBeUndefined();

      const original = await store.get(checkpoint.id);
      expect(original?.status).toBe('reverted');

      const revertCheckpoint = await store.get(result.revertCheckpointId);
      expect(revertCheckpoint?.kind).toBe('revert');
      expect(revertCheckpoint?.files[0]).toMatchObject({ relPath: 'new.txt', change: 'deleted' });
    });

    it('modificar -> revert: restaura el contenido original con el mismo EOL/bytes', async () => {
      await writeFile(projectRoot, 'a.txt', 'original\n');
      const checkpoint = await runToolCall('run-1', 'tc-2', 'a.txt', 'write', 'modificado\n');

      const result = await service.revert([checkpoint.id], { 'a.txt': 'restore' });
      expect(result.restored).toEqual(['a.txt']);
      expect(await readFile(projectRoot, 'a.txt')).toBe('original\n');
    });

    it('borrar -> revert: restaura el archivo borrado', async () => {
      await writeFile(projectRoot, 'a.txt', 'contenido\n');
      const checkpoint = await runToolCall('run-1', 'tc-3', 'a.txt', 'delete');

      const result = await service.revert([checkpoint.id], { 'a.txt': 'restore' });
      expect(result.restored).toEqual(['a.txt']);
      expect(await readFile(projectRoot, 'a.txt')).toBe('contenido\n');
    });

    it('detecta conflicto cuando el archivo fue editado después del checkpoint del agente', async () => {
      await writeFile(projectRoot, 'a.txt', 'original\n');
      const checkpoint = await runToolCall('run-1', 'tc-4', 'a.txt', 'write', 'del agente\n');

      // el usuario edita el archivo después de que el agente lo dejó
      await writeFile(projectRoot, 'a.txt', 'edición del usuario\n');

      const plan = await service.planRevert([checkpoint.id]);
      expect(plan.restorable).toEqual([]);
      expect(plan.conflicts).toHaveLength(1);
      expect(plan.conflicts[0]?.relPath).toBe('a.txt');
      expect(plan.conflicts[0]?.post).toBe(checkpoint.files[0]?.postHash);

      // resolución 'keep_mine': el archivo no se toca
      const result = await service.revert([checkpoint.id], { 'a.txt': 'keep_mine' });
      expect(result.restored).toEqual([]);
      expect(result.skipped).toEqual(['a.txt']);
      expect(await readFile(projectRoot, 'a.txt')).toBe('edición del usuario\n');

      // el checkpoint original no se marca como revertido: nada de él se restauró (doc 09 §5.7)
      expect((await store.get(checkpoint.id))?.status).toBe('active');
    });

    it('nunca toca archivos que no figuran en checkpoint_files de la selección', async () => {
      await writeFile(projectRoot, 'a.txt', 'a\n');
      await writeFile(projectRoot, 'b.txt', 'b\n');
      const checkpoint = await runToolCall('run-1', 'tc-5', 'a.txt', 'write', 'a modificado\n');

      await service.revert([checkpoint.id], { 'a.txt': 'restore' });
      expect(await readFile(projectRoot, 'b.txt')).toBe('b\n');
    });

    it('revert del revert: vuelve a dejar el archivo como lo dejó el agente', async () => {
      await writeFile(projectRoot, 'a.txt', 'original\n');
      const checkpoint = await runToolCall('run-1', 'tc-6', 'a.txt', 'write', 'del agente\n');

      const firstRevert = await service.revert([checkpoint.id], { 'a.txt': 'restore' });
      expect(await readFile(projectRoot, 'a.txt')).toBe('original\n');

      const secondRevert = await service.revert([firstRevert.revertCheckpointId], { 'a.txt': 'restore' });
      expect(secondRevert.restored).toEqual(['a.txt']);
      expect(await readFile(projectRoot, 'a.txt')).toBe('del agente\n');

      const revertOfRevert = await store.get(secondRevert.revertCheckpointId);
      expect(revertOfRevert?.kind).toBe('revert');
    });

    it('revierte varios checkpoints del mismo archivo sin conflicto falso (expectedHash)', async () => {
      await writeFile(projectRoot, 'a.txt', 'v0\n');
      const cp1 = await runToolCall('run-1', 'tc-7', 'a.txt', 'write', 'v1\n');
      const cp2 = await runToolCall('run-1', 'tc-8', 'a.txt', 'write', 'v2\n');

      const plan = await service.planRevert([cp1.id, cp2.id]);
      expect(plan.restorable).toEqual(['a.txt']);
      expect(plan.conflicts).toEqual([]);

      const result = await service.revert([cp1.id, cp2.id], { 'a.txt': 'restore' });
      expect(result.restored).toEqual(['a.txt']);
      expect(await readFile(projectRoot, 'a.txt')).toBe('v0\n');
      expect((await store.get(cp1.id))?.status).toBe('reverted');
      expect((await store.get(cp2.id))?.status).toBe('reverted');
    });
  });

  describe('archivos grandes (blob_missing)', () => {
    it('marca blobMissing en vez de guardar contenido para archivos > límite configurado', async () => {
      const bigService = new FsCheckpointService({
        projectRoot,
        blobStore: new FileBlobStore(blobsDir, new InMemoryBlobRefStore()),
        store,
        resolveChatId: () => 'chat-1',
        blobSizeLimitBytes: 10, // límite bajo a propósito para el test
      });
      await writeFile(projectRoot, 'big.bin', '0123456789abcdef'); // 16 bytes > 10
      const handle = await bigService.begin('run-1', 'tc-big', ['big.bin']);
      await handle.before('big.bin');
      await writeFile(projectRoot, 'big.bin', 'fedcba9876543210xx');
      await handle.after('big.bin');
      const checkpoint = await bigService.commit(handle);

      expect(checkpoint.files[0]?.blobMissing).toBe(true);
      expect(checkpoint.files[0]?.preHash).toBeTruthy();
      expect(checkpoint.files[0]?.postHash).toBeTruthy();
    });
  });

  describe('planRevert: uncoveredEffects (doc 09 §5.3)', () => {
    it('sin deps.toolCalls, uncoveredEffects queda vacío (enriquecimiento opcional)', async () => {
      const checkpoint = await runToolCall('run-1', 'tc-unc-0', 'a.txt', 'write', 'x\n');
      const plan = await service.planRevert([checkpoint.id]);
      expect(plan.uncoveredEffects).toEqual([]);
    });

    it('lista los run_command done/failed del run cuyo finishedAt cae en el rango de la selección, ordenados por fecha', async () => {
      let clock = 1_000;
      const svc = new FsCheckpointService({
        projectRoot,
        blobStore: new FileBlobStore(blobsDir, new InMemoryBlobRefStore()),
        store,
        resolveChatId: () => 'chat-1',
        now: () => clock,
        genId: () => `cp-unc-${clock}`,
        toolCalls: {
          async listByRun(runId: string) {
            if (runId !== 'run-uncovered') return [];
            return [
              {
                id: 'tc-cmd-early', runId, iteration: 0, toolName: 'run_command',
                args: { command: 'npm test' }, argsHash: 'h0', category: 'terminal', risk: 'low',
                transport: 'native', status: 'done', finishedAt: 1_500,
              },
              {
                id: 'tc-cmd-in-range', runId, iteration: 1, toolName: 'run_command',
                args: { command: 'npm install' }, argsHash: 'h1', category: 'terminal', risk: 'medium',
                transport: 'native', status: 'done', finishedAt: 1_800,
              },
              {
                id: 'tc-cmd-out-of-range', runId, iteration: 2, toolName: 'run_command',
                args: { command: 'npm run build' }, argsHash: 'h2', category: 'terminal', risk: 'low',
                transport: 'native', status: 'failed', finishedAt: 50_000,
              },
              {
                id: 'tc-read', runId, iteration: 0, toolName: 'read_file', args: {}, argsHash: 'h3',
                category: 'read', risk: 'low', transport: 'native', status: 'done', finishedAt: 1_500,
              },
            ];
          },
        },
      });

      // Dos checkpoints del mismo run, con createdAt 1000 y 2000 -> rango [1000, 2000].
      const handle1 = await svc.begin('run-uncovered', 'tc-unc-1', ['u1.txt']);
      await handle1.before('u1.txt');
      await writeFile(projectRoot, 'u1.txt', 'a\n');
      await handle1.after('u1.txt');
      const cp1 = await svc.commit(handle1);

      clock = 2_000;
      const handle2 = await svc.begin('run-uncovered', 'tc-unc-2', ['u2.txt']);
      await handle2.before('u2.txt');
      await writeFile(projectRoot, 'u2.txt', 'b\n');
      await handle2.after('u2.txt');
      const cp2 = await svc.commit(handle2);

      const plan = await svc.planRevert([cp1.id, cp2.id]);
      expect(plan.uncoveredEffects.map((e) => e.toolCallId)).toEqual(['tc-cmd-early', 'tc-cmd-in-range']);
      expect(plan.uncoveredEffects[1]).toMatchObject({ command: 'npm install', category: 'terminal', finishedAt: 1_800 });
    });
  });

  describe('planRevert: branchChanged (doc 09 §5.3/§5.4)', () => {
    it('sin deps.gitHead, branchChanged queda undefined', async () => {
      const checkpoint = await runToolCall('run-1', 'tc-branch-0', 'a.txt', 'write', 'x\n');
      const plan = await service.planRevert([checkpoint.id]);
      expect(plan.branchChanged).toBeUndefined();
    });

    it('detecta que la rama/commit actual difiere del git_head guardado en begin()', async () => {
      const svc = new FsCheckpointService({
        projectRoot,
        blobStore: new FileBlobStore(blobsDir, new InMemoryBlobRefStore()),
        store,
        resolveChatId: () => 'chat-1',
        gitHead: { read: async () => ({ sha: 'sha-original', branch: 'main' }) },
      });
      const handle = await svc.begin('run-branch', 'tc-branch-1', ['a.txt']);
      await handle.before('a.txt');
      await writeFile(projectRoot, 'a.txt', 'x\n');
      await handle.after('a.txt');
      const checkpoint = await svc.commit(handle);

      // Entre el checkpoint y el revert, el usuario cambió de rama (mismo repo, otro HEAD).
      const svcAfterCheckout = new FsCheckpointService({
        projectRoot,
        blobStore: new FileBlobStore(blobsDir, new InMemoryBlobRefStore()),
        store,
        resolveChatId: () => 'chat-1',
        gitHead: { read: async () => ({ sha: 'sha-otra-rama', branch: 'feature/x' }) },
      });
      const plan = await svcAfterCheckout.planRevert([checkpoint.id]);
      expect(plan.branchChanged).toEqual({
        was: { sha: 'sha-original', branch: 'main' },
        now: { sha: 'sha-otra-rama', branch: 'feature/x' },
      });
    });

    it('si la rama/commit no cambió, branchChanged queda undefined', async () => {
      const stableGitHead = { sha: 'sha-estable', branch: 'main' };
      const svc = new FsCheckpointService({
        projectRoot,
        blobStore: new FileBlobStore(blobsDir, new InMemoryBlobRefStore()),
        store,
        resolveChatId: () => 'chat-1',
        gitHead: { read: async () => stableGitHead },
      });
      const handle = await svc.begin('run-branch-2', 'tc-branch-2', ['a.txt']);
      await handle.before('a.txt');
      await writeFile(projectRoot, 'a.txt', 'x\n');
      await handle.after('a.txt');
      const checkpoint = await svc.commit(handle);

      const plan = await svc.planRevert([checkpoint.id]);
      expect(plan.branchChanged).toBeUndefined();
    });
  });

  describe('planRevert: editedBy (doc 09 §5.3 "Atribución del conflicto")', () => {
    it('atribuye el conflicto a "otro run" cuando otro checkpoint dejó exactamente ese contenido', async () => {
      await writeFile(projectRoot, 'shared.txt', 'v0\n');
      const cpAgentA = await runToolCall('run-A', 'tc-attr-1', 'shared.txt', 'write', 'del agente A\n');

      // Otro run (run-B) edita el MISMO archivo después, dejando un post_hash real en checkpoint_files.
      const cpAgentB = await runToolCall('run-B', 'tc-attr-2', 'shared.txt', 'write', 'del agente B\n');
      void cpAgentB;

      // El revert que nos importa es el de run-A: su checkpoint quedó "viejo" frente a lo que dejó B.
      const plan = await service.planRevert([cpAgentA.id]);
      expect(plan.conflicts).toHaveLength(1);
      expect(plan.conflicts[0]?.editedBy).toMatchObject({ runId: 'run-B' });
    });

    it('sin ningún otro checkpoint que explique el contenido actual, no hay editedBy ("el usuario editó después")', async () => {
      await writeFile(projectRoot, 'solo.txt', 'v0\n');
      const checkpoint = await runToolCall('run-1', 'tc-attr-3', 'solo.txt', 'write', 'del agente\n');
      await writeFile(projectRoot, 'solo.txt', 'edición manual del usuario, sin checkpoint\n');

      const plan = await service.planRevert([checkpoint.id]);
      expect(plan.conflicts).toHaveLength(1);
      expect(plan.conflicts[0]?.editedBy).toBeUndefined();
    });
  });
});
