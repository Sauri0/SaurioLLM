// Acceso a archivos confinado al workspace — packages/runtime/src/tools/WorkspaceFs.ts.
// Define: doc 04 §4 (interfaz WorkspaceFs) y doc 09 §3.2-3.3, §7, §8 (detección de binario, escritura
// atómica temp+rename con reintentos, protected paths, .saurioignore, resolve() sin '..' fuera del
// workspace). Implementa `WorkspaceFs` de tools/types.ts (no modificado).
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { WorkspaceFs as WorkspaceFsContract } from './types.js';
import { ToolExecutionError } from './errors.js';

/** .git/**, .saurio/**, .env*, *.pem, id_rsa*, .vscode/**, .idea/** (doc 04 §4, JSDoc de WorkspaceFs). */
const PROTECTED_DIR_SEGMENTS = new Set(['.git', '.saurio', '.vscode', '.idea']);

function isProtectedSegmentedPath(relPathPosix: string): boolean {
  const segments = relPathPosix.split('/').filter(Boolean);
  if (segments.some((s) => PROTECTED_DIR_SEGMENTS.has(s))) return true;
  const base = segments[segments.length - 1] ?? '';
  if (base.startsWith('.env')) return true;
  if (base.toLowerCase().endsWith('.pem')) return true;
  if (base.startsWith('id_rsa')) return true;
  return false;
}

/** Patrón de temporales de escritura atómica (doc 09 §3.3): nunca debe aparecer en list_files,
 *  search_code ni en el repo map. Se agrega siempre a la lista de ignorados, además de .gitignore
 *  y .saurioignore. */
const ALWAYS_IGNORED_GLOBS = ['**/*.saurio-tmp-*'];

export interface WorkspaceFsOptions {
  /** Tamaño máximo que WorkspaceFs.readFile trae entero a memoria (doc 09 §3.2); por defecto 5 MB. */
  maxReadBytes?: number;
}

function detectEol(content: string): 'LF' | 'CRLF' {
  let crlf = 0, lf = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') crlf++; else lf++;
    }
  }
  return crlf >= lf && crlf > 0 ? 'CRLF' : 'LF';
}

function stripBom(buf: Buffer): { content: Buffer; bom: boolean } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { content: buf.subarray(3), bom: true };
  }
  return { content: buf, bom: false };
}

