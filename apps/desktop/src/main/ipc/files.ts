// Handlers IPC del dominio "files" (punto 1 del encargo; doc 16 §11 registraba esto como gap:
// `files:tree` no existía en packages/shared/src/ipc.ts y FilesPanel se degradaba con un aviso).
// apps/desktop/src/main/ipc/files.ts.
//
// Reutiliza el `WorkspaceFs` del `ProjectRuntime` activo (createRuntime.ts) — el mismo confinamiento
// al workspace y la misma resolución de .gitignore/.saurioignore que ya usan las tools del agente
// (packages/runtime/src/tools/WorkspaceFs.ts, fuera de esta tarea: no se toca ese archivo, solo se
// consume su instancia ya construida). Así el árbol de la UI nunca muestra algo que las tools
// tampoco verían, y viceversa.
import { statSync, watch, type FSWatcher } from 'node:fs';
import { ipc } from '@saurio/shared';
import type { FileTreeNode } from '@saurio/shared';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import type { ProjectRuntime } from '../host/createRuntime.js';
import { registerHandler } from './registerHandler.js';

export interface FilesChangeEmitter {
  emit(event: { projectId: string; relPath: string; kind: 'modified' | 'removed' }): void;
}

function requireActiveProject(host: RuntimeHost, projectId: string): ProjectRuntime {
  const project = host.activeProject;
  if (!project || project.projectId !== projectId) {
    throw new Error(
      `saurio: "files:*" pide el proyecto activo ("${projectId}"), pero el proyecto abierto es otro ` +
        '(un solo proyecto abierto a la vez — reabrí este proyecto o refrescá la vista).',
    );
  }
  return project;
}

function toPosix(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Único watcher activo a la vez (coherente con "un proyecto abierto a la vez", punto 7.a del
 *  encargo): abrir otro proyecto cierra el watcher del anterior en vez de acumularlos. */
let current: { root: string; watcher: FSWatcher; dirty: Set<string> } | undefined;

function ensureWatcher(project: ProjectRuntime, emitter: FilesChangeEmitter): Set<string> {
  if (current?.root === project.projectRoot) return current.dirty;
  current?.watcher.close();

  const dirty = new Set<string>();
  const onFsEvent = (eventType: string, filename: string | Buffer | null): void => {
    if (!filename) return;
    const relPath = toPosix(typeof filename === 'string' ? filename : filename.toString('utf8'));
    if (relPath === '') return;
    // .git/**, .saurio/**, node_modules ignorado por .gitignore, temporales de escritura atómica
    // (*.saurio-tmp-*): ruido, no cambios que el usuario hizo por fuera de SaurioLLM.
    if (project.workspaceFs.isProtected(relPath) || project.workspaceFs.isIgnored(relPath)) return;
    const kind: 'modified' | 'removed' = eventType === 'rename' ? 'removed' : 'modified';
    if (kind === 'removed') dirty.delete(relPath);
    else dirty.add(relPath);
    emitter.emit({ projectId: project.projectId, relPath, kind });
  };

  let watcher: FSWatcher;
  try {
    // recursive:true está soportado en win32/darwin desde Node 20 [VERIFICADO EN DOC OFICIAL:
    // nodejs.org/api/fs.html#fspromiseswatchfilename-options]; en Linux (inotify) no lo está y
    // fs.watch tira ERR_FEATURE_UNAVAILABLE_ON_PLATFORM — se cae a observar solo la raíz.
    watcher = watch(project.projectRoot, { recursive: true }, onFsEvent);
  } catch {
    console.warn('[ipc/files] fs.watch recursivo no soportado en esta plataforma; observando solo la raíz del proyecto');
    watcher = watch(project.projectRoot, {}, onFsEvent);
  }
  current = { root: project.projectRoot, watcher, dirty };
  return dirty;
}

/** Cierra el watcher activo (apagado de la app). */
export function closeAllFileWatchers(): void {
  current?.watcher.close();
  current = undefined;
}

export function registerFilesHandlers(host: RuntimeHost, emitter: FilesChangeEmitter): void {
  registerHandler('files:tree', ipc['files:tree'], async (input) => {
    const project = requireActiveProject(host, input.projectId);
    const dirty = ensureWatcher(project, emitter);
    const relPath = input.relPath ? toPosix(input.relPath) : '';

    const entries = await project.workspaceFs.listDir(relPath, 1);
    const nodes: FileTreeNode[] = [];
    for (const entry of entries) {
      const name = entry.path.split('/').pop() ?? entry.path;
      let hasChildren: boolean | undefined;
      let sizeBytes: number | undefined;
      if (entry.isDir) {
        try {
          hasChildren = (await project.workspaceFs.listDir(entry.path, 1)).length > 0;
        } catch {
          hasChildren = false;
        }
      } else {
        try {
          sizeBytes = statSync(project.workspaceFs.resolve(entry.path)).size;
        } catch {
          sizeBytes = undefined;
        }
      }
      nodes.push({
        relPath: entry.path,
        name,
        kind: entry.isDir ? 'dir' : 'file',
        hasChildren,
        sizeBytes,
        externallyModified: dirty.has(entry.path),
      });
    }
    // Directorios primero, alfabético dentro de cada grupo — mismo criterio visual que el resto de
    // los paneles del proyecto (doc de pasada de diseño: listas ordenadas y previsibles).
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    return nodes;
  });

  registerHandler('files:read', ipc['files:read'], async (input) => {
    const project = requireActiveProject(host, input.projectId);
    const relPath = toPosix(input.relPath);
    const { content } = await project.workspaceFs.readFile(relPath);
    // Abrir el archivo en el visor "limpia" el aviso de modificado externamente: el usuario ya vio
    // el contenido actual (mismo criterio que un editor de texto normal).
    current?.dirty.delete(relPath);
    return { relPath, content, sizeBytes: Buffer.byteLength(content, 'utf8'), truncated: false };
  });
}
