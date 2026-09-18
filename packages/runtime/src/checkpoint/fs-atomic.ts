// Escritura/lectura atómica sobre archivos reales, para blobs y revert —
// packages/runtime/src/checkpoint/fs-atomic.ts. Define: doc 09 §2.2 (escritura atómica del propio
// blob: tmp -> fsync -> rename) y §3.3 (mismo patrón para restaurar un archivo en un revert, con
// reintento por backoff ante EPERM/EBUSY y sin fallback in-place). Esto NO es WorkspaceFs (doc 04 §9,
// tools/types.ts): WorkspaceFs confina las tools del agente (protected paths, .saurioignore); esto lo
// usa el propio CheckpointService para escribir blobs en appData y para restaurar archivos del
// workspace en un revert, que por diseño omite esas restricciones (doc 09 §5.1) — ver deviations.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class PathLockedError extends Error {
  constructor(readonly targetPath: string) {
    super(`path_locked: ${targetPath}`);
    this.name = 'PathLockedError';
  }
}

const RETRY_DELAYS_MS = [50, 150, 400];

export async function readFileRaw(absPath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(absPath);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return undefined;
    throw err;
  }
}

export async function statOrUndefined(absPath: string) {
  try {
    return await fs.stat(absPath);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return undefined;
    throw err;
  }
}

/** Doc 09 §3.3, pasos 1-4: tmp en el mismo directorio -> fsync -> rename, con reintento ante
 *  EPERM/EBUSY. `tmpSuffix` reemplaza al `toolCallId` del patrón `<archivo>.saurio-tmp-<id>`. */
export async function atomicWrite(absPath: string, content: Buffer, tmpSuffix: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.saurio-tmp-${tmpSuffix}`;
  const handle = await fs.open(tmpPath, 'w');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameWithRetry(tmpPath, absPath);
}

export async function atomicUnlink(absPath: string): Promise<void> {
  try {
    await fs.unlink(absPath);
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err;
  }
}

async function renameWithRetry(tmpPath: string, destPath: string): Promise<void> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await fs.rename(tmpPath, destPath);
      return;
    } catch (err) {
      const locked = isErrno(err, 'EPERM') || isErrno(err, 'EBUSY');
      if (!locked) {
        await fs.rm(tmpPath, { force: true });
        throw err;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        await fs.rm(tmpPath, { force: true });
        throw new PathLockedError(destPath);
      }
      await sleep(delay);
    }
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
