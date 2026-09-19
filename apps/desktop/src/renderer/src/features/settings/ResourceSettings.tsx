import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '../../ipc/client.js';
import {
  LOCAL_INFERENCE_SETTING_KEY, defaultLocalInferencePreference, formatBytes, hardwareQualityLabel, parseLocalInferencePreference,
  presetThreads, threadLimit, type ComputeMode, type LocalInferencePreference, type ResourceHardware, type ResourcePreset,
} from './resourceSettingsLogic.js';
import './resourceSettings.css';

export interface ResourceSettingsProps {
  /** Perfil real obtenido por el main process. Si falta, los controles esperan esa medición. */
  hardware?: ResourceHardware;
  /** Invalida la caché de GPU en main y vuelve a pedir el perfil. */
  onRefreshHardware?: () => Promise<void>;
}

const PRESET_LABEL: Record<ResourcePreset, string> = {
  balanced: 'Equilibrado',
  'low-power': 'Menos consumo',
  'max-performance': 'Máximo rendimiento',
};

/** Preferencias por request de Ollama local. No son controles de VRAM: muestran su alcance para no
 * sugerir que la RAM se puede convertir en VRAM ni que se modifica el contexto del chat. */
export function ResourceSettings({ hardware, onRefreshHardware }: ResourceSettingsProps): React.JSX.Element {
  const [preference, setPreference] = useState<LocalInferencePreference>(() => defaultLocalInferencePreference(hardware));
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limit = threadLimit(hardware);
  const gpuLabel = useMemo(() => {
    if (!hardware?.gpu) return 'GPU no detectada';
    const memory = formatBytes(hardware.gpu.vramTotalBytes);
    const kind = hardware.gpu.integrated ? 'memoria compartida' : 'VRAM dedicada';
    const used = hardware.gpu.vramUsedBytes === undefined ? '' : ` · ${formatBytes(hardware.gpu.vramUsedBytes)} en uso`;
    return `${hardware.gpu.vendor.toUpperCase()} · ${kind}: ${memory}${used} (${hardwareQualityLabel(hardware.gpu.quality)})`;
  }, [hardware]);

  useEffect(() => {
    let active = true;
    void invoke('settings:get', { key: LOCAL_INFERENCE_SETTING_KEY }).then((value) => {
      if (!active) return;
      setPreference(parseLocalInferencePreference(value, hardware));
      setLoaded(true);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoaded(true);
    });
    return () => { active = false; };
  }, [hardware]);

  const save = useCallback(async (next: LocalInferencePreference) => {
    setSaving(true);
    setError(null);
    try {
      await invoke('settings:set', { key: LOCAL_INFERENCE_SETTING_KEY, value: next });
      setPreference(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }, []);

  async function selectPreset(preset: ResourcePreset): Promise<void> {
    await save({ ...preference, preset, numThreads: presetThreads(preset, limit) });
  }

  async function selectComputeMode(computeMode: ComputeMode): Promise<void> {
    await save({ ...preference, computeMode });
  }

  async function changeThreads(numThreads: number): Promise<void> {
    await save({ ...preference, numThreads: Math.max(1, Math.min(limit, Math.floor(numThreads))) });
  }

  async function refreshHardware(): Promise<void> {
    if (!onRefreshHardware) return;
    setRefreshing(true);
    setError(null);
    try {
      await onRefreshHardware();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRefreshing(false);
    }
  }

  const disabled = !loaded || !hardware || saving;
  return (
    <section className="resource-settings" aria-labelledby="resource-settings-title">
      <div className="resource-settings__header">
        <div>
          <h3 id="resource-settings-title">Recursos para modelos locales</h3>
          <p>CPU: {hardware ? `${hardware.cpu.name} · ${limit} hilos detectados` : 'detectando hardware…'}</p>
          <p>RAM: {hardware ? `${formatBytes(hardware.ram.freeBytes)} libres de ${formatBytes(hardware.ram.totalBytes)}` : 'detectando memoria…'}</p>
          <p>GPU: {gpuLabel}</p>
        </div>
        {onRefreshHardware && (
          <button type="button" disabled={refreshing} onClick={() => void refreshHardware()}>
            {refreshing ? 'Actualizando…' : 'Actualizar hardware'}
          </button>
        )}
      </div>

      <fieldset disabled={disabled} className="resource-settings__controls">
        <legend>Perfil de CPU</legend>
        <div className="resource-settings__presets">
          {(Object.keys(PRESET_LABEL) as ResourcePreset[]).map((preset) => (
            <label key={preset}>
              <input type="radio" name="resource-preset" checked={preference.preset === preset} onChange={() => void selectPreset(preset)} />
              {PRESET_LABEL[preset]} ({presetThreads(preset, limit)} hilos)
            </label>
          ))}
        </div>
        <label className="resource-settings__threads">
          Hilos por respuesta: {preference.numThreads} de {limit}
          <input type="range" min="1" max={limit} value={preference.numThreads} onChange={(event) => void changeThreads(Number(event.target.value))} />
        </label>

        <span className="resource-settings__legend">Uso de cómputo</span>
        <div className="resource-settings__presets">
          <label><input type="radio" name="resource-compute" checked={preference.computeMode === 'auto'} onChange={() => void selectComputeMode('auto')} /> Automático GPU/CPU</label>
          <label><input type="radio" name="resource-compute" checked={preference.computeMode === 'cpu'} onChange={() => void selectComputeMode('cpu')} /> Solo CPU</label>
        </div>
      </fieldset>
      <p className="resource-settings__scope">
        Se aplica sólo a cada respuesta de Ollama local que elijas en SaurioLLM. No cambia la configuración global de Ollama, no mueve RAM a VRAM y no reduce el contexto del chat.
      </p>
      {error && <div className="saurio-banner danger" role="alert">No se pudieron guardar los recursos: {error}</div>}
    </section>
  );
}
