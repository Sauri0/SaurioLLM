// Centro de modelos (MVP, doc 13 §10 "Instalados" + §12 "Imprescindible para el MVP"): modelos
// instalados con capabilities/tamaño/fit estimado, cargado/no cargado vía el poller único de
// ModelManager (`models:loaded`), carpeta detectada, badge LOCAL, aviso si Ollama no corre y
// avisos del modo attach (exposición en red / contexto 256K de la app de bandeja).
// apps/desktop/src/renderer/src/features/models/ModelsPanel.tsx.
//
// Pasada de diseño #6: mismo tratamiento visual que el resto de los paneles (filas con
// `.saurio-row`, badges medido/estimado/no disponible, título + acción arriba) más un estado vacío
// con guía. En modo demo (herramienta de verificación visual) no pide `models:list`/`provider:health`
// de verdad — usa lo que `demo/demoState.ts` ya sembró en `useModelsStore`, para poder capturar este
// panel sin depender de que Ollama esté corriendo en la máquina que toma la captura.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LoadedModel, MemoryEstimate, ModelInfo, ModelRef, ModelsFolderInfo, ProviderHealth, ProviderCatalogStatus } from '@saurio/shared';
import { invoke, onEvent } from '../../ipc/client.js';
import { useModelsStore } from '../../stores/modelsStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { isDemoMode } from '../../demo/demoState.js';
import { fitClassLabel, formatBytes, qualitySuffix } from './format.js';
import { CpuIcon } from '../../ui/icons.js';
import { ExploreTab } from './ExploreTab.js';
import { DownloadsTab } from './DownloadsTab.js';
import { ManualModelForm } from './ManualModelForm.js';
import { maximumContextOrFallback } from '@saurio/shared';
import { DEFAULT_MODEL_FILTERS, filterModels, hasModelFilters, localityFilterLabel, modelCostPerMillion, type ModelFilterState } from './modelFilter.js';
import { modelRefIdentity, useModelPreferencesStore } from './modelPreferencesStore.js';
import {
  INSTALLED_PAGE_SIZES, installedModelKey, installedPage, installedPageCount,
  localDetailCandidates, mapWithConcurrency, type InstalledPageSize,
} from './installedModels.js';
import './models.css';

type ModelsTab = 'installed' | 'explore' | 'downloads';

/** Ficha de ejemplo para el modo demo — mismo `models:folderInfo` que devolvería main en esta
 *  máquina (doc: "N:\OllamaModels, variable de usuario Y de máquina"), sin pedirlo de verdad. */
function demoFolderInfo(): ModelsFolderInfo {
  return {
    path: 'N:\\OllamaModels', source: 'env:user', validated: true,
    freeBytes: 480_359_034_880, totalBytes: 2_000_000_000_000, spaceQuality: 'measured',
    warnings: [
      { code: 'network_exposed', message: 'SaurioLLM no puede confirmar a qué red escucha Ollama; esto es una estimación basada en tu configuración, no una detección certera.' },
    ],
  };
}

/** Ajuste de ejemplo para el modo demo — mismo `MemoryEstimate` que devolvería `models:fits` en un
 *  equipo con esta GPU, pero sin pedirlo de verdad (no depende de Ollama). */
function demoFit(): MemoryEstimate {
  return { vramNeededBytes: 5_400_000_000, vramAvailableBytes: 8_000_000_000, fitClass: 'fits_gpu', quality: 'measured', source: 'model_compat' };
}

function capabilityChips(caps: ModelInfo['capabilities']): string {
  return (Object.entries(caps) as [keyof ModelInfo['capabilities'], boolean][])
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join(', ') || 'sin capabilities declaradas';
}

/** Aplica la preferencia de visibilidad sin sacar el modelo que está usando el chat abierto. */
export function visibleInstalledModels(
  models: ModelInfo[], hiddenIds: ReadonlySet<string>, showHidden: boolean, currentChatModelKey?: string,
): ModelInfo[] {
  return models.filter((model) => {
    const key = installedModelKey(model.ref);
    return showHidden || !hiddenIds.has(key) || key === currentChatModelKey;
  });
}

