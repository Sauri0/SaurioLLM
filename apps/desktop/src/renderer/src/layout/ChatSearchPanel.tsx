import { useEffect, useRef, useState } from 'react';
import { invoke } from '../ipc/client.js';
import type { Project } from '@saurio/shared';
import './chatSearchPanel.css';

interface ChatSearchResult {
  chatId: string;
  projectId: string;
  title: string;
  updatedAt: number;
  archived: boolean;
  snippet: string;
  messageId?: string;
  matchedAt?: number;
}

interface ChatSearchResponse { items: ChatSearchResult[]; hasMore: boolean }

export interface ChatSearchPanelProps {
  project: Project;
  query: string;
  onClear(): void;
  onSelectChat(chatId: string): void;
}

const PAGE_SIZE = 20;

function dayStart(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(`${value}T00:00:00`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dayEnd(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(`${value}T23:59:59.999`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function ChatSearchPanel({ project, query, onClear, onSelectChat }: ChatSearchPanelProps): React.JSX.Element {
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<ChatSearchResponse>({ items: [], hasMore: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);

  useEffect(() => { setOffset(0); }, [query, since, until, includeArchived]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const currentRevision = ++revision.current;
    setResult({ items: [], hasMore: false });
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void invoke('chat:search', {
        projectId: project.id,
        query: trimmed,
        since: dayStart(since),
        until: dayEnd(until),
        includeArchived,
        offset,
        limit: PAGE_SIZE,
      }).then((next) => {
        if (revision.current === currentRevision) setResult(next);
      }).catch((reason: unknown) => {
        if (revision.current === currentRevision) setError(reason instanceof Error ? reason.message : String(reason));
      }).finally(() => {
        if (revision.current === currentRevision) setLoading(false);
      });
    }, 250);
    return () => { window.clearTimeout(timer); revision.current += 1; };
  }, [includeArchived, offset, project.id, query, since, until]);

  function clearFilters(): void {
    setSince('');
    setUntil('');
    setIncludeArchived(false);
    setOffset(0);
  }

  return (
    <section className="saurio-chat-search" aria-label={`Resultados de búsqueda en ${project.name}`}>
      <div className="saurio-chat-search__scope">Buscando en este proyecto: <strong>{project.name}</strong></div>
      <div className="saurio-chat-search__filters">
        <label>Desde<input type="date" value={since} onChange={(event) => setSince(event.target.value)} /></label>
        <label>Hasta<input type="date" value={until} onChange={(event) => setUntil(event.target.value)} /></label>
        <label className="saurio-chat-search__check"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> Archivados</label>
        <button type="button" className="saurio-btn-ghost" onClick={clearFilters}>Limpiar filtros</button>
        <button type="button" className="saurio-btn-ghost" onClick={onClear}>Cancelar</button>
      </div>
      {loading && <p className="saurio-text-dim" role="status">Buscando…</p>}
      {error && <div className="saurio-banner danger" role="alert">No se pudo buscar: {error}</div>}
      {!loading && !error && result.items.length === 0 && <p className="saurio-empty">No hay chats que coincidan.</p>}
      {!loading && !error && result.items.length > 0 && <p role="status">{result.items.length} resultados en esta página</p>}
      <ul className="saurio-chat-search__results">
        {result.items.map((item) => (
          <li key={`${item.chatId}:${item.messageId ?? item.matchedAt ?? item.updatedAt}`} className="saurio-chat-search__result">
            <button type="button" onClick={() => onSelectChat(item.chatId)}>
              <span className="saurio-chat-search__result-title">{item.title || 'Chat nuevo'} {item.archived && <span className="saurio-badge">Archivado</span>}</span>
              <span className="saurio-chat-search__result-snippet">{item.snippet}</span>
              <span className="saurio-chat-search__result-meta">Actualizado {formatDate(item.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
      {(offset > 0 || result.hasMore) && (
        <div className="saurio-chat-search__pagination">
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>Anterior</button>
          <span>Página {Math.floor(offset / PAGE_SIZE) + 1}</span>
          <button type="button" disabled={!result.hasMore || loading} onClick={() => setOffset((value) => value + PAGE_SIZE)}>Siguiente</button>
        </div>
      )}
    </section>
  );
}
