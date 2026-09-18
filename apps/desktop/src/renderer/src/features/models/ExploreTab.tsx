// Pestaña "Explorar" del Centro de modelos (doc 13 §10, v0.2 + doc 16 §12.6 "cobertura máxima del
// catálogo", puntos 1-5 del encargo): biblioteca completa de Ollama (curado + snapshot fusionados,
// caché 24h + botón "Actualizar catálogo"), búsqueda de Hugging Face GGUF, "descargar por nombre"
// libre, y una ficha lateral con variantes + selector de contexto 4k/8k/16k/32k.
// apps/desktop/src/renderer/src/features/models/ExploreTab.tsx.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CatalogItem, DownloadJob, HuggingFaceGgufFile, HuggingFaceSearchResult, LibraryCatalogSource,
  ModelRef, ModelTier, ResolveModelByNameResult,
} from '@saurio/shared';
import { invoke, onEvent } from '../../ipc/client.js';
import { formatBytes } from './format.js';
import { useChatStore } from '../../stores/chatStore.js';
import { useProjectStore } from '../../stores/projectStore.js';
import {
  DEFAULT_EXPLORE_FILTERS, DEFAULT_NUM_CTX_OPTION, NUM_CTX_OPTIONS, SIZE_BUCKET_LABELS,
  filterCatalogItems, groupByFamily, paginate, sortCatalogItems,
  type ExploreFilters, type ExploreSizeBucket, type ExploreSortMode, type ExploreTierFilter,
  type ExploreUseFilter, type NumCtxOption,
} from './exploreLogic.js';

const PAGE_SIZE = 30;

type SourceMode = 'ollama' | 'huggingface';

const USE_LABELS: Record<ExploreUseFilter, string> = {
  all: 'Todos', coding: 'Programación', chat: 'Conversación', analysis: 'Análisis', vision: 'Visión',
};
const SORT_LABELS: Record<ExploreSortMode, string> = {
  recommended: 'Recomendado para tu PC', name: 'Nombre', size: 'Tamaño',
};
const SOURCE_LABELS: Record<LibraryCatalogSource, string> = {
  network: 'sincronizado ahora', cache: 'en caché', bundled: 'incluido con la app (sin conexión)',
};

/** Leyenda en español simple de los seis niveles (feedback real post-v0.1: "textos simples para
 *  gente no técnica... qué significa cada nivel de la escala") — mismo orden/color que
 *  `TierClassifier` (`packages/runtime/src/models/TierClassifier.ts`), pero sin jerga técnica
 *  (nada de "VRAM"/"fitClass" acá; eso ya lo trae `tier.explanation` por ítem). */
const TIER_LEGEND: { level: 1 | 2 | 3 | 4 | 5 | 6; color: string; short: string; meaning: string }[] = [
  { level: 1, color: 'green', short: 'Perfecto', meaning: 'Anda rápido, entra sobrado en tu placa de video.' },
  { level: 2, color: 'teal', short: 'Muy bueno', meaning: 'Anda bien, entra justo en tu placa de video.' },
  { level: 3, color: 'yellow', short: 'Usable', meaning: 'Anda a velocidad aceptable, usando algo de RAM además de la placa.' },
  { level: 4, color: 'orange', short: 'Al límite', meaning: 'Va a andar lento; elegilo solo si te importa más la calidad que la velocidad.' },
  { level: 5, color: 'red', short: 'Solo CPU', meaning: 'Muy lento: tu PC lo correría casi sin ayuda de la placa de video.' },
  { level: 6, color: 'gray', short: 'No recomendado', meaning: 'No entra en esta PC (ni con toda la RAM) o no hay espacio en disco.' },
];

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

function TierBadge({ tier }: { tier: ModelTier | undefined }): React.JSX.Element | null {
  if (!tier) return null;
  return (
    <span className={`saurio-tier-badge ${tier.color}`} title={tier.quality === 'measured' ? 'Probado en este equipo' : 'Estimado'}>
      {tier.level} · {tier.label}
    </span>
  );
}

