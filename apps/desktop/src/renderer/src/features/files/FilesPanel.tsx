// Panel "Archivos": árbol de archivos del proyecto vía IPC, perezoso por carpeta, con aviso de
// "modificado externamente" (fs.watch, doc 01 §4.1 Paneles del MVP) y un visor de solo lectura con
// CodeMirror al seleccionar un archivo (punto 1 del encargo).
// apps/desktop/src/renderer/src/features/files/FilesPanel.tsx.
//
// Integración: `files:tree`/`files:read` ya están en el contrato tipado de packages/shared/src/ipc.ts
// (antes había que usar `invokeRaw` porque el canal no existía — ver doc 16 §11, ahora resuelto).
// `files:tree` devuelve solo los hijos directos de una carpeta (perezoso): esto evita recorrer
// node_modules/.git enteros al abrir el panel, coherente con el punto 1 del encargo ("perezoso por
// carpeta"). El visor CodeMirror se carga con `React.lazy` (punto 7, code-splitting).
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { FileTreeNode } from '@saurio/shared';
import { invoke, onEvent } from '../../ipc/client.js';
import { isDemoMode } from '../../demo/demoState.js';
import { FileSearchPanel } from './FileSearchPanel.js';

const FileViewer = lazy(() => import('./FileViewer.js').then((m) => ({ default: m.FileViewer })));

export type { FileTreeNode };

/** Árbol de ejemplo para el modo demo (herramienta de verificación visual): en demo no hay proyecto
 *  real para pedirle `files:tree`, así que se siembra un árbol ya completo (con `children`) en vez
 *  de resolverlo perezosamente. */
interface DemoNode extends FileTreeNode {
  children?: DemoNode[];
}

const DEMO_TREE: DemoNode[] = [
  {
    relPath: 'apps/desktop/src/renderer/src', name: 'renderer', kind: 'dir', hasChildren: true, children: [
      { relPath: 'apps/desktop/src/renderer/src/App.tsx', name: 'App.tsx', kind: 'file' },
      {
        relPath: 'apps/desktop/src/renderer/src/features', name: 'features', kind: 'dir', hasChildren: true, children: [
          { relPath: 'apps/desktop/src/renderer/src/features/chat', name: 'chat', kind: 'dir', hasChildren: false, children: [] },
        ],
      },
    ],
  },
  {
    relPath: 'packages/runtime/src/checkpoint', name: 'checkpoint', kind: 'dir', hasChildren: true, children: [
      { relPath: 'packages/runtime/src/checkpoint/CheckpointService.ts', name: 'CheckpointService.ts', kind: 'file', externallyModified: true },
      { relPath: 'packages/runtime/src/checkpoint/CheckpointService.test.ts', name: 'CheckpointService.test.ts', kind: 'file' },
    ],
  },
  { relPath: 'docs/MANUAL.md', name: 'MANUAL.md', kind: 'file' },
];

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function acceptsFileResponse(currentProjectId: string | null, requestProjectId: string, currentPath: string | null, requestPath?: string): boolean {
  return currentProjectId === requestProjectId && (requestPath === undefined || currentPath === requestPath);
}

export function fileTreeRowKey(projectId: string, relPath: string): string {
  return `${projectId}:${relPath}`;
}

interface TreeRowProps {
  node: FileTreeNode;
  depth: number;
  selected: string | null;
  dirty: Set<string>;
  demoChildren?: DemoNode[];
  loadChildren: (relPath: string) => Promise<FileTreeNode[]>;
  onSelectFile: (relPath: string) => void;
  revision: number;
}

