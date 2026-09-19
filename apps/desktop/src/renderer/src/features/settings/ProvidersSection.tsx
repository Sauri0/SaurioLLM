// Ajustes > Proveedores (punto 3 del encargo: "agregar proveedor, pegar clave, probar conexión con
// resultado claro, ver modelos, habilitar/deshabilitar, borrar") —
// apps/desktop/src/renderer/src/features/settings/ProvidersSection.tsx.
// Reemplaza el estado vacío que dejaba SettingsPanel.tsx ("esta pantalla queda lista para cuando esa
// integración esté conectada" — ya está conectada, doc 18 §3 + esta tarea de apps/desktop).
import { useCallback, useEffect, useState } from 'react';
import type { NonLocalCallAuditEntry, ProviderConfig, ProviderPreset } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { useProvidersStore } from '../../stores/providersStore.js';
import { localityLabel } from '../models/locality.js';
import { ProviderUsage } from './ProviderUsage.js';
import { filterAuditLog, paginateAuditLog } from './auditLogFilters.js';
import './settings.css';
import './providersCost.css';

const PRESET_LABEL: Record<ProviderPreset, string> = {
  ollama: 'Ollama (attach)', openai: 'OpenAI', openrouter: 'OpenRouter', anthropic: 'Anthropic', custom: 'OpenAI-compatible personalizado',
};
const PRESET_DEFAULT_BASE_URL: Record<ProviderPreset, string> = {
  ollama: 'http://127.0.0.1:11434', openai: 'https://api.openai.com', openrouter: 'https://openrouter.ai/api',
  anthropic: 'https://api.anthropic.com', custom: '',
};
const PRESET_NEEDS_KEY: Record<ProviderPreset, boolean> = {
  ollama: false, openai: true, openrouter: true, anthropic: true, custom: true,
};

function AddProviderForm(): React.JSX.Element {
  const add = useProvidersStore((s) => s.add);
  const [preset, setPreset] = useState<ProviderPreset>('openai');
  const [label, setLabel] = useState(PRESET_LABEL['openai']);
  const [baseUrl, setBaseUrl] = useState(PRESET_DEFAULT_BASE_URL['openai']);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function selectPreset(next: ProviderPreset): void {
    setPreset(next);
    setLabel(PRESET_LABEL[next]);
    setBaseUrl(PRESET_DEFAULT_BASE_URL[next]);
  }

  async function submit(ev: React.FormEvent): Promise<void> {
    ev.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await add({
        preset, label: label.trim() || PRESET_LABEL[preset],
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim().length > 0 ? apiKey.trim() : undefined,
      });
      setApiKey('');
      if (preset === 'custom') setBaseUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="saurio-row saurio-providers-form" onSubmit={(ev) => void submit(ev)}>
      <div className="saurio-providers-form__grid">
        <label className="saurio-settings-label">
          Tipo
          <select value={preset} onChange={(ev) => selectPreset(ev.target.value as ProviderPreset)}>
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="anthropic">Anthropic</option>
            <option value="ollama">Ollama (attach — otra instancia, p. ej. en la LAN)</option>
            <option value="custom">OpenAI-compatible personalizado (LM Studio, llama.cpp, vLLM, Groq…)</option>
          </select>
        </label>
        <label className="saurio-settings-label">
          Nombre
          <input type="text" value={label} onChange={(ev) => setLabel(ev.target.value)} placeholder={PRESET_LABEL[preset]} />
        </label>
        <label className="saurio-settings-label">
          Base URL
          <input
            type="text" value={baseUrl} onChange={(ev) => setBaseUrl(ev.target.value)}
            placeholder={preset === 'custom' ? 'http://127.0.0.1:1234 (obligatorio)' : PRESET_DEFAULT_BASE_URL[preset]}
          />
        </label>
        {PRESET_NEEDS_KEY[preset] && (
          <label className="saurio-settings-label">
            Clave de API
            <input
              type="password" value={apiKey} onChange={(ev) => setApiKey(ev.target.value)}
              placeholder="Pegar clave…"
              autoComplete="off"
            />
          </label>
        )}
      </div>
      {error && <div className="saurio-banner danger" role="alert">No se pudo guardar el proveedor: {error}</div>}
      <button type="submit" disabled={saving}>{saving ? 'Agregando…' : 'Agregar proveedor'}</button>
    </form>
  );
}

