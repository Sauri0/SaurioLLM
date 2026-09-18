// Pestaña "Explorar" del Centro de modelos (doc 13 §10, v0.2): catálogo curado
// (resources/model-catalog.json) con filtro por uso sugerido y el flujo de descarga/borrado del
// doc 13 §5, conectado de verdad a `models:catalog`/`models:pull`/`models:pullCancel`/`models:delete`.
// apps/desktop/src/renderer/src/features/models/ExploreTab.tsx.
import { useCallback, useEffect, useState } from 'react';
import type { CatalogItem, DownloadJob } from '@saurio/shared';
import { invoke, onEvent } from '../../ipc/client.js';
import { formatBytes } from './format.js';

type UseFilter = 'all' | 'coding' | 'chat' | 'analysis' | 'vision';

const USE_LABELS: Record<UseFilter, string> = {
  all: 'Todos', coding: 'Programación', chat: 'Conversación', analysis: 'Análisis', vision: 'Visión',
};

function capabilityBadges(entry: CatalogItem['entry']): string[] {
  const badges: string[] = [];
  if (entry.capabilities.tools) badges.push('tools');
  if (entry.capabilities.vision) badges.push('vision');
  if (entry.capabilities.thinking) badges.push('thinking');
  if (entry.capabilities.embedding) badges.push('embedding');
  return badges;
}

const STATUS_LABELS: Record<CatalogItem['status'], string> = {
  not_installed: 'no instalado',
  downloading: 'descargando…',
  installed_untested: 'instalado',
  installed_tested: 'instalado y probado',
  loaded: 'cargado',
};

export function ExploreTab(): React.JSX.Element {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [jobs, setJobs] = useState<Record<string, DownloadJob>>({});
  const [use, setUse] = useState<UseFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyModel, setBusyModel] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await invoke('models:catalog', undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // download:progress/done/failed (doc 13 §5): actualiza la ficha en vivo sin re-pedir todo el
    // catálogo en cada tick — solo el job de ese downloadId.
    const offProgress = onEvent('download:progress', (job) => setJobs((prev) => ({ ...prev, [job.id]: job })));
    const offDone = onEvent('download:done', (job) => {
      setJobs((prev) => ({ ...prev, [job.id]: job }));
      void refresh();
    });
    const offFailed = onEvent('download:failed', ({ downloadId, error: err }) => {
      setJobs((prev) => {
        const existing = prev[downloadId];
        return existing ? { ...prev, [downloadId]: { ...existing, status: 'failed', error: err } } : prev;
      });
      setError(`Descarga fallida: ${err}`);
    });
    return () => { offProgress(); offDone(); offFailed(); };
  }, [refresh]);

  const filtered = items.filter((item) => use === 'all' || item.entry.suggestedUse.includes(use));

  async function handleDownload(item: CatalogItem): Promise<void> {
    const fullName = `${item.entry.name}:${item.entry.tag}`;
    setBusyModel(fullName);
    setError(null);
    try {
      await invoke('models:pull', { name: fullName });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyModel(null);
    }
  }

  async function handleCancel(downloadId: string): Promise<void> {
    try {
      await invoke('models:pullCancel', { downloadId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(item: CatalogItem): Promise<void> {
    const fullName = `${item.entry.name}:${item.entry.tag}`;
    const gb = (item.entry.sizeBytes / 1e9).toFixed(1);
    if (!window.confirm(`¿Borrar "${fullName}"? Se liberan ~${gb} GB.`)) return;
    setBusyModel(fullName);
    setError(null);
    try {
      await invoke('models:delete', { name: fullName });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyModel(null);
    }
  }

  return (
    <div>
      <div className="saurio-filter-row">
        {(Object.keys(USE_LABELS) as UseFilter[]).map((key) => (
          <button
            key={key}
            type="button"
            className={`saurio-filter-chip ${use === key ? 'active' : ''}`}
            onClick={() => setUse(key)}
          >
            {USE_LABELS[key]}
          </button>
        ))}
        <span className="saurio-filter-row__spacer" />
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>

      {error && <div className="saurio-banner danger">{error}</div>}

      {filtered.length === 0 && !loading ? (
        <div className="saurio-empty-state">
          <span className="saurio-empty-state__title">Sin modelos en el catálogo para este filtro</span>
          <span className="saurio-empty-state__hint">
            El catálogo curado vive en <code>resources/model-catalog.json</code>; probá con otro uso o
            revisá que el archivo se haya podido leer (ver consola de main).
          </span>
        </div>
      ) : (
        <div className="saurio-row-list">
          {filtered.map((item) => {
            const fullName = `${item.entry.name}:${item.entry.tag}`;
            const job = item.downloadId ? jobs[item.downloadId] : undefined;
            const pct = job && job.totalBytes > 0 ? Math.round((job.completedBytes / job.totalBytes) * 100) : 0;
            const isBusy = busyModel === fullName;
            return (
              <div key={fullName} className="saurio-row">
                <div className="saurio-row__header">
                  <strong className="saurio-mono saurio-row__title">{fullName}</strong>
                  <span className="saurio-row__badges">
                    <span className="saurio-badge local">LOCAL</span>
                    <span className="saurio-badge">{STATUS_LABELS[item.status]}</span>
                  </span>
                </div>
                <div className="saurio-row__meta">
                  {formatBytes(item.entry.sizeBytes)} · contexto máx {item.entry.contextMax.toLocaleString('es-AR')}
                  {item.entry.quantization && ` · ${item.entry.quantization}`}
                </div>
                <div className="saurio-row__line">
                  Capabilities: {capabilityBadges(item.entry).join(', ') || 'sin capabilities declaradas'}
                </div>
                {item.entry.notes && <div className="saurio-row__line saurio-row__line--muted">{item.entry.notes}</div>}

                {item.status === 'downloading' && job && (
                  <>
                    <div className="saurio-progress">
                      <div className={`saurio-progress__fill ${job.status}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="saurio-row__line">
                      {pct}% · {formatBytes(job.bytesPerSec ?? 0)}/s
                      {job.etaMs !== undefined && ` · ETA ${Math.ceil(job.etaMs / 1000)}s`}
                      <button type="button" onClick={() => void handleCancel(item.downloadId!)} className="saurio-inline-action">
                        Cancelar
                      </button>
                    </div>
                  </>
                )}

                {item.status === 'not_installed' && (
                  <button type="button" className="saurio-btn-primary" disabled={isBusy} onClick={() => void handleDownload(item)}>
                    {isBusy ? 'Iniciando…' : 'Descargar'}
                  </button>
                )}
                {(item.status === 'installed_untested' || item.status === 'installed_tested') && (
                  <button type="button" disabled={isBusy} onClick={() => void handleDelete(item)}>
                    {isBusy ? 'Borrando…' : 'Eliminar'}
                  </button>
                )}
                {item.status === 'loaded' && (
                  <span className="saurio-row__line saurio-row__line--muted">
                    Cargado ahora mismo — descargalo/liberalo desde el chat antes de borrarlo.
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
