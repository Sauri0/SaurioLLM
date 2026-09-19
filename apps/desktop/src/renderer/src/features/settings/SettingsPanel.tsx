// Panel "Ajustes" (MVP, doc 01 §4.1 "Settings básico"): reglas de permisos con origen y borrado,
// terminal por defecto, slots (1 fijo en el MVP, doc 01 §9 "1 slot"), localOnly (doc 01 §2
// principio 7 "local por defecto"). apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx.
//
// Pasada de diseño #6: misma pasada de tokens que Modelos/Rendimiento — filas (`.saurio-row`) para
// las reglas de permisos, título de panel consistente y un estado vacío con guía en vez de un
// párrafo suelto.
//
// DEVIATION: `PermissionRule` vive en packages/runtime/src/permissions/types.ts, un paquete de
// "proceso main puro" (doc 02 §3) del que la UI no debe depender directamente (doc 01 §2
// principio 9, "ninguna capa importa la de arriba"; la UI habla con main solo por IPC). Se define
// acá una forma local equivalente (mismos campos) en vez de importar el tipo de @saurio/runtime.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { maximumContextOrFallback, type ModelInfo } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { SettingsIcon, ShieldIcon } from '../../ui/icons.js';
import { useUiNavStore } from '../../stores/uiNavStore.js';
import { ProvidersSection } from './ProvidersSection.js';
import { EngineSetup } from '../onboarding/EngineSetup.js';
import { ResourceSettings } from './ResourceSettings.js';
import type { ResourceHardware } from './resourceSettingsLogic.js';
import { contextModelPage, modelKey } from './contextModelList.js';
import './settings.css';

const GPU_MITIGATION_KEY = 'app.gpuMitigationDisabled'; // ver main/index.ts shouldApplyGpuMitigation()

export interface PermissionRuleView {
  id?: string;
  scope: 'session' | 'project' | 'global';
  toolName: string;
  pattern?: string;
  decision: 'allow' | 'ask' | 'deny';
  source: 'user' | 'preset' | 'mode' | 'settings';
}

function isPermissionRuleArray(value: unknown): value is PermissionRuleView[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null && 'toolName' in v && 'decision' in v);
}

const DEFAULT_TERMINAL_SHELL = 'pwsh'; // pwsh si existe; powershell.exe si no (nota de medición del encargo: pwsh 7 no está instalado en esta máquina).