function TreeRow({ node, depth, selected, dirty, demoChildren, loadChildren, onSelectFile, revision }: TreeRowProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileTreeNode[] | null>(demoChildren ?? null);
  const childrenRequestRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDir = node.kind === 'dir';
  const isDirty = node.externallyModified || dirty.has(node.relPath);

  const toggle = useCallback(() => { if (isDir) setOpen((current) => !current); }, [isDir]);

  useEffect(() => {
    if (!isDir || !open || demoChildren !== undefined) return;
    const request = ++childrenRequestRef.current;
    setLoading(true);
    setError(null);
    void loadChildren(node.relPath).then((nextChildren) => {
      if (childrenRequestRef.current === request) setChildren(nextChildren);
    }).catch((err: unknown) => {
      if (childrenRequestRef.current === request) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (childrenRequestRef.current === request) setLoading(false);
    });
    return () => { childrenRequestRef.current += 1; };
  }, [demoChildren, isDir, loadChildren, node.relPath, open, revision]);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isDir ? open : undefined}
        className={`saurio-sidebar-item${selected === node.relPath ? ' active' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => (isDir ? void toggle() : onSelectFile(node.relPath))}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (isDir) toggle(); else onSelectFile(node.relPath); } }}
        title={node.relPath}
      >
        {isDir ? (open ? '▾ ' : '▸ ') : '  '}
        {node.name}
        {!isDir && node.sizeBytes !== undefined && (
          <span className="saurio-row__meta" style={{ marginLeft: 6 }}>{formatSize(node.sizeBytes)}</span>
        )}
        {isDirty && (
          <span className="saurio-badge estimated" title="Modificado fuera de SaurioLLM desde la última lectura">
            modificado externamente
          </span>
        )}
      </div>
      {isDir && open && loading && <div className="saurio-empty" style={{ paddingLeft: 10 + (depth + 1) * 14 }}>Cargando…</div>}
      {isDir && open && error && <div className="saurio-banner danger" style={{ marginLeft: 10 + (depth + 1) * 14 }}>{error}</div>}
      {isDir && open && children?.map((child) => (
        <TreeRow
          key={child.relPath}
          node={child}
          depth={depth + 1}
          selected={selected}
          dirty={dirty}
          demoChildren={(child as DemoNode).children}
          loadChildren={loadChildren}
          onSelectFile={onSelectFile}
          revision={revision}
        />
      ))}
    </div>
  );
}

export interface FilesPanelProps {
  projectId: string | null;
}

export function FilesPanel({ projectId }: FilesPanelProps): React.JSX.Element {
  const demo = isDemoMode();
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [treeRevision, setTreeRevision] = useState(0);
  const projectIdRef = useRef(projectId);
  const selectedRef = useRef(selected);
  const onSelectFileRef = useRef<(relPath: string) => void>(() => undefined);
  const requestRevisionRef = useRef(0);
  const fileRequestRevisionRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  projectIdRef.current = projectId;
  selectedRef.current = selected;

  const loadRoot = useCallback(async () => {
    if (!projectId) return;
    if (demo) { setTree(DEMO_TREE); return; }
    const requestProjectId = projectId;
    const requestRevision = ++requestRevisionRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextTree = await invoke('files:tree', { projectId: requestProjectId });
      if (projectIdRef.current !== requestProjectId || requestRevisionRef.current !== requestRevision) return;
      setTree(nextTree);
      setTreeRevision((revision) => revision + 1);
    } catch (err) {
      if (projectIdRef.current === requestProjectId && requestRevisionRef.current === requestRevision) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (projectIdRef.current === requestProjectId && requestRevisionRef.current === requestRevision) setLoading(false);
    }
  }, [projectId, demo]);

  useEffect(() => {
    setTree([]);
    void loadRoot();
    setSelected(null);
    setFileContent(null);
    setDirty(new Set());
  }, [loadRoot]);

  // "Modificado externamente" en vivo (fs.watch de main, doc 04 §16 `files:changed`): vuelve a
  // pedir el árbol con debounce y marca el archivo. No hay botón manual: el proyecto se mantiene
  // actualizado mientras la app está abierta.
  useEffect(() => {
    fileRequestRevisionRef.current += 1;
    if (demo) return;
    const unsubscribe = onEvent('files:changed', (event) => {
      if (event.projectId !== projectIdRef.current) return;
      if (event.relPath === selectedRef.current) {
        if (event.kind === 'removed') {
          setFileContent(null);
          setFileError('El archivo fue quitado del proyecto.');
          setSelected(null);
        } else {
          onSelectFileRef.current(event.relPath);
        }
      }
      setDirty((prev) => {
        const next = new Set(prev);
        if (event.kind === 'removed') next.delete(event.relPath); else next.add(event.relPath);
        return next;
      });
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => void loadRoot(), 120);
    });
    return () => {
      unsubscribe();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [demo, loadRoot]);

  const loadChildren = useCallback(async (relPath: string): Promise<FileTreeNode[]> => {
    if (!projectId) return [];
    return invoke('files:tree', { projectId, relPath });
  }, [projectId]);

  const onSelectFile = useCallback(async (relPath: string) => {
    const requestRevision = ++fileRequestRevisionRef.current;
    const sameSelection = selectedRef.current === relPath;
    selectedRef.current = relPath;
    setSelected(relPath);
    if (!sameSelection) setFileContent(null);
    setFileError(null);
    if (!projectId) return;
    if (demo) { setFileContent(`// modo demo: contenido de ejemplo\n// ${relPath}\n`); return; }
    const requestProjectId = projectId;
    try {
      const result = await invoke('files:read', { projectId: requestProjectId, relPath });
      if (fileRequestRevisionRef.current !== requestRevision || !acceptsFileResponse(projectIdRef.current, requestProjectId, selectedRef.current, relPath)) return;
      setFileContent(result.content);
      setDirty((prev) => {
        if (!prev.has(relPath)) return prev;
        const next = new Set(prev);
        next.delete(relPath); // abrir el archivo limpia el aviso, igual que hace el handler en main
        return next;
      });
    } catch (err) {
      if (fileRequestRevisionRef.current === requestRevision && acceptsFileResponse(projectIdRef.current, requestProjectId, selectedRef.current, relPath)) {
        setFileError(`No se pudo leer ${relPath}: ${err instanceof Error ? err.message : String(err)}. Intentá abrirlo de nuevo.`);
      }
    }
  }, [projectId, demo]);
  onSelectFileRef.current = onSelectFile;

  if (!projectId) return <p className="saurio-empty">Abrí un proyecto para ver su árbol de archivos.</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>Archivos</strong>
        <span className="saurio-row__meta">{loading ? 'Actualizando…' : 'Actualización automática'}</span>
      </div>
      <FileSearchPanel key={projectId} projectId={projectId} onSelectFile={onSelectFile} />
      {error && <div className="saurio-banner danger">{error}</div>}
      <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
        <div style={{ flex: selected ? '0 0 45%' : '1 1 auto', overflow: 'auto' }}>
          {tree.length === 0 && !loading && !error && <p className="saurio-empty">Sin archivos indexados.</p>}
          {tree.map((node) => (
            <TreeRow
              key={fileTreeRowKey(projectId, node.relPath)}
              node={node}
              depth={0}
              selected={selected}
              dirty={dirty}
              demoChildren={(node as DemoNode).children}
              loadChildren={loadChildren}
              onSelectFile={onSelectFile}
              revision={treeRevision}
            />
          ))}
        </div>
        {selected && (
          <div style={{ flex: '1 1 55%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div className="saurio-row__meta" style={{ marginBottom: 4 }}>{selected}</div>
            {fileError && <div className="saurio-banner danger">{fileError}</div>}
            {fileContent !== null && (
              <Suspense fallback={<p className="saurio-empty">Cargando visor…</p>}>
                <FileViewer relPath={selected} content={fileContent} />
              </Suspense>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