function ProviderRow({ provider }: { provider: ProviderConfig }): React.JSX.Element {
  // Un selector por campo (NUNCA un objeto literal nuevo por render): con React 19
  // (useSyncExternalStore) un objeto nuevo en cada llamada al selector de zustand nunca es `Object.is`
  // igual al anterior, así que cada render dispara una re-suscripción infinita ("Maximum update depth
  // exceeded" — mismo bug ya documentado en layout/ChatCenter.tsx para arrays, medido acá de nuevo
  // con un objeto real durante la verificación visual de esta tarea).
  const update = useProvidersStore((s) => s.update);
  const remove = useProvidersStore((s) => s.remove);
  const test = useProvidersStore((s) => s.test);
  const busyId = useProvidersStore((s) => s.busyId);
  const lastTestResult = useProvidersStore((s) => s.lastTestResult);
  const [newKey, setNewKey] = useState('');
  const busy = busyId === provider.id;
  const result = lastTestResult[provider.id];

  async function toggleEnabled(): Promise<void> {
    await update({ id: provider.id, enabled: !provider.enabled });
  }

  async function saveKey(): Promise<void> {
    if (!newKey.trim()) return;
    await update({ id: provider.id, apiKey: newKey.trim() });
    setNewKey('');
  }

  async function clearKey(): Promise<void> {
    await update({ id: provider.id, apiKey: null });
  }

  async function handleRemove(): Promise<void> {
    if (!window.confirm(`¿Borrar el proveedor "${provider.label}"? Se borra también la clave guardada.`)) return;
    await remove(provider.id);
  }

  return (
    <div className="saurio-row saurio-providers-row">
      <div className="saurio-row__header">
        <span className="saurio-row__title">
          <strong>{provider.label}</strong> <span className="saurio-mono">({PRESET_LABEL[provider.preset]})</span>
        </span>
        <span className={`saurio-badge ${provider.locality}`}>{localityLabel(provider.locality)}</span>
      </div>
      <div className="saurio-row__meta">
        <span className="saurio-mono">{provider.baseUrl}</span>
        <span>
          Clave: {provider.hasApiKey ? `configurada (····${provider.apiKeyLast4 ?? '????'})` : 'sin configurar'}
        </span>
        <label className="saurio-settings-label saurio-providers-enable">
          <input type="checkbox" checked={provider.enabled} disabled={busy} onChange={() => void toggleEnabled()} /> Habilitado
        </label>
      </div>

      <div className="saurio-providers-row__actions">
        <button type="button" disabled={busy} onClick={() => void test(provider.id)}>
          {busy ? 'Probando…' : 'Probar conexión'}
        </button>
        {provider.removable && (
          <button type="button" className="saurio-btn-danger" disabled={busy} onClick={() => void handleRemove()}>Borrar</button>
        )}
      </div>

      {result && (
        result.ok
          ? (
            <div className="saurio-banner success" role="status">
              Conexión confirmada con {provider.baseUrl}{result.version ? ` (versión ${result.version})` : ''}
              {result.modelNames && ` — ${result.modelNames.length} modelo(s): ${result.modelNames.slice(0, 5).join(', ')}${result.modelNames.length > 5 ? '…' : ''}`}
            </div>
          )
          : (
            <div className="saurio-banner danger" role="alert">
              No se pudo conectar con {provider.baseUrl}. Revisá la URL, la red y la clave. Detalle: {result.error}
            </div>
          )
      )}

      <div className="saurio-providers-row__key-edit">
        <input
          type="password" value={newKey} onChange={(ev) => setNewKey(ev.target.value)}
          placeholder={provider.hasApiKey ? 'Reemplazar clave…' : 'Pegar clave…'} autoComplete="off"
        />
        <button type="button" disabled={busy || !newKey.trim()} onClick={() => void saveKey()}>Guardar clave</button>
        {provider.hasApiKey && <button type="button" disabled={busy} onClick={() => void clearKey()}>Borrar clave</button>}
      </div>
    </div>
  );
}

