import { useEffect, useRef, useState } from 'react';
import type { IpcInput, IpcOutput } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { fileSearchOffset } from './fileSearchLogic.js';
import './fileSearchPanel.css';

type FileSearchInput = IpcInput<'files:search'>;
type FileSearchResponse = IpcOutput<'files:search'>;
type SearchMode = NonNullable<FileSearchInput['mode']>;

interface FileSearchPanelProps {
  projectId: string;
  onSelectFile(relPath: string): void;
}

const PAGE_SIZE = 20;
let requestSequence = 0;

export function FileSearchPanel({ projectId, onSelectFile }: FileSearchPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('all');
  const [page, setPage] = useState(0);
  const [response, setResponse] = useState<FileSearchResponse>({ requestId: '', items: [], hasMore: false, cancelled: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef(0);

  useEffect(() => { setPage(0); }, [mode, projectId, query]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResponse({ requestId: '', items: [], hasMore: false, cancelled: false });
      setLoading(false);
      setError(null);
      return undefined;
    }
    setResponse({ requestId: '', items: [], hasMore: false, cancelled: false });
    setLoading(true);
    setError(null);
    const revision = ++revisionRef.current;
    const requestId = `file-search-${Date.now()}-${++requestSequence}`;
    const timer = window.setTimeout(() => {
      void invoke('files:search', {
        projectId, requestId, query: trimmed, mode, offset: fileSearchOffset(page, PAGE_SIZE), limit: PAGE_SIZE,
      }).then((next) => {
        if (revisionRef.current === revision && next.requestId === requestId) setResponse(next);
      }).catch((reason: unknown) => {
        if (revisionRef.current === revision) setError(reason instanceof Error ? reason.message : String(reason));
      }).finally(() => {
        if (revisionRef.current === revision) setLoading(false);
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      revisionRef.current += 1;
      void invoke('files:cancelSearch', { projectId, requestId }).catch(() => undefined);
    };
  }, [mode, page, projectId, query]);

  function clear(): void {
    setQuery('');
    setMode('all');
    setPage(0);
  }

  function clearFilters(): void {
    setMode('all');
    setPage(0);
  }

  return (
    <section className="file-search-panel" aria-label="Buscar archivos del proyecto">
      <div className="file-search-panel__controls">
        <label className="file-search-panel__query">Buscar archivos
          <input
            type="search"
            aria-label="Buscar archivos"
            value={query}
            maxLength={200}
            placeholder="Nombre, ruta o contenido…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>Buscar en
          <select aria-label="Buscar en" value={mode} onChange={(event) => setMode(event.target.value as SearchMode)}>
            <option value="all">Ambos</option>
            <option value="path">Nombre/ruta</option>
            <option value="content">Contenido</option>
          </select>
        </label>
        {mode !== 'all' && <button type="button" className="saurio-btn-ghost" onClick={clearFilters}>Limpiar</button>}
        {query && <button type="button" className="saurio-btn-ghost" onClick={clear}>Cancelar</button>}
      </div>
      {loading && <p className="saurio-text-dim" role="status">Buscando archivos…</p>}
      {error && <div className="saurio-banner danger" role="alert">No se pudo buscar archivos: {error}</div>}
      {!loading && !error && query.trim() && response.items.length === 0 && <p className="saurio-empty">No hay archivos que coincidan.</p>}
      {response.items.length > 0 && (
        <>
          <p className="file-search-panel__count" aria-live="polite">Resultados de archivos · página {page + 1}</p>
          <ul className="file-search-panel__results">
            {response.items.map((item) => (
              <li key={`${item.relPath}:${item.line ?? 0}:${item.match}`}>
                <button type="button" onClick={() => onSelectFile(item.relPath)} title={`Abrir ${item.relPath}`}>
                  <strong>{item.name}</strong>
                  <span className="file-search-panel__path">{item.relPath}{item.line ? `:${item.line}` : ''}</span>
                  {item.excerpt && <span className="file-search-panel__excerpt">{item.excerpt}</span>}
                </button>
              </li>
            ))}
          </ul>
          {(page > 0 || response.hasMore) && (
            <div className="file-search-panel__pagination">
              <button type="button" disabled={page === 0 || loading} onClick={() => setPage((current) => Math.max(0, current - 1))}>Anterior</button>
              <span>Página {page + 1}</span>
              <button type="button" disabled={!response.hasMore || loading} onClick={() => setPage((current) => current + 1)}>Siguiente</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