export function SettingsPanel(): React.JSX.Element {
  const section = useUiNavStore((state) => state.settingsTab);
  const setSection = useUiNavStore((state) => state.setSettingsTab);
  const [rules, setRules] = useState<PermissionRuleView[]>([]);
  const [defaultShell, setDefaultShell] = useState(DEFAULT_TERMINAL_SHELL);
  const [localOnly, setLocalOnly] = useState(true);
  const [gpuAccelEnabled, setGpuAccelEnabled] = useState(false);
  const [autoUpdates, setAutoUpdates] = useState(true);
  const [installedModels, setInstalledModels] = useState<ModelInfo[]>([]);
  const [contextSearch, setContextSearch] = useState('');
  const [contextPage, setContextPage] = useState(1);
  const [describedContextMax, setDescribedContextMax] = useState<Record<string, number | undefined>>({});
  const [describeAttempted, setDescribeAttempted] = useState<Record<string, true>>({});
  const [hardware, setHardware] = useState<ResourceHardware>();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const openOnboarding = useUiNavStore((s) => s.openOnboarding);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rulesValue, shellValue, localOnlyValue, gpuValue, updatesValue, models] = await Promise.all([
        invoke('settings:get', { key: 'permissions.rules' }),
        invoke('settings:get', { key: 'terminal.defaultShell' }),
        invoke('settings:get', { key: 'models.localOnly' }),
        invoke('settings:get', { key: GPU_MITIGATION_KEY }),
        invoke('settings:get', { key: 'updates.auto' }),
        invoke('models:list', { refresh: false }).catch(() => []),
      ]);
      if (isPermissionRuleArray(rulesValue)) setRules(rulesValue);
      if (typeof shellValue === 'string') setDefaultShell(shellValue);
      if (typeof localOnlyValue === 'boolean') setLocalOnly(localOnlyValue);
      setGpuAccelEnabled(gpuValue === true); // gpuMitigationDisabled === true -> aceleración activada
      setAutoUpdates(updatesValue !== false);
      setInstalledModels(models);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshHardware = useCallback(async (refresh = false): Promise<void> => {
    const profile = await invoke('hardware:profile', { refresh });
    setHardware(profile);
  }, []);

  useEffect(() => {
    void refreshHardware().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [refreshHardware]);

  const contextModels = useMemo(() => contextModelPage(installedModels, contextSearch, contextPage), [installedModels, contextSearch, contextPage]);

  useEffect(() => {
    let active = true;
    const unknownVisibleLocal = contextModels.items.filter((model) =>
      model.ref.locality === 'local' && model.contextMax === undefined && !describeAttempted[modelKey(model)]);
    if (unknownVisibleLocal.length === 0) return () => { active = false; };

    setDescribeAttempted((previous) => ({ ...previous, ...Object.fromEntries(unknownVisibleLocal.map((model) => [modelKey(model), true])) }));
    void (async () => {
      // Secuencial y acotado a la página (20): nunca dispara requests de detalle para el catálogo API.
      for (const model of unknownVisibleLocal) {
        const described = await invoke('models:describe', { ref: model.ref }).catch(() => undefined);
        if (!active) return;
        if (described?.contextMax !== undefined) {
          setDescribedContextMax((previous) => ({ ...previous, [modelKey(model)]: described.contextMax }));
        }
      }
    })();
    return () => { active = false; };
  }, [contextModels.items, describeAttempted]);

  async function deleteRule(rule: PermissionRuleView): Promise<void> {
    if (rule.source !== 'user') return; // solo reglas del usuario se pueden borrar; preset/mode/settings son de solo lectura acá
    setSaving(true);
    setError(null);
    try {
      const next = rules.filter((r) => r !== rule);
      await invoke('settings:set', { key: 'permissions.rules', value: next });
      setRules(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveShell(shell: string): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await invoke('settings:set', { key: 'terminal.defaultShell', value: shell });
      setDefaultShell(shell);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveLocalOnly(value: boolean): Promise<void> {
    try {
      await invoke('settings:set', { key: 'models.localOnly', value });
      setLocalOnly(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** `app.gpuMitigationDisabled` se lee una sola vez, antes de `app.whenReady()` (main/index.ts) —
   *  este toggle escribe la preferencia pero solo aplica en el próximo arranque de la app. */
  async function saveGpuAccel(enabled: boolean): Promise<void> {
    try {
      await invoke('settings:set', { key: GPU_MITIGATION_KEY, value: enabled });
      setGpuAccelEnabled(enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveAutoUpdates(value: boolean): Promise<void> {
    setError(null);
    try {
      await invoke('settings:set', { key: 'updates.auto', value });
      setAutoUpdates(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="saurio-settings-panel">
      <div className="saurio-panel__header">
        <strong className="saurio-panel__title"><SettingsIcon width={16} height={16} className="saurio-settings-title-icon" />Ajustes</strong>
      </div>
      <nav className="saurio-settings-nav" aria-label="Secciones de ajustes">
        {([['local', 'Motor y recursos'], ['providers', 'APIs y costos'], ['context', 'Contexto'], ['app', 'Aplicación y permisos']] as const).map(([id, label]) =>
          <button type="button" key={id} aria-pressed={section === id} onClick={() => setSection(id)}>{label}</button>)}
      </nav>
      {error && <div className="saurio-banner danger" role="alert">{error}</div>}

      {section === 'local' && <>
      <section className="saurio-settings-card"><h3>Motor local</h3><EngineSetup /></section>

      <section className="saurio-settings-card">
        <ResourceSettings hardware={hardware} onRefreshHardware={() => refreshHardware(true)} />
      </section>
      </>}

      {section === 'context' && <section className="saurio-settings-card">
      <h3>Contexto del modelo</h3>
      <p className="saurio-settings-hint">
        Automático: cada chat usa el máximo que informa su modelo o proveedor. No tenés que ajustar
        números. El contexto incluye instrucciones, conversación, archivos y espacio para la respuesta.
        Un contexto mayor puede necesitar más memoria; si la carga falla, el chat muestra el error.
      </p>
      {installedModels.length === 0 ? <p className="saurio-empty">Conectá un proveedor para consultar sus límites.</p> : (
        <>
        <label className="saurio-settings-label">
          Buscar modelo o proveedor
          <input value={contextSearch} onChange={(event) => { setContextSearch(event.target.value); setContextPage(1); }} placeholder="Ej.: qwen u OpenRouter" />
        </label>
        <div className="saurio-row-list">
          {contextModels.items.map((model) => {
            const contextMax = describedContextMax[modelKey(model)] ?? model.contextMax;
            return (
            <div key={`${model.ref.providerId}:${model.ref.name}`} className="saurio-row saurio-settings-context-row">
              <strong>{model.ref.name}</strong>
              <span className="saurio-settings-hint">{model.ref.providerId}</span>
              <span>{contextMax !== undefined && maximumContextOrFallback(contextMax) === contextMax
                ? `Máximo informado: ${contextMax.toLocaleString('es-AR')} tokens`
                : 'Máximo no informado · presupuesto provisional: 8192 tokens'}</span>
            </div>
            );
          })}
        </div>
        {contextModels.pageCount > 1 && (
          <div className="saurio-row__meta">
            <button type="button" disabled={contextModels.page <= 1} onClick={() => setContextPage(contextModels.page - 1)}>Anterior</button>
            <span>Página {contextModels.page} de {contextModels.pageCount} ({contextModels.total.toLocaleString('es-AR')} modelos)</span>
            <button type="button" disabled={contextModels.page >= contextModels.pageCount} onClick={() => setContextPage(contextModels.page + 1)}>Siguiente</button>
          </div>
        )}
        </>
      )}

      </section>}

      {section === 'providers' && <>
      <section className="saurio-settings-card">
      <h3>Privacidad y conexión</h3>
      <label className="saurio-settings-label">
        <input type="checkbox" checked={localOnly} onChange={(ev) => void saveLocalOnly(ev.target.checked)} />{' '}
        Usar solamente modelos locales. Al desactivarlo, podés elegir proveedores por API;
        cada proyecto pide confirmación antes de enviar contenido a la nube.
      </label>

      </section>

      <section className="saurio-settings-card">
      <h3 id="saurio-settings-providers">Proveedores y modelos</h3>
      <p className="saurio-settings-hint">Conectá un motor local o un proveedor por API. Las claves se guardan protegidas en este equipo.</p>
      <ProvidersSection />
      </section>
      </>}

      {section === 'app' && <>
      <section className="saurio-settings-card">
      <h3>Actualizaciones</h3>
      <label className="saurio-settings-label">
        <input type="checkbox" checked={autoUpdates} onChange={(ev) => void saveAutoUpdates(ev.target.checked)} />{' '}
        Buscar y descargar actualizaciones automáticamente. Se aplica al reiniciar la app.
      </label>

      </section>

      <details className="saurio-settings-card saurio-settings-advanced">
        <summary>Opciones avanzadas: permisos, terminal e interfaz</summary>
      <h3>Permisos: reglas</h3>
      {rules.length === 0 ? (
        <div className="saurio-empty-state saurio-settings-empty">
          <span className="saurio-empty-state__icon"><ShieldIcon width={18} height={18} /></span>
          <span className="saurio-empty-state__hint">Sin reglas guardadas — todo pasa por el preset activo.</span>
        </div>
      ) : (
        <div className="saurio-row-list">
          {rules.map((rule, index) => (
            <div key={`${rule.toolName}-${rule.pattern ?? ''}-${index}`} className="saurio-row">
              <div className="saurio-row__header">
                <span className="saurio-row__title">
                  <strong>{rule.toolName}</strong>{rule.pattern && ` (${rule.pattern})`} → {rule.decision}
                </span>
                {rule.source === 'user' && (
                  <button className="saurio-btn-danger" onClick={() => void deleteRule(rule)} disabled={saving}>Borrar</button>
                )}
              </div>
              <div className="saurio-row__meta">
                <span className="saurio-badge">{rule.scope}</span>
                <span className="saurio-badge">origen: {rule.source}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <h3>Terminal por defecto</h3>
      <select aria-label="Terminal por defecto" value={defaultShell} disabled={saving} onChange={(ev) => void saveShell(ev.target.value)}>
        <option value="pwsh">pwsh (PowerShell 7, si está instalado)</option>
        <option value="powershell">Windows PowerShell (incluido en Windows)</option>
      </select>

      <h3>Interfaz</h3>
      <label className="saurio-settings-label">
        <input type="checkbox" checked={gpuAccelEnabled} onChange={(ev) => void saveGpuAccel(ev.target.checked)} />{' '}
        Usar aceleración gráfica para la interfaz. No cambia el uso de GPU del modelo.
        Requiere reiniciar la app. Si ves pantallas vacías o fallos gráficos, desactivala.
      </label>

      </details>

      <h3>Asistente de primer arranque</h3>
      <button type="button" onClick={openOnboarding}>Volver a ver el asistente de primer arranque</button>
      </>}
    </div>
  );
}