function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export class WorkspaceFsImpl implements WorkspaceFsContract {
  private readonly root: string;
  private readonly maxReadBytes: number;

  constructor(root: string, opts: WorkspaceFsOptions = {}) {
    this.root = path.resolve(root);
    this.maxReadBytes = opts.maxReadBytes ?? 5 * 1024 * 1024;
  }

  resolve(relPath: string): string {
    const normalized = relPath.replace(/\\/g, '/');
    if (path.isAbsolute(normalized)) {
      throw new ToolExecutionError('path_denied', `ruta absoluta no permitida: "${relPath}"`);
    }
    const joined = path.resolve(this.root, normalized);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    const sameAsRoot = joined === this.root;
    const withinRoot = joined.toLowerCase().startsWith(rootWithSep.toLowerCase());
    if (!sameAsRoot && !withinRoot) {
      throw new ToolExecutionError('path_denied', `"${relPath}" sale del workspace`);
    }
    return joined;
  }

  private toPosix(relPath: string): string {
    return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  isProtected(relPath: string): boolean {
    return isProtectedSegmentedPath(this.toPosix(relPath));
  }

  private ignoreMatcher(): Ignore {
    const ig = ignore();
    ig.add(ALWAYS_IGNORED_GLOBS);
    for (const file of ['.gitignore', '.saurioignore']) {
      try {
        const raw = readFileSync(path.join(this.root, file), 'utf8');
        ig.add(raw.split(/\r?\n/));
      } catch {
        // sin archivo: no aporta patrones, no es un error (doc 09 §8).
      }
    }
    return ig;
  }

  isIgnored(relPath: string): boolean {
    const rel = this.toPosix(relPath);
    if (rel === '' || rel === '.') return false;
    return this.ignoreMatcher().ignores(rel);
  }

  async readFile(relPath: string): Promise<{ content: string; hash: string; eol: 'LF' | 'CRLF'; bom: boolean }> {
    const abs = this.resolve(relPath);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new ToolExecutionError('not_found', `no existe: "${relPath}"`);
    }
    if (!stat.isFile()) {
      throw new ToolExecutionError('path_denied', `"${relPath}" no es un archivo`);
    }
    if (stat.size > this.maxReadBytes) {
      throw new ToolExecutionError(
        'result_too_large',
        `"${relPath}" pesa ${stat.size} bytes, por encima del límite de lectura completa (${this.maxReadBytes}); usá start_line/end_line`,
      );
    }
    const raw = await fs.readFile(abs);
    const { content: noBomBuf, bom } = stripBom(raw);
    assertTextDecodable(noBomBuf, relPath);
    const content = noBomBuf.toString('utf8');
    return { content, hash: hashOf(content), eol: detectEol(content), bom };
  }

  async writeFileAtomic(relPath: string, content: string, opts?: { eol?: 'LF' | 'CRLF'; bom?: boolean }): Promise<void> {
    const abs = this.resolve(relPath);
    if (this.isProtected(relPath)) {
      throw new ToolExecutionError('path_denied', `ruta protegida: "${relPath}"`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const body = opts?.eol === 'CRLF' ? content.replace(/\r?\n/g, '\r\n') : content.replace(/\r\n/g, '\n');
    let buf = Buffer.from(body, 'utf8');
    if (opts?.bom) buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
    const tmp = `${abs}.saurio-tmp-${randomUUID()}`;
    const backoffs = [50, 150, 400];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= backoffs.length; attempt++) {
      try {
        const handle = await fs.open(tmp, 'w');
        try {
          await handle.writeFile(buf);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(tmp, abs);
        return;
      } catch (err) {
        lastErr = err;
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOSPC') {
          throw new ToolExecutionError('disk_full', `sin espacio para escribir "${relPath}"`);
        }
        if (code !== 'EPERM' && code !== 'EBUSY') throw err;
        const wait = backoffs[attempt];
        if (wait !== undefined) await sleep(wait);
      }
    }
    throw new ToolExecutionError(
      'path_locked',
      `"${relPath}" sigue bloqueado tras reintentar (¿abierto en otro programa?): ${String(lastErr)}`,
    );
  }

  async deleteFile(relPath: string): Promise<void> {
    const abs = this.resolve(relPath);
    if (this.isProtected(relPath)) {
      throw new ToolExecutionError('path_denied', `ruta protegida: "${relPath}"`);
    }
    try {
      await fs.unlink(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new ToolExecutionError('not_found', `no existe: "${relPath}"`);
      throw err;
    }
  }

  async listDir(relPath: string, depth: number): Promise<{ path: string; isDir: boolean }[]> {
    const abs = this.resolve(relPath);
    // depth<=3 (doc 07 §3): cuántos niveles de listado de directorio se hacen a partir de `relPath`;
    // el nivel 1 son los hijos directos de `relPath`. Un directorio en el nivel 3 aparece en el
    // resultado, pero su propio contenido (nivel 4) no se lista.
    const clampedDepth = Math.max(1, Math.min(depth, 3));
    const out: { path: string; isDir: boolean }[] = [];
    const walk = async (dirAbs: string, dirRelPosix: string, level: number): Promise<void> => {
      if (level > clampedDepth) return;
      let entries;
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = dirRelPosix === '' ? entry.name : `${dirRelPosix}/${entry.name}`;
        const isDir = entry.isDirectory();
        if (this.isIgnored(childRel) || (isDir && this.isIgnored(`${childRel}/`))) continue;
        out.push({ path: childRel, isDir });
        if (isDir) await walk(path.join(dirAbs, entry.name), childRel, level + 1);
      }
    };
    await walk(abs, this.toPosix(relPath) === '.' ? '' : this.toPosix(relPath), 1);
    return out;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Detección mínima de binario/codificación no soportada (doc 09 §3.2): BOM desconocido ya se maneja
 *  aparte, bytes NUL o una decodificación UTF-8 inválida en los primeros 8 KB clasifican el archivo
 *  como no editable por las tools de texto. */
function assertTextDecodable(buf: Buffer, relPath: string): void {
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) {
    throw new ToolExecutionError('path_denied', `"${relPath}" parece binario (byte NUL): SaurioLLM no lo edita`);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
  } catch {
    throw new ToolExecutionError('path_denied', `"${relPath}" no decodifica como UTF-8: SaurioLLM no lo edita`);
  }
}

export function createWorkspaceFs(root: string, opts?: WorkspaceFsOptions): WorkspaceFsImpl {
  return new WorkspaceFsImpl(root, opts);
}
