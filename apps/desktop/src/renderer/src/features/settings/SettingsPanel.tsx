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
import { useCallback, useEffect, useState } from 'react';
import type { ModelInfo } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { SettingsIcon, ShieldIcon } from '../../ui/icons.js';
import { NUM_CTX_GLOBAL_DEFAULT, NUM_CTX_SETTINGS_KEY, isNumCtxDefaults, type NumCtxDefaults } from '../models/numCtxDefaults.js';
import { useUiNavStore } from '../../stores/uiNavStore.js';
import { ProvidersSection } from './ProvidersSection.js';
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
  const [rules, setRules] = useState<PermissionRuleView[]>([]);
  const [defaultShell, setDefaultShell] = useState(DEFAULT_TERMINAL_SHELL);
  const [localOnly, setLocalOnly] = useState(true);
  const [gpuAccelEnabled, setGpuAccelEnabled] = useState(false);
  const [numCtxDefaults, setNumCtxDefaults] = useState<NumCtxDefaults>({});
  const [installedModels, setInstalledModels] = useState<ModelInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const openOnboarding = useUiNavStore((s) => s.openOnboarding);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rulesValue, shellValue, localOnlyValue, gpuValue, numCtxValue, models] = await Promise.all([
        invoke('settings:get', { key: 'permissions.rules' }),
        invoke('settings:get', { key: 'terminal.defaultShell' }),
        invoke('settings:get', { key: 'models.localOnly' }),
        invoke('settings:get', { key: GPU_MITIGATION_KEY }),
        invoke('settings:get', { key: NUM_CTX_SETTINGS_KEY }),
        invoke('models:list', { refresh: false }).catch(() => []),
      ]);
      if (isPermissionRuleArray(rulesValue)) setRules(rulesValue);
      if (typeof shellValue === 'string') setDefaultShell(shellValue);
      if (typeof localOnlyValue === 'boolean') setLocalOnly(localOnlyValue);
      setGpuAccelEnabled(gpuValue === true); // gpuMitigationDisabled === true -> aceleración activada
      if (isNumCtxDefaults(numCtxValue)) setNumCtxDefaults(numCtxValue);
      setInstalledModels(models);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
    setDefaultShell(shell);
    try {
      await invoke('settings:set', { key: 'terminal.defaultShell', value: shell });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveLocalOnly(value: boolean): Promise<void> {
    setLocalOnly(value);
    try {
      await invoke('settings:set', { key: 'models.localOnly', value });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** `app.gpuMitigationDisabled` se lee una sola vez, antes de `app.whenReady()` (main/index.ts) —
   *  este toggle escribe la preferencia pero solo aplica en el próximo arranque de la app. */
  async function saveGpuAccel(enabled: boolean): Promise<void> {
    setGpuAccelEnabled(enabled);
    try {
      await invoke('settings:set', { key: GPU_MITIGATION_KEY, value: enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveNumCtx(modelName: string, numCtx: number): Promise<void> {
    const next = { ...numCtxDefaults, [modelName]: numCtx };
    setNumCtxDefaults(next);
    try {
      await invoke('settings:set', { key: NUM_CTX_SETTINGS_KEY, value: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function resetNumCtx(modelName: string): Promise<void> {
    const next = { ...numCtxDefaults };
    delete next[modelName];
    setNumCtxDefaults(next);
    try {
      await invoke('settings:set', { key: NUM_CTX_SETTINGS_KEY, value: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <div className="saurio-panel__header">
        <strong className="saurio-panel__title"><SettingsIcon width={16} height={16} className="saurio-settings-title-icon" />Ajustes</strong>
      </div>
      {error && <div className="saurio-banner danger">{error}</div>}

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
      <select value={defaultShell} onChange={(ev) => void saveShell(ev.target.value)}>
        <option value="pwsh">pwsh (PowerShell 7, si está instalado)</option>
        <option value="powershell">powershell.exe (Windows PowerShell, fallback en esta máquina)</option>
      </select>

      <h3>Slots del scheduler</h3>
      <p className="saurio-settings-hint">
        1 slot fijo en el MVP (doc 01 §9: "1 slot, cola por modelo con prioridad"; N slots configurables
        quedan <em>// v0.4</em>).
      </p>

      <h3>Localidad</h3>
      <label className="saurio-settings-label">
        <input type="checkbox" checked={localOnly} onChange={(ev) => void saveLocalOnly(ev.target.checked)} />{' '}
        Solo modelos locales (el Gateway del MVP ya restringe a <code>locality: 'local'</code>;
        `lan`/`proxied-cloud`/`cloud` existen en el tipo pero requieren habilitación explícita en v0.4).
      </label>

      <h3>GPU</h3>
      <label className="saurio-settings-label">
        <input type="checkbox" checked={gpuAccelEnabled} onChange={(ev) => void saveGpuAccel(ev.target.checked)} />{' '}
        Aceleración de GPU activada (por defecto está desactivada en este equipo: Electron 44 falló al
        crear un contexto de GPU en la máquina de referencia — ver docs/MANUAL.md "Nota sobre GPU").
        Requiere reiniciar la app para que el cambio tenga efecto.
      </label>

      <h3>Contexto por defecto por modelo</h3>
      <p className="saurio-settings-hint">
        Se usa para el ajuste estimado (fitClass) del Centro de modelos, pestaña "Instalados"; sin
        valor propio, cada modelo usa el default global ({NUM_CTX_GLOBAL_DEFAULT}). No cambia todavía
        el <code>num_ctx</code> real que manda un run (eso lo resuelve el motor de contexto, doc 16 §4
        punto 8, pendiente de conectar acá).
      </p>
      {installedModels.length === 0 ? (
        <p className="saurio-empty">Sin modelos instalados detectados.</p>
      ) : (
        <div className="saurio-row-list">
          {installedModels.map((model) => {
            const value = numCtxDefaults[model.ref.name] ?? NUM_CTX_GLOBAL_DEFAULT;
            const isCustom = model.ref.name in numCtxDefaults;
            return (
              <div key={model.ref.name} className="saurio-row saurio-settings-numctx-row">
                <span className="saurio-mono">{model.ref.name}</span>
                <input
                  type="number"
                  min={512}
                  step={512}
                  value={value}
                  onChange={(ev) => void saveNumCtx(model.ref.name, Number(ev.target.value))}
                  className="saurio-settings-numctx-input"
                />
                {isCustom && (
                  <button type="button" onClick={() => void resetNumCtx(model.ref.name)}>Restablecer</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Punto 3 del encargo: "Tengo una clave de API" (asistente de primer arranque) lleva acá.
          Ollama (attach), OpenAI, OpenRouter, Anthropic y OpenAI-compatible personalizado — CRUD real
          + almacén seguro de claves (Electron safeStorage) + "probar conexión". */}
      <h3 id="saurio-settings-providers">Proveedores</h3>
      <ProvidersSection />

      <h3>Asistente de primer arranque</h3>
      <button type="button" onClick={openOnboarding}>Volver a ver el asistente de primer arranque</button>
    </div>
  );
}
