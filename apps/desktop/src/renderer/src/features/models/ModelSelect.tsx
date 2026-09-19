import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ModelInfo, ModelRef, ProviderConfig } from '@saurio/shared';
import { localityLabel } from './locality.js';
import { useUiNavStore } from '../../stores/uiNavStore.js';
import {
  DEFAULT_MODEL_FILTERS, filterModels, hasModelFilters, localityFilterLabel, modelIdentity,
  type ModelFilterState, modelCostPerMillion,
} from './modelFilter.js';
import { modelRefIdentity, useModelPreferencesStore } from './modelPreferencesStore.js';
import './modelSelect.css';

const PAGE_SIZE = 100;

function providerLabel(providerId: string, providers: ProviderConfig[]): string {
  return providers.find((provider) => provider.id === providerId)?.label ?? providerId;
}

export type ModelSelectEngineState = 'ready' | 'starting' | 'down';

export interface ModelSelectProps {
  models: ModelInfo[];
  providers: ProviderConfig[];
  value: ModelRef | undefined;
  onChange: (ref: ModelRef) => void;
  disabled?: boolean;
  title?: string;
  engineState?: ModelSelectEngineState;
  onStartEngine?: () => void;
  startEngineError?: string;
  /** Permite que un diálogo padre no interprete Escape como cierre propio mientras el popover está abierto. */
  onPopoverOpenChange?: (open: boolean) => void;
}

