// Panel "Rendimiento" (MVP, doc 14 §9 "UI": franja de sistema, franja de runtime, diagnósticos
// básicos; §12 "Imprescindible para el MVP"). CPU/RAM siempre; GPU/nvidia-smi solo bajo demanda
// (botón "Actualizar", nunca poll continuo en el MVP — doc 14 §8).
// apps/desktop/src/renderer/src/features/perf/PerfPanel.tsx.
//
// Pasada de diseño #6: misma pasada de tokens que Modelos/Ajustes — header con título + acción,
// tabla de métricas con separadores sutiles (`.saurio-metric-table`) y un estado vacío con guía en
// vez de un botón suelto contra el fondo.
import { useEffect } from 'react';
import { usePerfStore } from '../../stores/perfStore.js';
import { formatBytes } from '../models/format.js';
import { formatPct, metricBadgeClass } from './format.js';
import { GaugeIcon } from '../../ui/icons.js';
import { Sparkline } from './Sparkline.js';
import './perf.css';

export function PerfPanel(): React.JSX.Element {
  const snapshot = usePerfStore((s) => s.snapshot);
  const history = usePerfStore((s) => s.history);
  const error = usePerfStore((s) => s.error);
  const loading = usePerfStore((s) => s.loading);
  const refresh = usePerfStore((s) => s.refresh);
  const subscribe = usePerfStore((s) => s.subscribe);
  const setPanelOpen = usePerfStore((s) => s.setPanelOpen);

  useEffect(() => {
    void refresh();
    // `metrics:tick` (doc 04 §16 RendererEvents) solo se emite mientras este panel está abierto
    // (doc 14 §6); `perfStore` ya modela ese contrato con `panelOpen` + `subscribe()` sobre el
    // cliente IPC tipado (`ipc/client.ts`), así que este panel solo avisa que está montado en vez
    // de castear `window.saurio` a una firma de `onEvent` que no coincide con el preload real
    // (ese cast — `onEvent(cb)` de un solo argumento — rompía el montaje: `PreloadApi.onEvent` es
    // `onEvent(channel, cb)`).
    setPanelOpen(true);
    subscribe();
    return () => setPanelOpen(false);
  }, [refresh, subscribe, setPanelOpen]);

  if (!snapshot) {
    return (
      <div>
        {error && <div className="saurio-banner danger">{error}</div>}
        <div className="saurio-empty-state">
          <span className="saurio-empty-state__icon"><GaugeIcon width={20} height={20} /></span>
          <span className="saurio-empty-state__title">Sin mediciones todavía</span>
          <span className="saurio-empty-state__hint">
            CPU, RAM y GPU no se miden solas en el MVP (doc 14 §8) — pedí una medición para ver el
            estado del sistema y del runtime.
          </span>
          <button type="button" className="saurio-btn-primary" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Midiendo…' : 'Medir ahora'}
          </button>
        </div>
      </div>
    );
  }

  const { system, loaded, queue, slots, diagnostics } = snapshot;
  const cpuHistory = history.map((h) => h.cpuPct);
  const ramHistory = history.map((h) => h.ramUsedBytes / (1024 * 1024 * 1024)); // GiB para que el eje tenga sentido
  const gpuHistory = history.filter((h) => h.gpuUtilPct !== undefined).map((h) => h.gpuUtilPct as number);

  return (
    <div>
      <div className="saurio-panel__header">
        <strong className="saurio-panel__title"><GaugeIcon width={16} height={16} className="saurio-perf-title-icon" />Rendimiento</strong>
        <button onClick={() => void refresh()} disabled={loading}>{loading ? 'Midiendo…' : 'Actualizar (nvidia-smi)'}</button>
      </div>
      {error && <div className="saurio-banner danger">{error}</div>}

      <h3>Sistema</h3>
      <table className="saurio-metric-table">
        <tbody>
          <tr><td>CPU</td><td>{formatPct(system.cpuPct.value)} <span className={`saurio-badge ${metricBadgeClass(system.cpuPct.quality)}`}>{system.cpuPct.quality}</span></td></tr>
          <tr><td>RAM usada</td><td>{formatBytes(system.ramUsedBytes.value)} <span className={`saurio-badge ${metricBadgeClass(system.ramUsedBytes.quality)}`}>{system.ramUsedBytes.quality}</span></td></tr>
          {system.gpuUtilPct && <tr><td>GPU</td><td>{formatPct(system.gpuUtilPct.value)} <span className={`saurio-badge ${metricBadgeClass(system.gpuUtilPct.quality)}`}>{system.gpuUtilPct.quality}</span></td></tr>}
          {system.vramUsedBytes && <tr><td>VRAM usada</td><td>{formatBytes(system.vramUsedBytes.value)} <span className={`saurio-badge ${metricBadgeClass(system.vramUsedBytes.quality)}`}>{system.vramUsedBytes.quality}</span></td></tr>}
          {system.gpuTempC && <tr><td>Temp. GPU</td><td>{system.gpuTempC.value.toFixed(0)}°C <span className={`saurio-badge ${metricBadgeClass(system.gpuTempC.quality)}`}>{system.gpuTempC.quality}</span></td></tr>}
          {system.powerW && <tr><td>Potencia</td><td>{system.powerW.value.toFixed(0)} W <span className={`saurio-badge ${metricBadgeClass(system.powerW.quality)}`}>{system.powerW.quality}</span></td></tr>}
          <tr><td>Proceso SaurioLLM (RSS)</td><td>{formatBytes(system.appRssBytes.value)} <span className={`saurio-badge ${metricBadgeClass(system.appRssBytes.quality)}`}>{system.appRssBytes.quality}</span></td></tr>
        </tbody>
      </table>
      {!system.gpuUtilPct && (
        <p className="saurio-empty">Sin datos de GPU (nvidia-smi no disponible o no se pidió todavía).</p>
      )}

      {history.length >= 2 && (
        <>
          <h3>Historial (últimos {Math.round(history.length * 2)}s en memoria)</h3>
          <div className="saurio-perf-history">
            <div>
              <span className="saurio-perf-history__label">CPU %</span>
              <Sparkline values={cpuHistory} max={100} ariaLabel="Historial de CPU" />
            </div>
            <div>
              <span className="saurio-perf-history__label">RAM usada (GiB)</span>
              <Sparkline values={ramHistory} color="var(--warning)" ariaLabel="Historial de RAM" />
            </div>
            {gpuHistory.length >= 2 && (
              <div>
                <span className="saurio-perf-history__label">GPU %</span>
                <Sparkline values={gpuHistory} max={100} color="var(--success)" ariaLabel="Historial de GPU" />
              </div>
            )}
          </div>
        </>
      )}

      <h3>Runtime</h3>
      <p className="saurio-perf-meta">Slots: {slots.length === 0 ? 'sin slots activos' : slots.map((s) => `${s.slotId}:${s.state}`).join(', ')}</p>
      <p className="saurio-perf-meta">
        Modelos cargados: {loaded.length === 0 ? 'ninguno' : loaded.map((m) => `${m.name} (${formatBytes(m.sizeVram)}/${formatBytes(m.size)} ctx=${m.contextLength})`).join(', ')}
      </p>
      <p className="saurio-perf-meta">
        Cola: {queue.length === 0 ? 'vacía' : `${queue.length} job(s) esperando — ${queue.map((q) => q.priority).join(', ')}`}
      </p>

      <h3>Diagnósticos</h3>
      {diagnostics.length === 0 ? (
        <p className="saurio-empty">Sin alertas activas.</p>
      ) : (
        <div className="saurio-row-list">
          {diagnostics.map((d, i) => (
            <div key={`${d.code}-${i}`} className="saurio-row">
              <div className="saurio-row__header">
                <strong className="saurio-row__title">{d.message}</strong>
              </div>
              {d.suggestedAction && (
                <div className="saurio-row__line saurio-perf-diagnostic__action">{d.suggestedAction.label}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
