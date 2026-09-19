import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelInfo, ProviderConfig } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';

export function eligibleManualProviders(providers: ProviderConfig[]): ProviderConfig[] {
  return providers.filter((provider) => provider.enabled && provider.kind !== 'ollama');
}

export function manualModelName(value: string): string | undefined {
  const name = value.trim();
  if (!name) return undefined;
  if (name.length > 200 || /[\r\n]/u.test(name) || name.includes('\0')) return undefined;
  return name;
}

/** Incluye el registro manual que quedó solapado por un catálogo remoto más completo. */
export function manualDefinitionModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((model) => model.metadataSource === 'manual' || model.manualDefinition === true).sort((a, b) =>
    a.ref.providerId.localeCompare(b.ref.providerId) || a.ref.name.localeCompare(b.ref.name));
}

interface ManualModelFormProps {
  models: ModelInfo[];
  /** Actualiza la lista de este panel y el store que consumen los otros selectores. */
  onChanged: () => Promise<void>;
}

/** Agrega IDs declarados por la persona sin consultar el proveedor ni inferir capabilities. */
export function ManualModelForm({ models, onChanged }: ManualModelFormProps): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [providerId, setProviderId] = useState('');
  const [name, setName] = useState('');
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutationInFlight = useRef(false);
  const availableProviders = useMemo(() => eligibleManualProviders(providers), [providers]);
  const manualModels = useMemo(() => manualDefinitionModels(models), [models]);

  useEffect(() => {
    let cancelled = false;
    void invoke('providers:list', undefined).then((result) => {
      if (!cancelled) setProviders(result);
    }).catch((reason) => {
      if (!cancelled) setError(`No se pudieron leer los proveedores: ${reason instanceof Error ? reason.message : String(reason)}`);
    }).finally(() => {
      if (!cancelled) setLoadingProviders(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (availableProviders.some((provider) => provider.id === providerId)) return;
    setProviderId(availableProviders[0]?.id ?? '');
  }, [availableProviders, providerId]);

  async function update(provider: string, rawName: string, remove = false): Promise<void> {
    if (mutationInFlight.current) return;
    const exactName = manualModelName(rawName);
    if (!exactName) {
      setError('Escribí un ID de modelo de hasta 200 caracteres, en una sola línea.');
      return;
    }
    const key = `${provider}::${exactName}`;
    mutationInFlight.current = true;
    setBusyKey(key);
    setError(null);
    try {
      await invoke('models:updateManual', { providerId: provider, name: exactName, remove });
    } catch (reason) {
      setError(`No se pudo ${remove ? 'quitar' : 'guardar'} el ID manual: ${reason instanceof Error ? reason.message : String(reason)}`);
      return;
    }
    try {
      await onChanged();
      if (!remove) setName('');
    } catch (reason) {
      setError(`${remove ? 'La definición manual se quitó' : 'El ID manual se guardó'}, pero no se pudo actualizar la lista: ${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      mutationInFlight.current = false;
      setBusyKey(null);
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!providerId) {
      setError('Elegí un proveedor API habilitado.');
      return;
    }
    void update(providerId, name);
  }

  return (
    <section className="saurio-manual-models" aria-labelledby="manual-models-title">
      <h3 id="manual-models-title">Agregar ID manual</h3>
      <p className="saurio-row__line">Para un modelo que no figure en el catálogo. Guarda el identificador sin ejecutar inferencia. La disponibilidad se comprueba al usarlo.</p>
      <form className="saurio-manual-models__form" onSubmit={submit}>
        <label>Proveedor API
          <select value={providerId} disabled={loadingProviders || busyKey !== null || availableProviders.length === 0} onChange={(event) => setProviderId(event.target.value)}>
            {availableProviders.length === 0 && <option value="">No hay proveedores API habilitados</option>}
            {availableProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label || provider.id}</option>)}
          </select>
        </label>
        <label>ID exacto del modelo
          <input value={name} maxLength={200} disabled={busyKey !== null || availableProviders.length === 0} placeholder="proveedor/modelo" aria-describedby="manual-models-hint" onChange={(event) => setName(event.target.value)} />
        </label>
        <button type="submit" disabled={busyKey !== null || availableProviders.length === 0}>{busyKey ? 'Guardando…' : 'Agregar ID'}</button>
      </form>
      <p id="manual-models-hint" className="saurio-row__line saurio-row__line--muted">ID manual · capacidades y contexto sin confirmar.</p>
      {error && <div className="saurio-banner danger" role="alert">{error}</div>}
      {manualModels.length > 0 && <div className="saurio-manual-models__list" aria-label="IDs manuales">
        {manualModels.map((model) => {
          const key = `${model.ref.providerId}::${model.ref.name}`;
          const busy = busyKey === key;
          return <div className="saurio-row" key={key}>
            <strong className="saurio-mono">{model.ref.name}</strong>
            <span className="saurio-row__line">{model.ref.providerId} · ID manual · capacidades y contexto sin confirmar.</span>
            <button type="button" className="saurio-btn-ghost" disabled={busy || busyKey !== null} onClick={() => void update(model.ref.providerId, model.ref.name, true)}>{busy ? 'Quitando…' : 'Quitar definición manual'}</button>
          </div>;
        })}
      </div>}
    </section>
  );
}
