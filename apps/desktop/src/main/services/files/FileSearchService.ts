import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { IpcInput, IpcOutput } from '@saurio/shared';

type SearchInput = IpcInput<'files:search'>;
type SearchOutput = IpcOutput<'files:search'>;

/** Superficie mínima de ProjectRuntime para no duplicar las reglas del WorkspaceFs del agente. */
export interface FileSearchWorkspace {
  projectId: string;
  projectRoot: string;
  workspaceFs: {
    isProtected(relPath: string): boolean;
    isIgnored(relPath: string): boolean;
  };
}

const DEFAULT_LIMIT = 20;
const MAX_EXCERPT_LENGTH = 400;

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function toPosix(relPath: string): string {
  return relPath.replace(/\\/g, '/');
}

function isExcluded(workspace: FileSearchWorkspace, relPath: string, isDirectory: boolean): boolean {
  return workspace.workspaceFs.isProtected(relPath)
    || workspace.workspaceFs.isIgnored(relPath)
    || (isDirectory && workspace.workspaceFs.isIgnored(`${relPath}/`));
}

function displayExcerpt(content: string, index: number, matchLength: number): string {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  const nextBreak = content.indexOf('\n', index);
  const lineEnd = nextBreak === -1 ? content.length : nextBreak;
  const contextBudget = MAX_EXCERPT_LENGTH - 2;
  const before = Math.max(0, Math.floor((contextBudget - matchLength) / 2));
  const start = Math.max(lineStart, index - before);
  const end = Math.min(lineEnd, start + contextBudget);
  return `${start > lineStart ? '…' : ''}${content.slice(start, end)}${end < lineEnd ? '…' : ''}`;
}

function newlines(value: string): number {
  return value.split('\n').length - 1;
}

/** Recorre cada archivo en chunks: puede hallar coincidencias más allá de los primeros KiB, pero no
 * junta el contenido del repo ni siquiera el de un archivo entero. */
async function findContentMatch(filePath: string, sizeBytes: number, needle: string, signal: AbortSignal): Promise<{ line: number; excerpt: string } | undefined> {
  if (sizeBytes === 0) return undefined;
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024, signal });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const tailLength = Math.max(1024, needle.length * 2);
  let tail = '';
  let currentLine = 1;
  let found: { line: number; excerpt: string } | undefined;
  try {
    for await (const rawChunk of stream) {
      if (signal.aborted) {
        stream.destroy();
        return undefined;
      }
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      // Un NUL o UTF-8 inválido son binario para la UI, igual que WorkspaceFs.readFile.
      if (chunk.includes(0)) return undefined;
      const text = decoder.decode(chunk, { stream: true });
      if (found) continue;
      const combined = tail + text;
      const matchIndex = combined.toLocaleLowerCase().indexOf(needle);
      if (matchIndex !== -1) {
        found = {
          line: currentLine - newlines(tail) + newlines(combined.slice(0, matchIndex)),
          excerpt: displayExcerpt(combined, matchIndex, needle.length),
        };
        // Seguimos leyendo para comprobar que el resto no sea binario/UTF-8 inválido; solo
        // conservamos el resultado pequeño, nunca el contenido del archivo.
        continue;
      }
      currentLine += newlines(text);
      tail = combined.slice(-tailLength);
    }
    const finalText = decoder.decode();
    if (found) return found;
    const combined = tail + finalText;
    const matchIndex = combined.toLocaleLowerCase().indexOf(needle);
    if (matchIndex === -1) return undefined;
    return {
      line: currentLine - newlines(tail) + newlines(combined.slice(0, matchIndex)),
      excerpt: displayExcerpt(combined, matchIndex, needle.length),
    };
  } catch {
    // Una codificación inválida o archivo que cambió/murió durante lectura no interrumpe el resto.
    return undefined;
  }
}

interface ActiveSearch {
  requestId: string;
  controller: AbortController;
}

/** Búsqueda por proyecto, deliberadamente sin índice persistido: mantiene una sola consulta activa
 * por proyecto, respeta el mismo ignore/protección de WorkspaceFs y no sigue enlaces ni junctions. */