function NonLocalCallAuditLog(): React.JSX.Element {
  const [entries, setEntries] = useState<NonLocalCallAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [providerId, setProviderId] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [page, setPage] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await invoke('providers:auditLog', undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setPage(0);
  }, [query, providerId, since, until]);

  const sinceTimestamp = since ? Date.parse(`${since}T00:00:00`) : undefined;
  const untilTimestamp = until ? Date.parse(`${until}T23:59:59.999`) : undefined;
  const filteredEntries = filterAuditLog(entries, { query, providerId, since: sinceTimestamp, until: untilTimestamp });
  const pageData = paginateAuditLog(filteredEntries, page, 20);
  const providerIds = [...new Set(entries.map((entry) => entry.providerId))].sort();

  function clearFilters(): void {
    setQuery('');
    setProviderId('');
    setSince('');
    setUntil('');
    setPage(0);
  }

  return (
    <section className="saurio-providers-audit">
      <div className="saurio-row__header">
        <h3 className="saurio-settings-subtitle">Registro de llamadas no locales</h3>
        <button type="button" disabled={loading} onClick={() => void refresh()}>
          {loading ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>
      <p className="saurio-row__line--muted">Últimos 200 registros disponibles; este registro no es una factura total.</p>
      <div className="saurio-providers-audit__filters" aria-label="Filtros del registro de llamadas">
        <label>Buscar modelo o run<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="qwen, run…" /></label>
        <label>Proveedor
          <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            <option value="">Todos</option>
            {providerIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label>Desde<input type="date" value={since} onChange={(event) => setSince(event.target.value)} /></label>
        <label>Hasta<input type="date" value={until} onChange={(event) => setUntil(event.target.value)} /></label>
        <button type="button" className="saurio-btn-ghost" onClick={clearFilters}>Limpiar</button>
      </div>
      {error && <div className="saurio-banner danger" role="alert">No se pudo cargar el registro de llamadas: {error}</div>}
      {loading && <p className="saurio-text-dim" role="status">Cargando registro de llamadas…</p>}
      {!loading && entries.length === 0 && !error && (
        <p className="saurio-empty">Sin llamadas registradas a proveedores fuera de esta PC todavía.</p>
      )}
      {entries.length > 0 && filteredEntries.length === 0 && !loading && !error && (
        <p className="saurio-empty">No hay registros que coincidan con los filtros.</p>
      )}
      {pageData.total > 0 && (
        <div className="saurio-row-list saurio-providers-audit__list">
          <p className="saurio-row__line--muted">{pageData.total} registro{pageData.total === 1 ? '' : 's'} encontrado{pageData.total === 1 ? '' : 's'}</p>
          {pageData.items.map((entry) => (
            <div key={entry.id} className="saurio-row saurio-providers-audit__row">
              <span className="saurio-mono saurio-providers-audit__ts">{new Date(entry.ts).toLocaleString('es-AR')}</span>
              <span className={`saurio-badge ${entry.locality}`}>{localityLabel(entry.locality)}</span>
              <span className="saurio-mono">{entry.providerId}</span>
              <span className="saurio-mono">{entry.modelName}</span>
              <span className="saurio-row__line--muted saurio-mono">run {entry.runId}</span>
            </div>
          ))}
          {pageData.pageCount > 1 && (
            <div className="saurio-providers-audit__pagination">
              <button type="button" disabled={pageData.page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Anterior</button>
              <span>Página {pageData.page + 1} de {pageData.pageCount}</span>
              <button type="button" disabled={pageData.page >= pageData.pageCount - 1} onClick={() => setPage((value) => value + 1)}>Siguiente</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function ProvidersSection(): React.JSX.Element {
  const providers = useProvidersStore((s) => s.providers);
  const loading = useProvidersStore((s) => s.loading);
  const error = useProvidersStore((s) => s.error);
  const load = useProvidersStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      {error && <div className="saurio-banner danger">{error}</div>}
      <p className="providers-cost-note">
        OpenRouter puede informar el costo por respuesta. Es un total reportado por la API, no una factura final: créditos, descuentos, impuestos o ajustes posteriores pueden diferir.
      </p>
      <AddProviderForm />
      {loading && providers.length === 0 ? (
        <p className="saurio-empty">Cargando proveedores…</p>
      ) : providers.length === 0 ? (
        <div className="saurio-empty-state saurio-settings-empty">
          <span className="saurio-empty-state__hint">Sin proveedores configurados todavía.</span>
        </div>
      ) : (
        <div className="saurio-row-list">
          {providers.map((provider) => <ProviderRow key={provider.id} provider={provider} />)}
        </div>
      )}
      <ProviderUsage />
      <NonLocalCallAuditLog />
    </div>
  );
}