export function ExploreTab(): React.JSX.Element {
  const [sourceMode, setSourceMode] = useState<SourceMode>('ollama');
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [librarySource, setLibrarySource] = useState<LibraryCatalogSource | null>(null);
  const [cachedAt, setCachedAt] = useState<number | undefined>(undefined);
  const [jobs, setJobs] = useState<Record<string, DownloadJob>>({});
  const [filters, setFilters] = useState<ExploreFilters>(DEFAULT_EXPLORE_FILTERS);
  const [sortMode, setSortMode] = useState<ExploreSortMode>('recommended');
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [justDownloaded, setJustDownloaded] = useState<Set<string>>(new Set());
  const [freeDiskBytes, setFreeDiskBytes] = useState<number | undefined>(undefined);
  const [selectedFamily, setSelectedFamily] = useState<string | null>(null);

  const currentChatId = useChatStore((s) => s.currentChatId);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const setChatModel = useChatStore((s) => s.setChatModel);
  const setDraftModelRef = useChatStore((s) => s.setDraftModelRef);

  const refresh = useCallback(async (forceRefresh = false) => {
    if (forceRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const result = await invoke('models:libraryCatalog', { forceRefresh });
      setItems(result.items);
      setLibrarySource(result.source);
      setCachedAt(result.cachedAt);
      setPage(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
    invoke('models:folderInfo', undefined)
      .then((info) => setFreeDiskBytes(info.spaceQuality === 'measured' ? info.freeBytes : undefined))
      .catch(() => setFreeDiskBytes(undefined));
    const offProgress = onEvent('download:progress', (job) => setJobs((prev) => ({ ...prev, [job.id]: job })));
    const offDone = onEvent('download:done', (job) => {
      setJobs((prev) => ({ ...prev, [job.id]: job }));
      setJustDownloaded((prev) => new Set(prev).add(job.modelName));
      void refresh(false);
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

  const filtered = useMemo(() => filterCatalogItems(items, filters), [items, filters]);
  const sorted = useMemo(() => sortCatalogItems(filtered, sortMode), [filtered, sortMode]);
  const pageResult = useMemo(() => paginate(sorted, page, PAGE_SIZE), [sorted, page]);

  async function handleUseModel(fullName: string): Promise<void> {
    const ref: ModelRef = { providerId: 'ollama', name: fullName, locality: 'local' };
    try {
      if (currentChatId) await setChatModel(currentChatId, ref);
      else if (currentProjectId) setDraftModelRef(currentProjectId, ref);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDownload(item: CatalogItem): Promise<void> {
    const fullName = `${item.entry.name}:${item.entry.tag}`;
    setBusyModel(fullName);
    setError(null);
    try {
      await invoke('models:pull', { name: fullName });
      await refresh(false);
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
      await refresh(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyModel(null);
    }
  }

  const selectedGroup = useMemo(
    () => (selectedFamily ? groupByFamily(items.filter((i) => i.entry.name === selectedFamily))[0] : undefined),
    [items, selectedFamily],
  );

  return (
    <div className="saurio-explore">
      {/* Punto 3 del feedback post-v0.1: "qué significa cada nivel de la escala", en texto simple. */}
      <div className="saurio-tier-legend">
        {TIER_LEGEND.map((row) => (
          <div key={row.level} className="saurio-tier-legend__row">
            <span className={`saurio-tier-badge ${row.color}`}>{row.level} · {row.short}</span>
            <span>{row.meaning}</span>
          </div>
        ))}
      </div>

      <DownloadByNameSection onDownloaded={() => void refresh(false)} />

      <div className="saurio-subtabs saurio-explore__source-tabs">
        <button type="button" className={`saurio-subtab ${sourceMode === 'ollama' ? 'active' : ''}`} onClick={() => setSourceMode('ollama')}>
          Biblioteca de Ollama
        </button>
        <button type="button" className={`saurio-subtab ${sourceMode === 'huggingface' ? 'active' : ''}`} onClick={() => setSourceMode('huggingface')}>
          Hugging Face
        </button>
      </div>

      {sourceMode === 'huggingface' ? (
        <HuggingFaceSection onDownloaded={() => void refresh(false)} freeDiskBytes={freeDiskBytes} />
      ) : (
        <>
          <div className="saurio-filter-row">
            <input
              type="search"
              placeholder="Buscar por nombre…"
              value={filters.search}
              onChange={(e) => { setFilters((f) => ({ ...f, search: e.target.value })); setPage(1); }}
              className="saurio-explore__search"
            />
            {(Object.keys(USE_LABELS) as ExploreUseFilter[]).map((key) => (
              <button
                key={key}
                type="button"
                className={`saurio-filter-chip ${filters.use === key ? 'active' : ''}`}
                onClick={() => { setFilters((f) => ({ ...f, use: key })); setPage(1); }}
              >
                {USE_LABELS[key]}
              </button>
            ))}
            <select
              value={filters.tierLevel === 'all' ? 'all' : String(filters.tierLevel)}
              onChange={(e) => {
                const v = e.target.value;
                setFilters((f) => ({ ...f, tierLevel: v === 'all' ? 'all' : (Number(v) as ExploreTierFilter) }));
                setPage(1);
              }}
              aria-label="Filtrar por nivel de la escala"
            >
              <option value="all">Cualquier nivel</option>
              {TIER_LEGEND.map((row) => <option key={row.level} value={row.level}>{row.level} · {row.short}</option>)}
            </select>
            <select
              value={filters.sizeBucket}
              onChange={(e) => { setFilters((f) => ({ ...f, sizeBucket: e.target.value as ExploreSizeBucket })); setPage(1); }}
              aria-label="Filtrar por tamaño"
            >
              <option value="all">Cualquier tamaño</option>
              {(Object.keys(SIZE_BUCKET_LABELS) as (keyof typeof SIZE_BUCKET_LABELS)[]).map((key) => (
                <option key={key} value={key}>{SIZE_BUCKET_LABELS[key]}</option>
              ))}
            </select>
            <select value={sortMode} onChange={(e) => setSortMode(e.target.value as ExploreSortMode)} aria-label="Ordenar por">
              {(Object.keys(SORT_LABELS) as ExploreSortMode[]).map((key) => <option key={key} value={key}>Orden: {SORT_LABELS[key]}</option>)}
            </select>
            <span className="saurio-filter-row__spacer" />
            {freeDiskBytes !== undefined && (
              <span className="saurio-row__line--muted">Espacio libre: {formatBytes(freeDiskBytes)}</span>
            )}
            <button type="button" onClick={() => void refresh(true)} disabled={loading || refreshing}>
              {refreshing ? 'Actualizando catálogo…' : 'Actualizar catálogo'}
            </button>
          </div>

          {librarySource && (
            <div className="saurio-row__line--muted saurio-explore__source-note">
              Catálogo {SOURCE_LABELS[librarySource]}
              {cachedAt !== undefined && ` (${new Date(cachedAt).toLocaleString('es-AR')})`}
              {' '}· {items.length.toLocaleString('es-AR')} variantes en {new Set(items.map((i) => i.entry.name)).size} familias.
            </div>
          )}

          {error && <div className="saurio-banner danger">{error}</div>}

          {pageResult.total === 0 && !loading ? (
            <div className="saurio-empty-state">
              <span className="saurio-empty-state__title">Sin modelos para este filtro</span>
              <span className="saurio-empty-state__hint">Probá con otro uso, nivel o tamaño, o limpiá la búsqueda.</span>
            </div>
          ) : (
            <>
              <div className="saurio-row-list">
                {pageResult.pageItems.map((item) => {
                  const fullName = `${item.entry.name}:${item.entry.tag}`;
                  const job = item.downloadId ? jobs[item.downloadId] : undefined;
                  const pct = job && job.totalBytes > 0 ? Math.round((job.completedBytes / job.totalBytes) * 100) : 0;
                  const isBusy = busyModel === fullName;
                  return (
                    <div key={fullName} className="saurio-row">
                      <div className="saurio-row__header">
                        <button type="button" className="saurio-row__title-btn" onClick={() => setSelectedFamily(item.entry.name)}>
                          <strong className="saurio-mono saurio-row__title">{fullName}</strong>
                        </button>
                        <span className="saurio-row__badges">
                          <TierBadge tier={item.tier} />
                          <span className="saurio-badge local">LOCAL</span>
                          <span className="saurio-badge">{STATUS_LABELS[item.status]}</span>
                        </span>
                      </div>
                      <div className="saurio-row__meta">
                        Descarga: {formatBytes(item.entry.sizeBytes)} · contexto máx {item.entry.contextMax.toLocaleString('es-AR')}
                        {item.entry.quantization && ` · ${item.entry.quantization}`}
                      </div>
                      {item.tier && <div className="saurio-row__line">{item.tier.explanation}</div>}
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

                      <div className="saurio-row__actions">
                        <button type="button" onClick={() => setSelectedFamily(item.entry.name)}>Ver variantes</button>
                        {item.status === 'not_installed' && (
                          <button type="button" className="saurio-btn-primary" disabled={isBusy} onClick={() => void handleDownload(item)}>
                            {isBusy ? 'Iniciando…' : 'Descargar'}
                          </button>
                        )}
                        {(item.status === 'installed_untested' || item.status === 'installed_tested') && (
                          <>
                            <button type="button" className="saurio-btn-primary" onClick={() => void handleUseModel(fullName)}>
                              Usar este modelo
                            </button>
                            <button type="button" disabled={isBusy} onClick={() => void handleDelete(item)}>
                              {isBusy ? 'Borrando…' : 'Eliminar'}
                            </button>
                            {justDownloaded.has(fullName) && (
                              <span className="saurio-row__line saurio-row__line--muted">Descarga completa.</span>
                            )}
                          </>
                        )}
                        {item.status === 'loaded' && (
                          <span className="saurio-row__line saurio-row__line--muted">
                            Cargado ahora mismo — descargalo/liberalo desde el chat antes de borrarlo.
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="saurio-explore__pagination">
                <button type="button" disabled={pageResult.page <= 1} onClick={() => setPage((p) => p - 1)}>« Anterior</button>
                <span className="saurio-row__line--muted">
                  Página {pageResult.page} de {pageResult.pageCount} ({pageResult.total.toLocaleString('es-AR')} modelos)
                </span>
                <button type="button" disabled={pageResult.page >= pageResult.pageCount} onClick={() => setPage((p) => p + 1)}>Siguiente »</button>
              </div>
            </>
          )}
        </>
      )}

      {selectedGroup && (
        <VariantSidePanel
          group={selectedGroup}
          freeDiskBytes={freeDiskBytes}
          jobs={jobs}
          onClose={() => setSelectedFamily(null)}
          onDownload={handleDownload}
          onCancel={handleCancel}
          onDelete={handleDelete}
          onUse={handleUseModel}
          busyModel={busyModel}
        />
      )}
    </div>
  );
}

/** Ficha lateral con variantes de una familia (punto 5 del encargo: "ficha lateral con variantes,
 *  selector de contexto 4k/8k/16k/32k que recalcula memoria y nivel"). */
function VariantSidePanel(props: {
  group: { name: string; variants: CatalogItem[] };
  freeDiskBytes: number | undefined;
  jobs: Record<string, DownloadJob>;
  onClose: () => void;
  onDownload: (item: CatalogItem) => Promise<void>;
  onCancel: (downloadId: string) => Promise<void>;
  onDelete: (item: CatalogItem) => Promise<void>;
  onUse: (fullName: string) => Promise<void>;
  busyModel: string | null;
}): React.JSX.Element {
  const { group, freeDiskBytes, jobs, onClose, onDownload, onCancel, onDelete, onUse, busyModel } = props;
  const [selectedTag, setSelectedTag] = useState(group.variants[0]?.entry.tag);
  const [numCtx, setNumCtx] = useState<NumCtxOption>(DEFAULT_NUM_CTX_OPTION);
  const [liveTier, setLiveTier] = useState<ModelTier | undefined>(undefined);
  const [tierLoading, setTierLoading] = useState(false);

  const selected = group.variants.find((v) => v.entry.tag === selectedTag) ?? group.variants[0];

  useEffect(() => {
    setSelectedTag(group.variants[0]?.entry.tag);
  }, [group]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setTierLoading(true);
    invoke('models:tierForSize', { sizeBytes: selected.entry.sizeBytes, numCtx })
      .then((tier) => { if (!cancelled) setLiveTier(tier); })
      .catch(() => { if (!cancelled) setLiveTier(undefined); })
      .finally(() => { if (!cancelled) setTierLoading(false); });
    return () => { cancelled = true; };
  }, [selected, numCtx]);

  if (!selected) return <></>;
  const fullName = `${selected.entry.name}:${selected.entry.tag}`;
  const job = selected.downloadId ? jobs[selected.downloadId] : undefined;
  const isBusy = busyModel === fullName;

  return (
    <aside className="saurio-side-panel">
      <div className="saurio-side-panel__header">
        <strong>{group.name}</strong>
        <button type="button" onClick={onClose} aria-label="Cerrar ficha">✕</button>
      </div>

      <div className="saurio-side-panel__variants">
        {group.variants.map((v) => (
          <button
            key={v.entry.tag}
            type="button"
            className={`saurio-filter-chip ${v.entry.tag === selectedTag ? 'active' : ''}`}
            onClick={() => setSelectedTag(v.entry.tag)}
          >
            {v.entry.tag} · {formatBytes(v.entry.sizeBytes)}
          </button>
        ))}
      </div>

      <div className="saurio-row__header">
        <strong className="saurio-mono">{fullName}</strong>
        <TierBadge tier={liveTier ?? selected.tier} />
      </div>
      <div className="saurio-row__meta">
        {formatBytes(selected.entry.sizeBytes)} · contexto máx {selected.entry.contextMax.toLocaleString('es-AR')}
        {selected.entry.quantization && ` · ${selected.entry.quantization}`}
      </div>
      <div className="saurio-row__line">
        Capabilities: {capabilityBadges(selected.entry).join(', ') || 'sin capabilities declaradas'}
      </div>

      <div className="saurio-side-panel__ctx">
        <span>Contexto a usar: </span>
        {NUM_CTX_OPTIONS.map((ctx) => (
          <button
            key={ctx}
            type="button"
            className={`saurio-filter-chip ${ctx === numCtx ? 'active' : ''}`}
            onClick={() => setNumCtx(ctx)}
          >
            {ctx >= 1024 ? `${ctx / 1024}k` : ctx}
          </button>
        ))}
      </div>
      {tierLoading && <div className="saurio-row__line--muted">Recalculando…</div>}
      {liveTier && <div className="saurio-row__line">{liveTier.explanation}</div>}

      {freeDiskBytes !== undefined && (
        <div className="saurio-row__line--muted">Espacio libre en disco: {formatBytes(freeDiskBytes)}</div>
      )}

      {selected.status === 'downloading' && job && (
        <div className="saurio-row__line">
          {job.totalBytes > 0 ? Math.round((job.completedBytes / job.totalBytes) * 100) : 0}% · {formatBytes(job.bytesPerSec ?? 0)}/s
          <button type="button" className="saurio-inline-action" onClick={() => void onCancel(selected.downloadId!)}>Cancelar</button>
        </div>
      )}
      {selected.status === 'not_installed' && (
        <button type="button" className="saurio-btn-primary" disabled={isBusy} onClick={() => void onDownload(selected)}>
          {isBusy ? 'Iniciando…' : 'Descargar'}
        </button>
      )}
      {(selected.status === 'installed_untested' || selected.status === 'installed_tested') && (
        <>
          <button type="button" className="saurio-btn-primary" onClick={() => void onUse(fullName)}>Usar este modelo</button>
          <button type="button" disabled={isBusy} onClick={() => void onDelete(selected)}>{isBusy ? 'Borrando…' : 'Eliminar'}</button>
        </>
      )}
    </aside>
  );
}

/** "Descargar por nombre" (punto 4 del encargo): campo libre que valida contra el registry de Ollama o
 *  contra hf.co/<usuario>/<repo>:<quant>, muestra tamaño/espacio/nivel, y descarga. */
function DownloadByNameSection({ onDownloaded }: { onDownloaded: () => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [result, setResult] = useState<ResolveModelByNameResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleValidate(): Promise<void> {
    if (name.trim().length === 0) return;
    setValidating(true);
    setError(null);
    setResult(null);
    try {
      setResult(await invoke('models:resolveByName', { name: name.trim() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  }

  async function handleDownload(): Promise<void> {
    if (!result) return;
    setDownloading(true);
    setError(null);
    try {
      if (result.source === 'huggingface') {
        await invoke('models:pullExternal', { ref: result.fullName, sizeBytes: result.sizeBytes });
      } else {
        await invoke('models:pull', { name: result.fullName });
      }
      onDownloaded();
      setResult(null);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="saurio-row saurio-explore__by-name">
      <div className="saurio-row__header"><strong className="saurio-row__title">Descargar por nombre</strong></div>
      <div className="saurio-row__line--muted">
        Nombre de Ollama (ej. <code>qwen3:8b</code>) o de Hugging Face (<code>hf.co/usuario/repo:CUANT</code>).
      </div>
      <div className="saurio-explore__by-name-row">
        <input
          type="text"
          placeholder="qwen3:8b o hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M"
          value={name}
          onChange={(e) => { setName(e.target.value); setResult(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleValidate(); }}
          className="saurio-explore__by-name-input"
        />
        <button type="button" disabled={validating || name.trim().length === 0} onClick={() => void handleValidate()}>
          {validating ? 'Validando…' : 'Validar'}
        </button>
      </div>
      {error && <div className="saurio-banner danger">{error}</div>}
      {result && (
        <div className="saurio-row__line">
          <span className="saurio-mono">{result.fullName}</span> · {formatBytes(result.sizeBytes)} · fuente: {result.source === 'ollama' ? 'Ollama' : 'Hugging Face'}
          {' '}<TierBadge tier={result.tier} />
          {!result.spaceOk && <span className="saurio-row__line--danger"> — no hay espacio suficiente en disco</span>}
          <div>
            <button type="button" className="saurio-btn-primary" disabled={downloading || !result.spaceOk} onClick={() => void handleDownload()}>
              {downloading ? 'Iniciando…' : 'Descargar'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Búsqueda de Hugging Face GGUF (punto 3 del encargo). */
function HuggingFaceSection({ onDownloaded, freeDiskBytes }: { onDownloaded: () => void; freeDiskBytes: number | undefined }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HuggingFaceSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [files, setFiles] = useState<HuggingFaceGgufFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [selectedQuant, setSelectedQuant] = useState<string | null>(null);
  const [tier, setTier] = useState<ModelTier | undefined>(undefined);
  const [downloading, setDownloading] = useState(false);

  async function handleSearch(): Promise<void> {
    if (query.trim().length === 0) return;
    setSearching(true);
    setError(null);
    setSelectedRepo(null);
    setFiles([]);
    try {
      setResults(await invoke('models:hfSearch', { query: query.trim() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  async function handleSelectRepo(repoId: string): Promise<void> {
    setSelectedRepo(repoId);
    setFiles([]);
    setSelectedQuant(null);
    setTier(undefined);
    setFilesLoading(true);
    setError(null);
    try {
      setFiles(await invoke('models:hfFiles', { modelId: repoId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFilesLoading(false);
    }
  }

  async function handleSelectQuant(file: HuggingFaceGgufFile): Promise<void> {
    setSelectedQuant(file.quant ?? file.filename);
    setTier(undefined);
    if (file.sizeBytes === undefined) return;
    try {
      setTier(await invoke('models:tierForSize', { sizeBytes: file.sizeBytes, numCtx: DEFAULT_NUM_CTX_OPTION }));
    } catch {
      setTier(undefined);
    }
  }

  async function handleDownload(): Promise<void> {
    const file = files.find((f) => (f.quant ?? f.filename) === selectedQuant);
    if (!selectedRepo || !file || !file.quant || file.sizeBytes === undefined) return;
    setDownloading(true);
    setError(null);
    try {
      const ref = `hf.co/${selectedRepo}:${file.quant}`;
      await invoke('models:pullExternal', { ref, sizeBytes: file.sizeBytes });
      onDownloaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  const selectedFile = files.find((f) => (f.quant ?? f.filename) === selectedQuant);

  return (
    <div className="saurio-explore__hf">
      <div className="saurio-explore__by-name-row">
        <input
          type="search"
          placeholder="Buscar en Hugging Face (ej. qwen coder gguf)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
          className="saurio-explore__search"
        />
        <button type="button" disabled={searching || query.trim().length === 0} onClick={() => void handleSearch()}>
          {searching ? 'Buscando…' : 'Buscar'}
        </button>
      </div>
      {error && <div className="saurio-banner danger">{error}</div>}
      {results.length === 0 && !searching && (
        <div className="saurio-row__line--muted">Buscá un modelo GGUF en Hugging Face por texto libre.</div>
      )}
      <div className="saurio-row-list">
        {results.map((r) => (
          <div key={r.id} className={`saurio-row ${selectedRepo === r.id ? 'saurio-row--selected' : ''}`}>
            <div className="saurio-row__header">
              <button type="button" className="saurio-row__title-btn" onClick={() => void handleSelectRepo(r.id)}>
                <strong className="saurio-mono saurio-row__title">{r.id}</strong>
              </button>
              <span className="saurio-row__badges">
                <span className="saurio-badge">{r.downloads.toLocaleString('es-AR')} descargas</span>
                <span className="saurio-badge">{r.likes.toLocaleString('es-AR')} likes</span>
              </span>
            </div>
            <div className="saurio-row__line--muted">{r.tags.slice(0, 8).join(', ')}</div>

            {selectedRepo === r.id && (
              <div className="saurio-explore__hf-files">
                {filesLoading && <div className="saurio-row__line--muted">Cargando archivos .gguf…</div>}
                {!filesLoading && files.length === 0 && <div className="saurio-row__line--muted">Este repo no tiene archivos .gguf.</div>}
                <div className="saurio-side-panel__variants">
                  {files.map((f) => (
                    <button
                      key={f.filename}
                      type="button"
                      className={`saurio-filter-chip ${(f.quant ?? f.filename) === selectedQuant ? 'active' : ''}`}
                      onClick={() => void handleSelectQuant(f)}
                    >
                      {f.quant ?? f.filename}{f.sizeBytes !== undefined && ` · ${formatBytes(f.sizeBytes)}`}
                    </button>
                  ))}
                </div>
                {selectedFile && (
                  <div className="saurio-row__line">
                    <span className="saurio-mono">hf.co/{r.id}:{selectedFile.quant ?? '?'}</span>
                    {selectedFile.sizeBytes !== undefined && ` · ${formatBytes(selectedFile.sizeBytes)}`}
                    {' '}<TierBadge tier={tier} />
                    {freeDiskBytes !== undefined && ` · espacio libre: ${formatBytes(freeDiskBytes)}`}
                    <div>
                      <button
                        type="button" className="saurio-btn-primary"
                        disabled={downloading || !selectedFile.quant || selectedFile.sizeBytes === undefined}
                        onClick={() => void handleDownload()}
                      >
                        {downloading ? 'Iniciando…' : 'Descargar'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