export class FileSearchService {
  private readonly activeByProject = new Map<string, ActiveSearch>();

  cancel(projectId: string, requestId: string): void {
    const active = this.activeByProject.get(projectId);
    if (active?.requestId === requestId) active.controller.abort();
  }

  cancelAll(): void {
    for (const active of this.activeByProject.values()) active.controller.abort();
    this.activeByProject.clear();
  }

  async search(workspace: FileSearchWorkspace, input: SearchInput): Promise<SearchOutput> {
    const previous = this.activeByProject.get(workspace.projectId);
    previous?.controller.abort();
    const active: ActiveSearch = { requestId: input.requestId, controller: new AbortController() };
    this.activeByProject.set(workspace.projectId, active);

    try {
      return await this.scan(workspace, input, active.controller.signal);
    } finally {
      if (this.activeByProject.get(workspace.projectId) === active) this.activeByProject.delete(workspace.projectId);
    }
  }

  private async scan(workspace: FileSearchWorkspace, input: SearchInput, signal: AbortSignal): Promise<SearchOutput> {
    const mode = input.mode ?? 'all';
    const offset = input.offset ?? 0;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const needle = input.query.trim().toLocaleLowerCase();
    const root = await fs.realpath(workspace.projectRoot);
    const directories: Array<{ absolutePath: string; relPath: string }> = [{ absolutePath: root, relPath: '' }];
    const items: SearchOutput['items'] = [];
    let matched = 0;
    let hasMore = false;

    const addResult = (result: SearchOutput['items'][number]): boolean => {
      matched += 1;
      if (matched > offset + limit) {
        hasMore = true;
        return true;
      }
      if (matched > offset) items.push(result);
      return false;
    };

    while (directories.length > 0) {
      if (signal.aborted) return { requestId: input.requestId, items: [], hasMore: false, cancelled: true };
      const directory = directories.pop()!;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(directory.absolutePath, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const childDirectories: Array<{ absolutePath: string; relPath: string }> = [];

      for (const entry of entries) {
        if (signal.aborted) return { requestId: input.requestId, items: [], hasMore: false, cancelled: true };
        const relPath = directory.relPath ? `${directory.relPath}/${entry.name}` : entry.name;
        if (isExcluded(workspace, relPath, entry.isDirectory())) continue;
        const entryPath = path.join(directory.absolutePath, entry.name);
        let entryStat;
        try {
          // lstat evita seguir symlinks. realpath + el chequeo siguiente cubre junctions/reparse points.
          entryStat = await fs.lstat(entryPath);
          if (entryStat.isSymbolicLink()) continue;
          const resolvedPath = await fs.realpath(entryPath);
          if (!isInsideRoot(root, resolvedPath)) continue;

          if (entryStat.isDirectory()) {
            childDirectories.push({ absolutePath: resolvedPath, relPath });
            continue;
          }
          if (!entryStat.isFile()) continue;

          const nameMatches = toPosix(relPath).toLocaleLowerCase().includes(needle);
          if (mode !== 'content' && nameMatches) {
            if (addResult({ relPath, name: entry.name, match: 'path', sizeBytes: entryStat.size })) break;
            continue;
          }
          if (mode === 'path') continue;
          const contentMatch = await findContentMatch(resolvedPath, entryStat.size, needle, signal);
          if (signal.aborted) return { requestId: input.requestId, items: [], hasMore: false, cancelled: true };
          if (contentMatch && addResult({
            relPath, name: entry.name, match: 'content', sizeBytes: entryStat.size, ...contentMatch,
          })) break;
        } catch {
          // Un archivo puede desaparecer, bloquearse o cambiar mientras se recorre. Se omite sin
          // convertir una búsqueda completa en error ni abrir una ruta distinta por reintento.
          continue;
        }
      }
      if (hasMore) break;
      // stack LIFO: invertir conserva el orden de nombres al bajar por directorios.
      directories.push(...childDirectories.reverse());
    }
    return { requestId: input.requestId, items, hasMore, cancelled: false };
  }
}
