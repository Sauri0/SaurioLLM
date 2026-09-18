// Barra de estado inferior: modelo activo, contexto usado, tok/s, LOCAL y Ollama conectado
// (pasada de diseño visual — doc 01 §4.1 "Paneles del MVP"). apps/desktop/src/renderer/src/layout/StatusBar.tsx.
//
// Solo pinta: lee de los stores ya existentes (chatStore, runStore, modelsStore) y hace una
// comprobación de `provider:health` propia (mismo canal que ya usa features/models/ModelsPanel.tsx)
// para el punto de "Ollama conectado". No agrega lógica de negocio ni contratos IPC nuevos.
import { useEffect, useState } from 'react';
import { invoke } from '../ipc/client.js';
import { useChatStore } from '../stores/chatStore.js';
import { useRunStore } from '../stores/runStore.js';
import { useModelsStore } from '../stores/modelsStore.js';
import { CpuIcon, GaugeIcon, PlugIcon } from '../ui/icons.js';
import { isDemoMode } from '../demo/demoState.js';
import { formatContextPair } from '../ui/formatTokens.js';

function genTps(promptTokens: number | undefined, evalTokens: number | undefined, evalMs: number | undefined): number | undefined {
  if (evalTokens === undefined || evalMs === undefined || evalMs <= 0) return undefined;
  return (evalTokens / evalMs) * 1000;
}

export interface StatusBarProps {
  projectId: string | null;
  chatId: string | null;
}

/** PRIORIDAD CERO puntos 1/2/7 (bloqueo real: "Ollama instalado pero apagado", la app no lo
 *  reflejaba ni ofrecía arrancarlo). Antes `provider:health` se pedía UNA sola vez al montar el
 *  componente: si Ollama se caía o volvía a arrancar durante la sesión, la barra de estado nunca se
 *  actualizaba. 8s es corto para notarlo rápido sin martillar el proceso de Ollama con requests. */
const HEALTH_POLL_MS = 8000;

export function StatusBar({ projectId, chatId }: StatusBarProps): React.JSX.Element {
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | undefined>(undefined);
  const draftModelRef = useChatStore((s) => (projectId ? s.draftModelRefByProject[projectId] : undefined));
  const messages = useRunStore((s) => (chatId ? s.messagesByChat[chatId] : undefined));
  const metricsByMessage = useRunStore((s) => s.metricsByMessage);
  const installed = useModelsStore((s) => s.installed);

  useEffect(() => {
    // Modo demo (herramienta de verificación visual, pasada de diseño #4): mostrar "Ollama no
    // conectado" en rojo junto a un modelo activo con métricas es contradictorio — acá no hay
    // runtime real detrás, así que se muestra conectado sin pedir `provider:health`. Fuera de
    // demo, este valor siempre refleja la respuesta real de `provider:health`.
    if (isDemoMode()) {
      setOllamaOk(true);
      return;
    }
    let cancelled = false;
    function checkHealth(): void {
      void invoke('provider:health', undefined)
        .then((health) => { if (!cancelled) setOllamaOk(health.every((h) => h.ok)); })
        .catch(() => { if (!cancelled) setOllamaOk(false); });
    }
    checkHealth();
    const interval = setInterval(checkHealth, HEALTH_POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  async function handleStartOllama(): Promise<void> {
    setStarting(true);
    setStartError(undefined);
    try {
      const result = await invoke('ollama:ensureRunning', undefined);
      if (result.running) {
        setOllamaOk(true);
      } else {
        setStartError(
          result.error === 'ollama_not_installed'
            ? 'Ollama no está instalado en este equipo.'
            : 'Ollama no respondió a tiempo. Probá de nuevo en unos segundos.',
        );
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  const lastMessageId = messages && messages.length > 0 ? messages[messages.length - 1]!.id : undefined;
  const lastMetrics = lastMessageId ? metricsByMessage[lastMessageId] : undefined;
  const tps = lastMetrics ? genTps(lastMetrics.promptTokens, lastMetrics.evalTokens, lastMetrics.evalMs) : undefined;

  const modelInfo = draftModelRef ? installed.find((m) => m.ref.name === draftModelRef.name) : undefined;
  const contextUsed = lastMetrics?.promptTokens !== undefined && lastMetrics.evalTokens !== undefined
    ? lastMetrics.promptTokens + lastMetrics.evalTokens
    : undefined;

  return (
    <footer className="saurio-statusbar" role="contentinfo" aria-label="Estado del runtime">
      <span className="saurio-statusbar__item" title="Todos los modelos de este MVP son locales">
        <span className="saurio-badge local">LOCAL</span>
      </span>

      {draftModelRef && (
        <span className="saurio-statusbar__item saurio-mono" title="Modelo activo">
          <CpuIcon />
          {draftModelRef.name}
        </span>
      )}

      <span className="saurio-statusbar__sep" aria-hidden="true" />

      <span className="saurio-statusbar__item" title="Tokens de contexto usados en el último mensaje">
        Contexto: {formatContextPair(contextUsed, modelInfo?.contextMax) ?? '—'}
      </span>

      <span className="saurio-statusbar__item" title="Tokens por segundo del último mensaje generado">
        <GaugeIcon />
        {tps !== undefined ? `${tps.toFixed(1)} tok/s` : '— tok/s'}
      </span>

      <span className="saurio-statusbar__spacer" />

      <span className="saurio-statusbar__item" title={startError ?? (ollamaOk === false ? 'provider:health respondió con error' : undefined)}>
        <PlugIcon />
        <span className={`saurio-statusbar__dot ${ollamaOk ? 'ok' : 'down'}`} aria-hidden="true" />
        {starting
          ? 'Iniciando motor local…'
          : ollamaOk === null ? 'Comprobando Ollama…' : ollamaOk ? 'Ollama conectado' : 'Ollama no conectado'}
      </span>
      {!starting && ollamaOk === false && !isDemoMode() && (
        <button type="button" className="saurio-btn-ghost saurio-statusbar__start-ollama" onClick={() => void handleStartOllama()}>
          Iniciar Ollama
        </button>
      )}
    </footer>
  );
}