/** Pestaña "Instalados" (doc 13 §10, MVP): une proveedores, pagina el catálogo y consulta detalle
 *  y memoria únicamente para los modelos locales visibles. */
function InstalledTab(): React.JSX.Element {
  const demo = isDemoMode();
  const demoInstalled = useModelsStore((s) => s.installed);
  const demoLoaded = useModelsStore((s) => s.loaded);
  const refreshModelsStore = useModelsStore((s) => s.refresh);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loaded, setLoaded] = useState<LoadedModel[]>([]);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [detailsByKey, setDetailsByKey] = useState<Record<string, ModelInfo>>({});
  const [fitByKey, setFitByKey] = useState<Record<string, MemoryEstimate>>({});
  const [numCtxByKey, setNumCtxByKey] = useState<Record<string, number>>({});
  const [enrichmentDigestByKey, setEnrichmentDigestByKey] = useState<Record<string, string>>({});
  const requestedDetails = useRef(new Set<string>());
  const refreshRevision = useRef(0);
  const [folderInfo, setFolderInfo] = useState<ModelsFolderInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [startingOllama, setStartingOllama] = useState(false);
  const [startOllamaError, setStartOllamaError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ModelFilterState>(DEFAULT_MODEL_FILTERS);
  const [showHidden, setShowHidden] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<InstalledPageSize>(20);
  const favorites = useModelPreferencesStore((s) => s.favorites);
  const recents = useModelPreferencesStore((s) => s.recents);
  const hidden = useModelPreferencesStore((s) => s.hidden);
  const preferenceError = useModelPreferencesStore((s) => s.error);
  const loadPreferences = useModelPreferencesStore((s) => s.load);
  const toggleFavorite = useModelPreferencesStore((s) => s.toggleFavorite);
  const rememberRecent = useModelPreferencesStore((s) => s.rememberRecent);
  const toggleHidden = useModelPreferencesStore((s) => s.toggleHidden);

  // Punto 1 del feedback post-v0.1: "cuál está en uso en el chat actual", con botón "Usar en este
  // chat" (selectores por campo, no un objeto literal — bug ya documentado en doc 16 §10.3 con
  // useSyncExternalStore/React 19: un objeto nuevo en cada render nunca es `Object.is` igual).
  const currentChatId = useChatStore((s) => s.currentChatId);
  const chatsByProject = useChatStore((s) => s.chatsByProject);
  const setChatModel = useChatStore((s) => s.setChatModel);
  const currentChatModelRef = currentChatId
    ? Object.values(chatsByProject).flat().find((c) => c.id === currentChatId)?.modelRef
    : undefined;
  const currentChatModelKey = currentChatModelRef ? installedModelKey(currentChatModelRef) : undefined;
  const [usingModel, setUsingModel] = useState<string | null>(null);
  const [catalogStatuses, setCatalogStatuses] = useState<ProviderCatalogStatus[]>([]);
  const [providerLabels, setProviderLabels] = useState<Record<string, string>>({});

  const refresh = useCallback(async (force: boolean, providerId?: string) => {
    if (demo) return; // ver nota de arriba: el modo demo usa `useModelsStore`, sembrado sin IPC.
    const revision = ++refreshRevision.current;
    setLoading(true);
    setError(null);
    setHealthError(null);
    if (force) {
      requestedDetails.current.clear();
      setDetailsByKey({});
      setFitByKey({});
      setNumCtxByKey({});
      setEnrichmentDigestByKey({});
    }
    try {
      const [installedResult, loadedResult, healthResult, folderResult] = await Promise.allSettled([
        invoke('models:list', { refresh: force, providerId }),
        invoke('models:loaded', undefined),
        invoke('provider:health', undefined),
        invoke('models:folderInfo', undefined),
      ]);
      if (revision !== refreshRevision.current) return;
      if (installedResult.status === 'fulfilled') setModels(installedResult.value);
      else setError(installedResult.reason instanceof Error ? installedResult.reason.message : String(installedResult.reason));
      if (loadedResult.status === 'fulfilled') setLoaded(loadedResult.value);
      if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
      else setHealthError(healthResult.reason instanceof Error ? healthResult.reason.message : String(healthResult.reason));
      if (folderResult.status === 'fulfilled') setFolderInfo(folderResult.value);
      const [statuses, configs] = await Promise.allSettled([
        invoke('models:catalogStatus', undefined), invoke('providers:list', undefined),
      ]);
      if (revision !== refreshRevision.current) return;
      if (statuses.status === 'fulfilled') setCatalogStatuses(statuses.value);
      if (configs.status === 'fulfilled') setProviderLabels(Object.fromEntries(configs.value.map((provider) => [provider.id, provider.label || provider.id])));
    } finally {
      if (revision === refreshRevision.current) setLoading(false);
    }
  }, [demo]);

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  // Punto 3 del encargo ("modelo descargado que no aparece"): esta pestaña, a diferencia de la
  // barra lateral/cabecera/pantalla de inicio (que leen `useModelsStore`, ya suscripto a
  // `models:changed` desde `layout/Sidebar.tsx`), pide `models:list`/`models:loaded` con estado LOCAL
  // propio — sin este listener se quedaba con la lista vieja hasta reiniciar la app, aunque el modelo
  // ya hubiera terminado de descargarse (main/index.ts ahora invalida la caché de `ModelManager` y
  // emite `models:changed` apenas termina una descarga, ver ese archivo).
  useEffect(() => {
    if (demo) return;
    return onEvent('models:changed', () => void refresh(false));
  }, [demo, refresh]);

  const listedDigestByKey = useMemo(
    () => Object.fromEntries(models.map((model) => [installedModelKey(model.ref), model.digest])),
    [models],
  );
  const shownModels = useMemo(() => (
    demo ? demoInstalled : models.map((model) => {
      const key = installedModelKey(model.ref);
      return enrichmentDigestByKey[key] === model.digest ? detailsByKey[key] ?? model : model;
    })
  ), [demo, demoInstalled, models, detailsByKey, enrichmentDigestByKey]);
  const shownLoaded = demo ? demoLoaded : loaded;
  const shownHealth = demo ? [{ providerId: 'ollama', ok: true }] : health;
  const shownFitByKey = useMemo(() => (
    demo ? Object.fromEntries(shownModels.map((model) => [installedModelKey(model.ref), demoFit()])) : fitByKey
  ), [demo, shownModels, fitByKey]);
  const shownFolderInfo = demo ? demoFolderInfo() : folderInfo;
  const ollamaDown = shownHealth.some((provider) => provider.providerId === 'ollama' && !provider.ok);
  const favoriteIds = useMemo(() => new Set(favorites.map(modelRefIdentity)), [favorites]);
  const recentIds = useMemo(() => new Set(recents.map(modelRefIdentity)), [recents]);
  const hiddenIds = useMemo(() => new Set(hidden.map(modelRefIdentity)), [hidden]);
  const modelsByVisibility = useMemo(
    () => visibleInstalledModels(shownModels, hiddenIds, showHidden, currentChatModelKey),
    [shownModels, hiddenIds, showHidden, currentChatModelKey],
  );
  const filteredShownModels = useMemo(() => filterModels(modelsByVisibility, filters, { favoriteIds, recentIds }), [modelsByVisibility, filters, favoriteIds, recentIds]);
  const providerIds = useMemo(() => [...new Set(shownModels.map((model) => model.ref.providerId))].sort(), [shownModels]);
  const pageCount = installedPageCount(filteredShownModels.length, pageSize);
  const visibleModels = useMemo(
    () => installedPage(filteredShownModels, page, pageSize),
    [filteredShownModels, page, pageSize],
  );

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  useEffect(() => {
    if (demo) return;
    const candidates = localDetailCandidates(visibleModels, requestedDetails.current);
    if (candidates.length === 0) return;
    for (const model of candidates) {
      requestedDetails.current.add(`${installedModelKey(model.ref)}::${model.digest}`);
    }
    void mapWithConcurrency(candidates, 2, async (model) => {
      const key = installedModelKey(model.ref);
      const described = await invoke('models:describe', { ref: model.ref }).catch(() => model);
      const numCtx = maximumContextOrFallback(described.contextMax);
      const fit = await invoke('models:fits', { ref: model.ref, numCtx }).catch(() => undefined);
      return { key, sourceDigest: model.digest, described, numCtx, fit };
    }).then((results) => {
      setDetailsByKey((current) => ({
        ...current,
        ...Object.fromEntries(results.map((result) => [result.key, result.described])),
      }));
      setNumCtxByKey((current) => ({
        ...current,
        ...Object.fromEntries(results.map((result) => [result.key, result.numCtx])),
      }));
      setFitByKey((current) => ({
        ...current,
        ...Object.fromEntries(results.flatMap((result) => result.fit ? [[result.key, result.fit]] : [])),
      }));
      setEnrichmentDigestByKey((current) => ({
        ...current,
        ...Object.fromEntries(results.map((result) => [result.key, result.sourceDigest])),
      }));
    });
  }, [demo, visibleModels]);

  function updateFilter<K extends keyof ModelFilterState>(key: K, next: ModelFilterState[K]): void {
    setFilters((current) => ({ ...current, [key]: next }));
    setPage(1);
  }

  /** Punto 2 del feedback post-v0.1: banner con botón "Iniciar Ollama" (canal `ollama:ensureRunning`,
   *  agregado por el otro agente en paralelo en esta misma sesión — `main/ipc/ollama.ts` +
   *  `OllamaProcessManager`). Si el canal todavía no respondiera (encargo: "usá invoke tolerante y
   *  mostrá la instrucción manual"), el `catch` deja el mensaje manual en vez de romper la UI. */
  async function handleStartOllama(): Promise<void> {
    setStartingOllama(true);
    setStartOllamaError(null);
    try {
      const result = await invoke('ollama:ensureRunning', undefined);
      if (result.running) {
        await refresh(true);
      } else {
        setStartOllamaError(
          result.error === 'ollama_not_installed'
            ? 'Ollama no está instalado en este equipo — instalalo desde ollama.com/download y volvé a intentar.'
            : 'Ollama no respondió a tiempo. Probá de nuevo en unos segundos, o abrí la app de Ollama manualmente.',
        );
      }
    } catch (err) {
      // Tolerante: si el canal todavía no existe en esta build, no rompe la UI — deja la instrucción
      // manual (encargo, punto 2 del feedback).
      setStartOllamaError(
        `No se pudo pedirle a la app que inicie Ollama (${err instanceof Error ? err.message : String(err)}). ` +
        'Abrí la app de Ollama manualmente, o ejecutá "ollama serve" en una terminal.',
      );
    } finally {
      setStartingOllama(false);
    }
  }

  async function handleUseInChat(ref: ModelRef): Promise<void> {
    if (!currentChatId) return;
    setUsingModel(installedModelKey(ref));
    void rememberRecent(ref);
    try {
      await setChatModel(currentChatId, ref);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUsingModel(null);
    }
  }

  async function refreshAfterManualModelChange(): Promise<void> {
    // Ambas lecturas usan `refresh: false` y no ejecutan inferencia. Actualizamos también el store
    // porque lo comparten cabeceras y selectores; el catálogo decide si una caché vigente alcanza.
    const revision = ++refreshRevision.current;
    setLoading(true);
    const [panelResult] = await Promise.allSettled([
      invoke('models:list', { refresh: false }),
      refreshModelsStore({ refresh: false }),
    ]);
    if (revision !== refreshRevision.current) return;
    setLoading(false);
    if (panelResult.status === 'fulfilled') setModels(panelResult.value);
    else setError(`El ID manual ya se guardó, pero no se pudo actualizar la lista: ${panelResult.reason instanceof Error ? panelResult.reason.message : String(panelResult.reason)}`);
    // modelsStore muestra su propio error a los demás consumidores; no se atribuye a la escritura
    // que ya confirmó `models:updateManual`.
  }

  return (
    <div>
      <div className="saurio-panel__header">
        <strong className="saurio-panel__title">
          <CpuIcon width={16} height={16} className="saurio-models-title-icon" />
          Centro de modelos <span className="saurio-badge local">LOCAL + API</span>
        </strong>
        <button onClick={() => void refresh(true)} disabled={loading || demo}>{loading ? 'Actualizando…' : 'Actualizar'}</button>
      </div>

      {ollamaDown && !demo && (
        <div className="saurio-banner danger">
          <div>Ollama no está corriendo. Los modelos de otros proveedores siguen disponibles.</div>
          <div className="saurio-row__line">
            <button type="button" className="saurio-btn-primary" onClick={() => void handleStartOllama()} disabled={startingOllama}>
              {startingOllama ? 'Iniciando…' : 'Iniciar Ollama'}
            </button>
          </div>
          {startOllamaError && <div className="saurio-row__line saurio-row__line--muted">{startOllamaError}</div>}
        </div>
      )}
      {error && <div className="saurio-banner danger">{error}</div>}
      {healthError && <div className="saurio-banner danger">No se pudo consultar el estado de los proveedores: {healthError}</div>}
      {preferenceError && <div className="saurio-banner danger" role="alert">{preferenceError}</div>}
      {!demo && catalogStatuses.length > 0 && (
        <details className="saurio-provider-catalogs">
          <summary>Catálogos por proveedor · {catalogStatuses.filter((status) => status.state === 'stale' || status.state === 'error').length} con problemas</summary>
          {catalogStatuses.map((status) => (
            <div className="saurio-row" key={status.providerId}>
              <div className="saurio-row__header">
                <strong>{providerLabels[status.providerId] ?? status.providerId}</strong>
                <button type="button" disabled={loading} onClick={() => void refresh(true, status.providerId)}>Actualizar catálogo</button>
              </div>
              <div className="saurio-row__line">
                {status.state === 'stale' ? 'Caché anterior · sin actualizar' : status.state === 'error' ? 'Sin catálogo disponible' : status.state === 'ready' ? 'Catálogo disponible' : status.state === 'loading' ? 'Consultando…' : 'Sin consultar'}
                {' · '}{status.count} modelos
                {status.updatedAt !== undefined && <> · Última lectura: {new Date(status.updatedAt).toLocaleString('es-AR')}</>}
              </div>
              {status.error && <div className="saurio-row__line" role="status">{status.error}</div>}
            </div>
          ))}
        </details>
      )}

      {!demo && <ManualModelForm models={models} onChanged={refreshAfterManualModelChange} />}

      {/* Punto 2 del encargo / doc 13 §6, §12: carpeta OLLAMA_MODELS detectada + espacio libre.
          `ModelManager.detectedModelsFolder()`/`.attachWarnings()` ya existían (doc 16 §12 solo
          registraba la falta de canal IPC); acá se muestran sus avisos en modo lectura, sin ningún
          botón que cambie configuración de Ollama (doc 13 §6: "nunca la cambia sin autorización"). */}
      {shownFolderInfo && (
        <div className="saurio-row saurio-models-folder-row">
          <div className="saurio-row__header">
            <span className="saurio-row__title">Carpeta de modelos detectada</span>
            <span className={`saurio-badge ${shownFolderInfo.validated ? 'measured' : 'estimated'}`}>
              {shownFolderInfo.validated ? 'validada' : 'sin validar'}
            </span>
          </div>
          <div className="saurio-row__meta saurio-mono">{shownFolderInfo.path}</div>
          <div className="saurio-row__line">
            Origen: {shownFolderInfo.source === 'env:user' ? 'variable de usuario' : shownFolderInfo.source === 'env:machine' ? 'variable de máquina' : shownFolderInfo.source === 'managed' ? 'administrado por SaurioLLM' : 'predeterminado'}
            {shownFolderInfo.spaceQuality === 'measured' && shownFolderInfo.freeBytes !== undefined && shownFolderInfo.totalBytes !== undefined && (
              <> · {formatBytes(shownFolderInfo.freeBytes)} libres de {formatBytes(shownFolderInfo.totalBytes)}</>
            )}
            {shownFolderInfo.spaceQuality === 'unavailable' && <> · espacio libre no disponible</>}
          </div>
        </div>
      )}
      {(shownFolderInfo?.warnings ?? []).map((warning) => (
        <div key={warning.code} className="saurio-banner">{warning.message}</div>
      ))}
      {!shownFolderInfo && (
        <div className="saurio-banner">
          SaurioLLM usa automáticamente el máximo confirmado de cada modelo. Cuando el proveedor no
          informa ese límite, muestra un presupuesto provisional hasta poder verificarlo.
        </div>
      )}

      {shownModels.length > 0 && (
        <div className="saurio-models__filters" aria-label="Filtros de modelos instalados">
          <input type="search" value={filters.query} placeholder="Buscar nombre o proveedor…" aria-label="Buscar modelo" onChange={(event) => updateFilter('query', event.target.value)} />
          <select value={filters.locality} aria-label="Filtrar por origen" onChange={(event) => updateFilter('locality', event.target.value as ModelFilterState['locality'])}>
            {(['all', 'local', 'lan', 'cloud'] as const).map((locality) => <option key={locality} value={locality}>{localityFilterLabel(locality)}</option>)}
          </select>
          <select value={filters.providerId} aria-label="Filtrar por proveedor" onChange={(event) => updateFilter('providerId', event.target.value)}>
            <option value="all">Todos los proveedores</option>{providerIds.map((providerId) => <option key={providerId} value={providerId}>{providerId}</option>)}
          </select>
          <label><input type="checkbox" checked={filters.tools} onChange={(event) => updateFilter('tools', event.target.checked)} /> Herramientas</label>
          <label><input type="checkbox" checked={filters.vision} onChange={(event) => updateFilter('vision', event.target.checked)} /> Visión</label>
          <label><input type="checkbox" checked={filters.favoritesOnly} onChange={(event) => updateFilter('favoritesOnly', event.target.checked)} /> Favoritos</label>
          <label><input type="checkbox" checked={filters.recentsOnly} onChange={(event) => updateFilter('recentsOnly', event.target.checked)} /> Recientes</label>
          <label><input type="checkbox" checked={showHidden} onChange={(event) => { setShowHidden(event.target.checked); setPage(1); }} /> Ver ocultos ({hiddenIds.size})</label>
          <label><input type="checkbox" checked={filters.freeOnly} onChange={(event) => updateFilter('freeOnly', event.target.checked)} /> Gratis confirmado</label>
          <label>Contexto mínimo<select value={filters.minContext ?? ''} onChange={(event) => updateFilter('minContext', event.target.value ? Number(event.target.value) : undefined)}><option value="">Cualquiera</option><option value="8192">8K</option><option value="16384">16K</option><option value="32768">32K</option></select></label>
          <label>Orden<select value={filters.costOrder} aria-label="Ordenar por costo" onChange={(event) => updateFilter('costOrder', event.target.value as ModelFilterState['costOrder'])}><option value="none">Orden original</option><option value="low-to-high">Costo de entrada</option></select></label>
          <span className="saurio-models__filter-count" aria-live="polite">{filteredShownModels.length} de {modelsByVisibility.length}{!showHidden && hiddenIds.size > 0 ? ` · ${hiddenIds.size} oculto${hiddenIds.size === 1 ? '' : 's'}` : ''}</span>
          {hasModelFilters(filters) && <button type="button" className="saurio-btn-ghost" onClick={() => { setFilters(DEFAULT_MODEL_FILTERS); setPage(1); }}>Limpiar</button>}
        </div>
      )}

      {/* Punto 2 del feedback post-v0.1: "cuando Ollama no responde, no mostrar listas vacías" — con
          el banner de arriba ya explicado, no hace falta además una lista vacía confusa acá. */}
      {ollamaDown && !demo && shownModels.length === 0 ? null : shownModels.length === 0 && !loading ? (
        <div className="saurio-empty-state">
          <span className="saurio-empty-state__icon"><CpuIcon width={20} height={20} /></span>
          <span className="saurio-empty-state__title">Todavía no tenés ningún modelo instalado</span>
          <span className="saurio-empty-state__hint">
            1. Anda a la pestaña &quot;Explorar&quot; y elegí un modelo (los que dicen &quot;Perfecto&quot; o
            &quot;Muy bueno&quot; andan mejor en esta PC).<br />
            2. Apretá &quot;Descargar&quot; y esperá a que termine — después vas a poder usarlo desde acá o
            desde un chat.
          </span>
        </div>
      ) : (
        <div className="saurio-row-list">
          {filteredShownModels.length === 0 && <p className="saurio-empty">No hay modelos que coincidan con estos filtros. Probá limpiar la búsqueda.</p>}
          {filteredShownModels.length > 0 && (
            <div className="saurio-row__line">
              <button type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Anterior</button>
              <span>Página {Math.min(page, pageCount)} de {pageCount}</span>
              <button type="button" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>Siguiente</button>
              <label>Por página <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value) as InstalledPageSize); setPage(1); }}>
                {INSTALLED_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
              </select></label>
            </div>
          )}
          {visibleModels.map((model) => {
            const key = installedModelKey(model.ref);
            const isLoaded = model.ref.providerId === 'ollama' && shownLoaded.some((loadedModel) => loadedModel.name === model.ref.name);
            const isCurrentChatModel = currentChatModelKey === key;
            const isHidden = hiddenIds.has(key);
            const enrichmentIsCurrent = demo || enrichmentDigestByKey[key] === listedDigestByKey[key];
            const fit = enrichmentIsCurrent ? shownFitByKey[key] : undefined;
            const numCtxUsed = enrichmentIsCurrent ? numCtxByKey[key] ?? maximumContextOrFallback(model.contextMax) : maximumContextOrFallback(model.contextMax);
            const contextIsProvisional = !Number.isSafeInteger(model.contextMax) || (model.contextMax ?? 0) <= 0;
            return (
              <div key={key} className="saurio-row">
                <div className="saurio-row__header">
                  <strong className="saurio-mono saurio-row__title">{model.ref.name}</strong>
                  <button type="button" className="saurio-models__favorite" aria-label={favoriteIds.has(modelRefIdentity(model.ref)) ? `Quitar ${model.ref.name} de favoritos` : `Agregar ${model.ref.name} a favoritos`} aria-pressed={favoriteIds.has(modelRefIdentity(model.ref))} onClick={() => void toggleFavorite(model.ref)}>{favoriteIds.has(modelRefIdentity(model.ref)) ? '★' : '☆'}</button>
                  <span className="saurio-row__badges">
                    {isCurrentChatModel && <span className="saurio-badge measured">en uso en este chat</span>}
                    {isHidden && <span className="saurio-badge estimated">oculto</span>}
                    {model.metadataSource === 'manual' && <span className="saurio-badge estimated">ID manual</span>}
                    {model.ref.locality === 'local' && <span className={`saurio-badge ${isLoaded ? 'measured' : ''}`}>{isLoaded ? 'cargado' : 'no cargado'}</span>}
                    <span className="saurio-badge local">{model.ref.locality}</span>
                  </span>
                </div>
                <div className="saurio-row__meta">
                  {model.family} · {model.parameterSize} · {model.quantization} · {formatBytes(model.sizeBytes)}
                  {model.contextMax && ` · contexto máx ${model.contextMax.toLocaleString('es-AR')}`}
                  {(() => { const price = modelCostPerMillion(model); return ` · ${price ? `USD ${price.prompt.toFixed(2)}/1M entrada · USD ${price.completion.toFixed(2)}/1M salida` : 'precio desconocido'}`; })()}
                </div>
                <div className="saurio-row__line">Capabilities: {capabilityChips(model.capabilities)}</div>
                {model.metadataSource === 'manual' && <div className="saurio-row__line saurio-row__line--muted">ID manual · capacidades y contexto sin confirmar.</div>}
                {fit && (
                  <div className="saurio-row__line">
                    Memoria estimada con {contextIsProvisional ? 'presupuesto provisional de ' : ''}{numCtxUsed.toLocaleString('es-AR')} tokens: <strong>{fitClassLabel(fit.fitClass)}</strong>{' '}
                    <span className={`saurio-badge ${fit.quality}`}>{qualitySuffix(fit.quality)}</span>
                    {' '}({formatBytes(fit.vramNeededBytes)} de {formatBytes(fit.vramAvailableBytes)} VRAM)
                  </div>
                )}
                {/* Punto 1 del feedback post-v0.1: botón "Usar en este chat", con guía cuando no hay
                    ningún chat abierto (nunca queda sin explicación por qué está deshabilitado). */}
                {isCurrentChatModel ? (
                  <span className="saurio-row__line saurio-row__line--muted">Ya es el modelo de este chat.</span>
                ) : currentChatId ? (
                  <button type="button" className="saurio-btn-primary" disabled={usingModel === key}
                    onClick={() => void handleUseInChat(model.ref)}>
                    {usingModel === key ? 'Aplicando…' : 'Usar en este chat'}
                  </button>
                ) : (
                  <span className="saurio-row__line saurio-row__line--muted">Abrí o creá un chat para poder usarlo.</span>
                )}
                <button type="button" className="saurio-btn-ghost saurio-models__visibility-action" onClick={() => void toggleHidden(model.ref)}>
                  {isHidden ? 'Volver a mostrar' : 'Ocultar'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Barra de pestañas Instalados/Explorar/Descargas (doc 13 §10) + filtro por uso (dentro de
 *  Explorar) + badge LOCAL/LAN/NUBE (doc 13 §9, ya presente en cada tarjeta). El modo demo (captura
 *  de UI sin Ollama) solo siembra "Instalados" — Explorar/Descargas piden IPC real, así que quedan
 *  fuera de la herramienta de verificación visual (no rompen: simplemente muestran su propio estado
 *  vacío/errores si se abren en modo demo). */
export function ModelsPanel(): React.JSX.Element {
  const [tab, setTab] = useState<ModelsTab>('installed');

  return (
    <div>
      <div className="saurio-subtabs">
        <button type="button" className={`saurio-subtab ${tab === 'installed' ? 'active' : ''}`} onClick={() => setTab('installed')}>
          Instalados
        </button>
        <button type="button" className={`saurio-subtab ${tab === 'explore' ? 'active' : ''}`} onClick={() => setTab('explore')}>
          Explorar
        </button>
        <button type="button" className={`saurio-subtab ${tab === 'downloads' ? 'active' : ''}`} onClick={() => setTab('downloads')}>
          Descargas
        </button>
      </div>
      {tab === 'installed' && <InstalledTab />}
      {tab === 'explore' && <ExploreTab />}
      {tab === 'downloads' && <DownloadsTab />}
    </div>
  );
}
