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
import './settings.css';

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
              placeholder="Se guarda cifrada (Electron safeStorage); nunca se muestra de nuevo"
              autoComplete="off"
            />
          </label>
        )}
      </div>
      {error && <div className="saurio-banner danger">{error}</div>}
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
            <div className="saurio-banner success">
              Conectado{result.version ? ` (versión ${result.version})` : ''}
              {result.modelNames && ` — ${result.modelNames.length} modelo(s): ${result.modelNames.slice(0, 5).join(', ')}${result.modelNames.length > 5 ? '…' : ''}`}
            </div>
          )
          : <div className="saurio-banner danger">No se pudo conectar: {result.error}</div>
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

/** Punto 4 del encargo ("visor simple del audit_log de llamadas no locales en Ajustes >
 *  Proveedores"): solo lectura, sin filtros ni paginación — `providers:auditLog` (canal nuevo de
 *  esta tarea) ya trae los últimos 200 registros más recientes primero
 *  (`SqlAuditLogRepository.listNonLocalCalls`, existía y estaba probado desde la sesión anterior,
 *  doc 16 §10.9: "listo para un canal futuro si hace falta"). Nunca muestra la clave del proveedor
 *  (el `audit_log` tampoco la guarda, ver `SqlAuditLogRepository.recordNonLocalCall`). */
function NonLocalCallAuditLog(): React.JSX.Element {
  const [entries, setEntries] = useState<NonLocalCallAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="saurio-providers-audit">
      <div className="saurio-row__header">
        <h3 className="saurio-settings-subtitle">Registro de llamadas no locales</h3>
        <button type="button" disabled={loading} onClick={() => void refresh()}>
          {loading ? 'Actualizando…' : 'Actualizar'}
        </button>
      </div>
      {error && <div className="saurio-banner danger">{error}</div>}
      {!loading && entries.length === 0 && !error && (
        <p className="saurio-empty">Sin llamadas registradas a proveedores fuera de esta PC todavía.</p>
      )}
      {entries.length > 0 && (
        <div className="saurio-row-list saurio-providers-audit__list">
          {entries.map((entry) => (
            <div key={entry.id} className="saurio-row saurio-providers-audit__row">
              <span className="saurio-mono saurio-providers-audit__ts">{new Date(entry.ts).toLocaleString('es-AR')}</span>
              <span className={`saurio-badge ${entry.locality}`}>{localityLabel(entry.locality)}</span>
              <span className="saurio-mono">{entry.providerId}</span>
              <span className="saurio-mono">{entry.modelName}</span>
              <span className="saurio-row__line--muted saurio-mono">run {entry.runId}</span>
            </div>
          ))}
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
      <NonLocalCallAuditLog />
    </div>
  );
}
