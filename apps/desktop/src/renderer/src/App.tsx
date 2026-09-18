// Raíz del renderer: layout completo de SaurioLLM (doc 01 §4.1, doc 02 §1/§2) más el smoke test
// de IPC del scaffolding original (`?smoke=1`, doc 02 §1), que se conserva sin cambios de
// comportamiento para no romper la verificación de scaffolding ya existente.
import { useEffect, useState } from 'react';
import type { IpcOutput } from '@saurio/shared';
import { invoke } from './ipc/client.js';
import { AppLayout } from './layout/index.js';
import './App.css';

type PingResult = IpcOutput<'app:ping'>;
type ModelsResult = IpcOutput<'models:list'>;

export function App(): React.JSX.Element {
  const [smokeResult, setSmokeResult] = useState<PingResult | null>(null);
  const [smokeModels, setSmokeModels] = useState<ModelsResult | null>(null);
  const [smokeError, setSmokeError] = useState<string | null>(null);
  const isSmoke = new URLSearchParams(window.location.search).get('smoke') === '1';

  useEffect(() => {
    if (!isSmoke) return;
    void (async () => {
      try {
        setSmokeResult(await invoke('app:ping', { sentAt: Date.now() }));
        // Integración del MVP: el smoke también comprueba que el gateway responde de verdad contra
        // Ollama (127.0.0.1:11434) y no solo que el IPC está vivo.
        setSmokeModels(await invoke('models:list', { refresh: true }));
      } catch (err) {
        setSmokeError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [isSmoke]);

  if (isSmoke) {
    // Ruta de verificación del scaffolding (doc 02 §1): no monta el layout completo para
    // mantener el smoke test aislado del resto de la app.
    return (
      <main className="saurio-scaffold-smoke">
        <h1>SaurioLLM</h1>
        <p>Esqueleto del monorepo — smoke test de IPC.</p>
        {smokeResult && <pre data-testid="ping-result">{JSON.stringify(smokeResult, null, 2)}</pre>}
        {smokeModels && <pre data-testid="models-result">{JSON.stringify(smokeModels.map((m) => m.ref.name), null, 2)}</pre>}
        {smokeError && <p className="saurio-scaffold-smoke__error">Error: {smokeError}</p>}
      </main>
    );
  }

  return <AppLayout />;
}
