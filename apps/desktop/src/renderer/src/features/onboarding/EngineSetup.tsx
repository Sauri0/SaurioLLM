import { useCallback, useEffect, useState } from 'react';
import type { IpcOutput } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { useModelsStore } from '../../stores/modelsStore.js';
import { formatBytes } from '../models/format.js';
import './engineSetup.css';

type Status = IpcOutput<'engine:status'>;
const ACTIVE = ['checking', 'downloading', 'verifying', 'extracting'];
const PHASE_LABEL: Record<Status['phase'], string> = {
  missing: 'Prepará tu motor local', checking: 'Consultando el paquete oficial…', downloading: 'Descargando motor…',
  verifying: 'Verificando integridad…', extracting: 'Preparando archivos…', installed: 'Motor preparado',
  cancelled: 'Descarga cancelada', error: 'No se pudo preparar el motor',
};

export function EngineSetup({ onReady }: { onReady?: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  const busy = connecting || Boolean(status && ACTIVE.includes(status.phase));
  const refresh = useCallback(async () => setStatus(await invoke('engine:status', undefined)), []);

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try { const next = await invoke('engine:status', undefined); if (!disposed) setStatus(next); }
      catch (reason) { if (!disposed) setError(String(reason)); }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, []);

  async function install(): Promise<void> {
    setError(undefined);
    try { setStatus(await invoke('engine:install', undefined)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function connect(mode: 'managed' | 'external'): Promise<void> {
    setConnecting(true); setError(undefined);
    try {
      const result = await invoke('engine:select', { mode });
      if (!result.running) throw new Error(result.error === 'ollama_not_installed'
        ? 'No encontramos un motor instalado. Elegí Preparar motor local.' : result.error ?? 'El motor no respondió.');
      await useModelsStore.getState().refresh({ refresh: true });
      await refresh();
      onReady?.();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setConnecting(false); }
  }
  return <section className="engine-setup" aria-label="Motor local">
    <div className="engine-setup__title"><strong>{connecting ? 'Conectando motor…' : status ? PHASE_LABEL[status.phase] : 'Consultando motor…'}</strong>
      {status?.version && <span className="saurio-badge">{status.version}</span>}</div>
    <p>SaurioLLM descarga y prepara Ollama en su propio espacio. No necesitás instalar programas ni usar una consola.</p>
    <p className="saurio-text-dim">Requiere conexión para la descarga y espacio para el motor (aproximadamente 1,5 GB de descarga, 5 GB de preparación) más el modelo. Después, el chat local puede funcionar sin conexión.</p>
    {status && ACTIVE.includes(status.phase) && <div className="engine-setup__progress" role="status">
      <progress max={status.totalBytes ?? 1} value={status.totalBytes ? status.completedBytes : undefined} />
      <span>{formatBytes(status.completedBytes)}{status.totalBytes ? ` / ${formatBytes(status.totalBytes)}` : ''}</span>
      <button type="button" onClick={() => void invoke('engine:cancel', undefined).then(refresh).catch((reason) => setError(String(reason)))}>Cancelar</button>
    </div>}
    {(error || status?.error) && <p className="saurio-banner danger" role="alert">{error ?? status?.error}</p>}
    <div className="engine-setup__actions">
      {status?.hasManaged && <button type="button" className="saurio-btn-primary" disabled={busy} onClick={() => void connect('managed')}>Usar motor de SaurioLLM</button>}
      <button type="button" className={status?.hasManaged ? 'saurio-btn-ghost' : 'saurio-btn-primary'} disabled={busy} onClick={() => void install()}>
        {status?.hasManaged ? 'Buscar actualización del motor' : status?.phase === 'error' || status?.phase === 'cancelled' ? 'Reintentar instalación' : 'Preparar motor local'}
      </button>
      <button type="button" className="saurio-btn-ghost" disabled={busy} onClick={() => void connect('external')}>Usar mi Ollama existente</button>
    </div>
    <small>Motor actual: {status?.mode === 'managed' ? 'administrado por SaurioLLM' : 'Ollama externo'}. Las claves API se configuran por separado.</small>
  </section>;
}
