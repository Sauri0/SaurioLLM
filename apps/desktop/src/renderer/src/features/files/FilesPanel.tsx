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

interface TreeRowProps {
  node: FileTreeNode;
  depth: number;
  selected: string | null;
  dirty: Set<string>;
  demoChildren?: DemoNode[];
  loadChildren: (relPath: string) => Promise<FileTreeNode[]>;
  onSelectFile: (relPath: string) => void;
}

function TreeRow({ node, depth, selected, dirty, demoChildren, loadChildren, onSelectFile }: TreeRowProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileTreeNode[] | null>(demoChildren ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDir = node.kind === 'dir';
  const isDirty = node.externallyModified || dirty.has(node.relPath);

  const toggle = useCallback(async () => {
    if (!isDir) return;
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (children !== null) return; // ya cargados (perezoso: solo se pide una vez por carpeta)
    setLoading(true);
    setError(null);
    try {
      setChildren(await loadChildren(node.relPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [isDir, open, children, loadChildren, node.relPath]);

  return (
    <div>
      <div
        className={`saurio-sidebar-item${selected === node.relPath ? ' active' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => (isDir ? void toggle() : onSelectFile(node.relPath))}
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
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const loadRoot = useCallback(async () => {
    if (!projectId) return;
    if (demo) { setTree(DEMO_TREE); return; }
    setLoading(true);
    setError(null);
    try {
      setTree(await invoke('files:tree', { projectId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, demo]);

  useEffect(() => {
    void loadRoot();
    setSelected(null);
    setFileContent(null);
    setDirty(new Set());
  }, [loadRoot]);

  // "Modificado externamente" en vivo (fs.watch de main, doc 04 §16 `files:changed`): el badge se
  // actualiza sin tener que volver a pedir el árbol de esa carpeta.
  useEffect(() => {
    if (demo) return;
    return onEvent('files:changed', (event) => {
      if (event.projectId !== projectIdRef.current) return;
      setDirty((prev) => {
        const next = new Set(prev);
        if (event.kind === 'removed') next.delete(event.relPath); else next.add(event.relPath);
        return next;
      });
    });
  }, [demo]);

  const loadChildren = useCallback(async (relPath: string): Promise<FileTreeNode[]> => {
    if (!projectId) return [];
    return invoke('files:tree', { projectId, relPath });
  }, [projectId]);

  const onSelectFile = useCallback(async (relPath: string) => {
    setSelected(relPath);
    setFileContent(null);
    setFileError(null);
    if (!projectId) return;
    if (demo) { setFileContent(`// modo demo: contenido de ejemplo\n// ${relPath}\n`); return; }
    try {
      const result = await invoke('files:read', { projectId, relPath });
      setFileContent(result.content);
      setDirty((prev) => {
        if (!prev.has(relPath)) return prev;
        const next = new Set(prev);
        next.delete(relPath); // abrir el archivo limpia el aviso, igual que hace el handler en main
        return next;
      });
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId, demo]);

  if (!projectId) return <p className="saurio-empty">Abrí un proyecto para ver su árbol de archivos.</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>Archivos</strong>
        <button onClick={() => void loadRoot()} disabled={loading}>{loading ? 'Actualizando…' : 'Actualizar'}</button>
      </div>
      {error && <div className="saurio-banner danger">{error}</div>}
      <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
        <div style={{ flex: selected ? '0 0 45%' : '1 1 auto', overflow: 'auto' }}>
          {tree.length === 0 && !loading && !error && <p className="saurio-empty">Sin archivos indexados.</p>}
          {tree.map((node) => (
            <TreeRow
              key={node.relPath}
              node={node}
              depth={0}
              selected={selected}
              dirty={dirty}
              demoChildren={(node as DemoNode).children}
              loadChildren={loadChildren}
              onSelectFile={onSelectFile}
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
