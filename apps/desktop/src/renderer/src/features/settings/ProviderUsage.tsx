import { useEffect, useState } from 'react';
import type { IpcOutput } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { formatUsd } from '../chat/costMetrics.js';

type Summary = IpcOutput<'providers:usageSummary'>;
const sessionStartedAt = performance.timeOrigin;

export function ProviderUsage(): React.JSX.Element {
  const [total, setTotal] = useState<Summary>();
  const [session, setSession] = useState<Summary>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const [all, current] = await Promise.all([invoke('providers:usageSummary', {}), invoke('providers:usageSummary', { since: sessionStartedAt })]);
        if (!disposed) { setTotal(all); setSession(current); setError(undefined); }
      } catch (reason) { if (!disposed) setError(String(reason)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  const row = (label: string, summary?: Summary) => <div className="saurio-row">
    <strong>{label}</strong>
    {!summary ? <span> Consultando…</span> : <>
      <div>USD informado: {summary.reportedCalls > 0 ? formatUsd(summary.reportedUsd) : 'sin datos'} · {summary.reportedCalls} llamadas con costo informado</div>
      {summary.estimatedCalls > 0 && <div>Estimación separada: {formatUsd(summary.estimatedUsd)} · {summary.estimatedCalls} llamadas</div>}
      <div className="saurio-text-dim">{summary.totalCalls} llamadas registradas · {summary.unavailableCalls} sin costo confirmado</div>
    </>}
  </div>;
  return <section aria-label="Uso y costo de proveedores">
    <h3>Uso y costo en SaurioLLM</h3>
    <p className="saurio-text-dim">Incluye respuestas, agentes y compactación registrados desde esta actualización. Los importes informados provienen del proveedor; las llamadas interrumpidas pueden tener cargos todavía desconocidos. No incluye el uso de tu cuenta desde otras aplicaciones.</p>
    {error && <p className="saurio-banner danger" role="alert">No se pudo leer el registro de uso: {error}</p>}
    {row('Esta apertura de la app', session)}
    {row('Historial registrado', total)}
  </section>;
}