export function ModelSelect({
  models, providers, value, onChange, disabled, title, engineState, onStartEngine, startEngineError, onPopoverOpenChange,
}: ModelSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<ModelFilterState>(DEFAULT_MODEL_FILTERS);
  const [page, setPage] = useState(0);
  const listId = `saurio-model-select-list-${useId()}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedKey = value ? modelIdentity({ ref: value }) : '';
  const favorites = useModelPreferencesStore((s) => s.favorites);
  const recents = useModelPreferencesStore((s) => s.recents);
  const hidden = useModelPreferencesStore((s) => s.hidden);
  const preferenceError = useModelPreferencesStore((s) => s.error);
  const loadPreferences = useModelPreferencesStore((s) => s.load);
  const toggleFavorite = useModelPreferencesStore((s) => s.toggleFavorite);
  const rememberRecent = useModelPreferencesStore((s) => s.rememberRecent);
  const favoriteIds = useMemo(() => new Set(favorites.map(modelRefIdentity)), [favorites]);
  const recentIds = useMemo(() => new Set(recents.map(modelRefIdentity)), [recents]);
  const hiddenIds = useMemo(() => new Set(hidden.map(modelRefIdentity)), [hidden]);
  // Ocultar sólo afecta las opciones elegibles. Si el chat ya usa uno oculto, queda como la fila
  // seleccionada para que su identidad siga siendo explícita y no cambie el historial del chat.
  const selectableModels = useMemo(() => models.filter((model) => !hiddenIds.has(modelIdentity(model))), [models, hiddenIds]);
  const filteredModels = useMemo(() => filterModels(selectableModels, filters, { favoriteIds, recentIds }), [selectableModels, filters, favoriteIds, recentIds]);
  const selectedIsKnown = value ? models.some((model) => modelIdentity(model) === selectedKey) : true;
  const visibleModels = filteredModels.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selectedModel = useMemo(() => {
    if (!value) return undefined;
    const known = models.find((model) => modelIdentity(model) === selectedKey);
    if (known && visibleModels.some((model) => modelIdentity(model) === selectedKey)) return undefined;
    return known ?? { ref: value, digest: '', sizeBytes: 0, family: '', parameterSize: '', quantization: '', capabilities: { tools: false, thinking: false, vision: false, embedding: false } };
  }, [models, selectedKey, value, visibleModels]);
  // La opción activa es independiente del modelo seleccionado: así las flechas pueden recorrer la
  // lista sin cambiar el chat hasta confirmar con Enter. El seleccionado fuera de la página queda
  // primero como antes, pero sigue entrando al mismo recorrido de teclado.
  const optionModels = useMemo(
    () => selectedModel ? [selectedModel, ...visibleModels] : visibleModels,
    [selectedModel, visibleModels],
  );
  const selectedOptionIndex = optionModels.findIndex((model) => modelIdentity(model) === selectedKey);
  const [activeModelKey, setActiveModelKey] = useState<string | undefined>();
  const activeOptionIndex = optionModels.findIndex((model) => modelIdentity(model) === activeModelKey);
  // Al filtrar, la fila seleccionada puede quedar arriba como referencia "No disponible". La
  // opción activa debe empezar en una coincidencia real para que Enter no descarte el término que
  // la persona acaba de buscar.
  const firstVisibleOptionIndex = selectedModel && visibleModels.length > 0 ? 1 : 0;
  const defaultActiveIndex = hasModelFilters(filters) && visibleModels.length > 0
    ? firstVisibleOptionIndex
    : selectedOptionIndex >= 0 ? selectedOptionIndex : 0;
  const resolvedActiveIndex = optionModels.length === 0
    ? -1
    : activeOptionIndex >= 0 ? activeOptionIndex : defaultActiveIndex;
  const activeModel = resolvedActiveIndex >= 0 ? optionModels[resolvedActiveIndex] : undefined;
  const activeOptionId = activeModel ? `${listId}-option-${resolvedActiveIndex}` : undefined;
  const pageCount = Math.max(1, Math.ceil(filteredModels.length / PAGE_SIZE));
  const providerIds = useMemo(
    () => [...new Set([...providers.map((provider) => provider.id), ...models.map((model) => model.ref.providerId)])].sort(),
    [models, providers],
  );

  const setPopoverOpen = useCallback((next: boolean, preferredIndex?: number): void => {
    if (next) {
      const fallbackIndex = preferredIndex === undefined
        ? defaultActiveIndex
        : Math.max(0, Math.min(preferredIndex, optionModels.length - 1));
      setActiveModelKey(optionModels[fallbackIndex] ? modelIdentity(optionModels[fallbackIndex]) : undefined);
    }
    setOpen(next);
    onPopoverOpenChange?.(next);
  }, [onPopoverOpenChange, optionModels, defaultActiveIndex]);

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  // Si el padre desmonta el selector (por ejemplo, Fijo → Automático) mientras el popover está
  // abierto, no queda una señal de apertura vieja bloqueando el Escape del diálogo padre.
  useEffect(() => () => onPopoverOpenChange?.(false), [onPopoverOpenChange]);

  useEffect(() => {
    setPage(0);
  }, [filters, models]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setPopoverOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, setPopoverOpen]);

  useEffect(() => {
    if (!open || !activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeOptionId]);

  function updateFilter<K extends keyof ModelFilterState>(key: K, next: ModelFilterState[K]): void {
    setFilters((current) => ({ ...current, [key]: next }));
    setActiveModelKey(undefined);
  }

  function choose(model: ModelInfo): void {
    void rememberRecent(model.ref);
    onChange(model.ref);
    setPopoverOpen(false);
    triggerRef.current?.focus();
  }

  function moveActive(direction: -1 | 1): void {
    if (optionModels.length === 0) return;
    const nextIndex = Math.max(0, Math.min(optionModels.length - 1, resolvedActiveIndex + direction));
    setActiveModelKey(modelIdentity(optionModels[nextIndex]!));
  }

  function setActiveBoundary(last: boolean): void {
    if (optionModels.length === 0) return;
    const index = last ? optionModels.length - 1 : 0;
    setActiveModelKey(modelIdentity(optionModels[index]!));
  }

  function chooseActive(): void {
    if (activeModel) choose(activeModel);
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveBoundary(false);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveBoundary(true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      chooseActive();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setPopoverOpen(false);
      triggerRef.current?.focus();
    }
  }

  if (engineState === 'starting' && models.length === 0) {
    return <span className="saurio-model-select saurio-model-select--status" role="status">Iniciando motor local…</span>;
  }
  if (engineState === 'down' && models.length === 0) {
    return <span className="saurio-model-select saurio-model-select--status" title={startEngineError}>Ollama no está corriendo<button type="button" className="saurio-btn-ghost saurio-model-select__action" onClick={onStartEngine}>Iniciar</button></span>;
  }
  if (models.length === 0) {
    return <span className="saurio-model-select saurio-model-select--status">No hay modelos disponibles<button type="button" className="saurio-btn-ghost saurio-model-select__action" onClick={() => useUiNavStore.getState().requestTab('Modelos')}>Abrir Modelos</button></span>;
  }

  return (
    <div className="saurio-model-select">
      <button ref={triggerRef} type="button" className="saurio-model-select__trigger" disabled={disabled} title={title ?? 'Elegir modelo'} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} onClick={() => setPopoverOpen(!open)} onKeyDown={(event) => {
        if (!open && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) {
          event.preventDefault();
          const preferredIndex = event.key === 'ArrowUp' || event.key === 'End' ? optionModels.length - 1 : event.key === 'ArrowDown' || event.key === 'Home' ? 0 : undefined;
          setPopoverOpen(true, preferredIndex);
        }
      }}>
        <span className="saurio-model-select__trigger-name">{value?.name ?? 'Elegir modelo'}</span>
        <span className="saurio-model-select__trigger-chevron" aria-hidden="true">⌄</span>
      </button>
      {value && <span className={`saurio-badge ${value.locality}`}>{localityLabel(value.locality)}</span>}
      {open && (
        <div className="saurio-model-select__popover" role="dialog" aria-label="Buscar modelo">
          <div className="saurio-model-select__search-row">
            <input ref={searchRef} type="search" role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeOptionId} aria-autocomplete="list" value={filters.query} placeholder="Buscar nombre o proveedor…" aria-label="Buscar modelo por nombre o proveedor" onChange={(event) => updateFilter('query', event.target.value)} onKeyDown={handleSearchKeyDown} />
            <span className="saurio-model-select__count" aria-live="polite">{filteredModels.length} modelos</span>
          </div>
          <div className="saurio-model-select__filters">
            <label>Origen<select value={filters.locality} onChange={(event) => updateFilter('locality', event.target.value as ModelFilterState['locality'])}>{(['all', 'local', 'lan', 'cloud'] as const).map((locality) => <option key={locality} value={locality}>{localityFilterLabel(locality)}</option>)}</select></label>
            <label>Proveedor<select value={filters.providerId} onChange={(event) => updateFilter('providerId', event.target.value)}><option value="all">Todos</option>{providerIds.map((providerId) => <option key={providerId} value={providerId}>{providerLabel(providerId, providers)}</option>)}</select></label>
            <label>Contexto mínimo<select value={filters.minContext ?? ''} onChange={(event) => updateFilter('minContext', event.target.value ? Number(event.target.value) : undefined)}><option value="">Cualquiera</option><option value="4096">4K</option><option value="8192">8K</option><option value="16384">16K</option><option value="32768">32K</option></select></label>
            <label>Orden<select value={filters.costOrder} onChange={(event) => updateFilter('costOrder', event.target.value as ModelFilterState['costOrder'])}><option value="none">Orden original</option><option value="low-to-high">Costo de entrada</option></select></label>
            <label className="saurio-model-select__check"><input type="checkbox" checked={filters.tools} onChange={(event) => updateFilter('tools', event.target.checked)} /> Herramientas</label>
            <label className="saurio-model-select__check"><input type="checkbox" checked={filters.vision} onChange={(event) => updateFilter('vision', event.target.checked)} /> Visión</label>
            <label className="saurio-model-select__check"><input type="checkbox" checked={filters.favoritesOnly} onChange={(event) => updateFilter('favoritesOnly', event.target.checked)} /> Favoritos</label>
            <label className="saurio-model-select__check"><input type="checkbox" checked={filters.recentsOnly} onChange={(event) => updateFilter('recentsOnly', event.target.checked)} /> Recientes</label>
            <label className="saurio-model-select__check"><input type="checkbox" checked={filters.freeOnly} onChange={(event) => updateFilter('freeOnly', event.target.checked)} /> Gratis confirmado</label>
            {hasModelFilters(filters) && <button type="button" className="saurio-btn-ghost saurio-model-select__clear" onClick={() => setFilters(DEFAULT_MODEL_FILTERS)}>Limpiar</button>}
          </div>
          {preferenceError && <div className="saurio-model-select__error" role="alert">{preferenceError}</div>}
          <div id={listId} className="saurio-model-select__list" role="listbox" aria-label="Modelos disponibles">
            {optionModels.map((model, index) => <ModelOption key={modelIdentity(model)} id={`${listId}-option-${index}`} model={model} providers={providers} selected={modelIdentity(model) === selectedKey} active={index === resolvedActiveIndex} onChoose={choose} unavailable={modelIdentity(model) === selectedKey && !selectedIsKnown} hidden={hiddenIds.has(modelIdentity(model))} favorite={favoriteIds.has(modelIdentity(model))} onToggleFavorite={() => void toggleFavorite(model.ref)} />)}
            {visibleModels.length === 0 && !selectedModel && <p className="saurio-model-select__empty">No hay coincidencias. Probá limpiar los filtros.</p>}
          </div>
          {pageCount > 1 && <div className="saurio-model-select__pagination"><button type="button" disabled={page === 0} onClick={() => setPage((current) => current - 1)}>Anterior</button><span>Página {page + 1} de {pageCount}</span><button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((current) => current + 1)}>Siguiente</button></div>}
        </div>
      )}
    </div>
  );
}

function ModelOption({ id, model, providers, selected, active, unavailable, hidden, onChoose, favorite, onToggleFavorite }: { id: string; model: ModelInfo; providers: ProviderConfig[]; selected: boolean; active: boolean; unavailable?: boolean; hidden?: boolean; favorite: boolean; onChoose: (model: ModelInfo) => void; onToggleFavorite: () => void }): React.JSX.Element {
  const price = modelCostPerMillion(model);
  const priceLabel = price ? `USD ${price.prompt.toFixed(2)}/1M entrada · USD ${price.completion.toFixed(2)}/1M salida` : 'precio desconocido';
  return <div id={id} role="option" aria-selected={selected} className={`saurio-model-select__option${selected ? ' selected' : ''}${active ? ' active' : ''}`}><button type="button" className="saurio-model-select__option-select" onClick={() => onChoose(model)}><span className="saurio-model-select__option-main"><strong>{model.ref.name}</strong><small>{providerLabel(model.ref.providerId, providers)} · {priceLabel}</small></span><span className="saurio-model-select__option-meta">{unavailable ? 'No disponible' : hidden ? 'Oculto' : model.metadataSource === 'manual' ? 'ID manual' : localityLabel(model.ref.locality)}</span></button><button type="button" className="saurio-model-select__favorite" aria-label={favorite ? `Quitar ${model.ref.name} de favoritos` : `Agregar ${model.ref.name} a favoritos`} aria-pressed={favorite} onClick={(event) => { event.stopPropagation(); onToggleFavorite(); }}>{favorite ? '★' : '☆'}</button></div>;
}
