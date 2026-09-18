// Centro de modelos (MVP, doc 13 §10 "Instalados" + §12 "Imprescindible para el MVP"): modelos
// instalados con capabilities/tamaño/fit estimado, cargado/no cargado vía el poller único de
// ModelManager (`models:loaded`), carpeta detectada, badge LOCAL, aviso si Ollama no corre y
// avisos del modo attach (exposición en red / contexto 256K de la app de bandeja).
// apps/desktop/src/renderer/src/features/models/ModelsPanel.tsx.
//
// Pasada de diseño #6: mismo tratamiento visual que el resto de los paneles (filas con
// `.saurio-row`, badges medido/estimado/no disponible, título + acción arriba) más un estado vacío
// con guía. En modo demo (herramienta de verificación visual) no pide `models:list`/`provider:health`
// de verdad — usa lo que `demo/demoState.ts` ya sembró en `useModelsStore`, para poder capturar este
// panel sin depender de que Ollama esté corriendo en la máquina que toma la captura.
import { useCallback, useEffect, useState } from 'react';
import type { LoadedModel, MemoryEstimate, ModelInfo, ModelRef, ModelsFolderInfo, ProviderHealth } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { useModelsStore } from '../../stores/modelsStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { isDemoMode } from '../../demo/demoState.js';
import { fitClassLabel, formatBytes, qualitySuffix } from './format.js';
import { CpuIcon } from '../../ui/icons.js';
import { ExploreTab } from './ExploreTab.js';
import { DownloadsTab } from './DownloadsTab.js';
import { NUM_CTX_GLOBAL_DEFAULT, NUM_CTX_SETTINGS_KEY, isNumCtxDefaults, numCtxFor, type NumCtxDefaults } from './numCtxDefaults.js';
import './models.css';

type ModelsTab = 'installed' | 'explore' | 'downloads';

// DEFAULTS DEL MVP en esta máquina (nota de medición del encargo): 8192 para qwen3:8b / qwen2.5-coder:7b.
// Editable por modelo desde Ajustes (punto 4 del encargo: "numCtx por defecto por modelo") — ver
// features/settings/SettingsPanel.tsx y numCtxDefaults.ts.
const NUM_CTX_DEFAULT = NUM_CTX_GLOBAL_DEFAULT;

/** Ficha de ejemplo para el modo demo — mismo `models:folderInfo` que devolvería main en esta
 *  máquina (doc: "N:\OllamaModels, variable de usuario Y de máquina"), sin pedirlo de verdad. */
function demoFolderInfo(): ModelsFolderInfo {
  return {
    path: 'N:\\OllamaModels', source: 'env:user', validated: true,
    freeBytes: 480_359_034_880, totalBytes: 2_000_000_000_000, spaceQuality: 'measured',
    warnings: [
      { code: 'context_256k_default', message: 'El servidor de Ollama tiene un contexto por defecto de 256K (app de bandeja); SaurioLLM siempre manda options.numCtx explícito.' },
      { code: 'network_exposed', message: 'SaurioLLM no puede confirmar a qué red escucha Ollama; esto es una estimación basada en tu configuración, no una detección certera.' },
    ],
  };
}

/** Ajuste de ejemplo para el modo demo — mismo `MemoryEstimate` que devolvería `models:fits` en un
 *  equipo con esta GPU, pero sin pedirlo de verdad (no depende de Ollama). */
function demoFit(): MemoryEstimate {
  return { vramNeededBytes: 5_400_000_000, vramAvailableBytes: 8_000_000_000, fitClass: 'fits_gpu', quality: 'measured', source: 'model_compat' };
}

function capabilityChips(caps: ModelInfo['capabilities']): string {
  return (Object.entries(caps) as [keyof ModelInfo['capabilities'], boolean][])
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join(', ') || 'sin capabilities declaradas';
}

/** Pestaña "Instalados" (doc 13 §10, MVP): contenido original de este panel antes de la pasada de
 *  Centro de modelos v0.2/v0.3, sin cambios de comportamiento — solo se movió a su propio componente
 *  para poder convivir con "Explorar" y "Descargas" bajo la misma barra de pestañas. */
function InstalledTab(): React.JSX.Element {
  const demo = isDemoMode();
  const demoInstalled = useModelsStore((s) => s.installed);
  const demoLoaded = useModelsStore((s) => s.loaded);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loaded, setLoaded] = useState<LoadedModel[]>([]);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [fitByName, setFitByName] = useState<Record<string, MemoryEstimate>>({});
  const [numCtxByName, setNumCtxByName] = useState<Record<string, number>>({});
  const [folderInfo, setFolderInfo] = useState<ModelsFolderInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [startingOllama, setStartingOllama] = useState(false);
  const [startOllamaError, setStartOllamaError] = useState<string | null>(null);

  // Punto 1 del feedback post-v0.1: "cuál está en uso en el chat actual", con botón "Usar en este
  // chat" (selectores por campo, no un objeto literal — bug ya documentado en doc 16 §10.3 con
  // useSyncExternalStore/React 19: un objeto nuevo en cada render nunca es `Object.is` igual).
  const currentChatId = useChatStore((s) => s.currentChatId);
  const chatsByProject = useChatStore((s) => s.chatsByProject);
  const setChatModel = useChatStore((s) => s.setChatModel);
  const currentChatModelName = currentChatId
    ? Object.values(chatsByProject).flat().find((c) => c.id === currentChatId)?.modelRef?.name
    : undefined;
  const [usingModel, setUsingModel] = useState<string | null>(null);

  const refresh = useCallback(async (force: boolean) => {
    if (demo) return; // ver nota de arriba: el modo demo usa `useModelsStore`, sembrado sin IPC.
    setLoading(true);
    setError(null);
    try {
      const [installed, loadedModels, providerHealth, folder, numCtxSetting] = await Promise.all([
        invoke('models:list', { refresh: force }),
        invoke('models:loaded', undefined),
        invoke('provider:health', undefined),
        invoke('models:folderInfo', undefined).catch(() => null),
        invoke('settings:get', { key: NUM_CTX_SETTINGS_KEY }).catch(() => undefined),
      ]);
      setModels(installed);
      setLoaded(loadedModels);
      setHealth(providerHealth);
      setFolderInfo(folder);
      // Punto 4 del encargo: "numCtx por defecto por modelo" (Ajustes) ahora alimenta de verdad el
      // ajuste estimado de este panel en vez de un único NUM_CTX_DEFAULT fijo para todos los modelos.
      const numCtxDefaults: NumCtxDefaults = isNumCtxDefaults(numCtxSetting) ? numCtxSetting : {};
      const numCtxMap = Object.fromEntries(installed.map((m) => [m.ref.name, numCtxFor(m.ref.name, numCtxDefaults)]));
      setNumCtxByName(numCtxMap);

      const fits = await Promise.all(
        installed.map(async (model) => {
          try {
            const numCtx = numCtxMap[model.ref.name] ?? NUM_CTX_DEFAULT;
            return [model.ref.name, await invoke('models:fits', { ref: model.ref, numCtx })] as const;
          } catch {
            return [model.ref.name, null] as const;
          }
        }),
      );
      setFitByName(Object.fromEntries(fits.filter((entry): entry is [string, MemoryEstimate] => entry[1] !== null)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [demo]);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const shownModels = demo ? demoInstalled : models;
  const shownLoaded = demo ? demoLoaded : loaded;
  const shownHealth = demo ? [{ providerId: 'ollama', ok: true }] : health;
  const shownFitByName = demo ? Object.fromEntries(shownModels.map((m) => [m.ref.name, demoFit()])) : fitByName;
  const shownFolderInfo = demo ? demoFolderInfo() : folderInfo;
  const anyProviderDown = shownHealth.some((h) => !h.ok);

  /** Punto 2 del feedback post-v0.1: banner con botón "Iniciar Ollama" (canal `ollama:ensureRunning`,
   *  agregado por el otro agente en paralelo en esta misma sesión — `main/ipc/ollama.ts` +
   *  `OllamaProcessManager`). Si el canal todavía no respondiera (encargo: "usá invoke tolerante y
   *  mostrá la instrucción manual"), el `catch` deja el mensaje manual en vez de romper la UI. */
  async function handleStartOllama(): Promise<void> {
    setStartingOllama(true);
    setStartOllamaError(null);
    try {
      const result = await invoke('ollama:ensureRunning', undefined);
      if (result.running) {
        await refresh(true);
      } else {
        setStartOllamaError(
          result.error === 'ollama_not_installed'
            ? 'Ollama no está instalado en este equipo — instalalo desde ollama.com/download y volvé a intentar.'
            : 'Ollama no respondió a tiempo. Probá de nuevo en unos segundos, o abrí la app de Ollama manualmente.',
        );
      }
    } catch (err) {
      // Tolerante: si el canal todavía no existe en esta build, no rompe la UI — deja la instrucción
      // manual (encargo, punto 2 del feedback).
      setStartOllamaError(
        `No se pudo pedirle a la app que inicie Ollama (${err instanceof Error ? err.message : String(err)}). ` +
        'Abrí la app de Ollama manualmente, o ejecutá "ollama serve" en una terminal.',
      );
    } finally {
      setStartingOllama(false);
    }
  }

  async function handleUseInChat(ref: ModelRef): Promise<void> {
    if (!currentChatId) return;
    setUsingModel(ref.name);
    try {
      await setChatModel(currentChatId, ref);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUsingModel(null);
    }
  }

  return (
    <div>
      <div className="saurio-panel__header">
        <strong className="saurio-panel__title">
          <CpuIcon width={16} height={16} className="saurio-models-title-icon" />
          Centro de modelos <span className="saurio-badge local">LOCAL</span>
        </strong>
        <button onClick={() => void refresh(true)} disabled={loading || demo}>{loading ? 'Actualizando…' : 'Actualizar'}</button>
      </div>

      {anyProviderDown && !demo && (
        <div className="saurio-banner danger">
          <div>Ollama no está corriendo — por eso no se ve ningún modelo.</div>
          <div className="saurio-row__line">
            <button type="button" className="saurio-btn-primary" onClick={() => void handleStartOllama()} disabled={startingOllama}>
              {startingOllama ? 'Iniciando…' : 'Iniciar Ollama'}
            </button>
          </div>
          {startOllamaError && <div className="saurio-row__line saurio-row__line--muted">{startOllamaError}</div>}
        </div>
      )}
      {error && <div className="saurio-banner danger">{error}</div>}

      {/* Punto 2 del encargo / doc 13 §6, §12: carpeta OLLAMA_MODELS detectada + espacio libre.
          `ModelManager.detectedModelsFolder()`/`.attachWarnings()` ya existían (doc 16 §12 solo
          registraba la falta de canal IPC); acá se muestran sus avisos en modo lectura, sin ningún
          botón que cambie configuración de Ollama (doc 13 §6: "nunca la cambia sin autorización"). */}
      {shownFolderInfo && (
        <div className="saurio-row saurio-models-folder-row">
          <div className="saurio-row__header">
            <span className="saurio-row__title">Carpeta de modelos detectada</span>
            <span className={`saurio-badge ${shownFolderInfo.validated ? 'measured' : 'estimated'}`}>
              {shownFolderInfo.validated ? 'validada' : 'sin validar'}
            </span>
          </div>
          <div className="saurio-row__meta saurio-mono">{shownFolderInfo.path}</div>
          <div className="saurio-row__line">
            Origen: {shownFolderInfo.source === 'env:user' ? 'variable de usuario' : shownFolderInfo.source === 'env:machine' ? 'variable de máquina' : 'default'}
            {shownFolderInfo.spaceQuality === 'measured' && shownFolderInfo.freeBytes !== undefined && shownFolderInfo.totalBytes !== undefined && (
              <> · {formatBytes(shownFolderInfo.freeBytes)} libres de {formatBytes(shownFolderInfo.totalBytes)}</>
            )}
            {shownFolderInfo.spaceQuality === 'unavailable' && <> · espacio libre no disponible</>}
          </div>
        </div>
      )}
      {(shownFolderInfo?.warnings ?? []).map((warning) => (
        <div key={warning.code} className="saurio-banner">{warning.message}</div>
      ))}
      {!shownFolderInfo && (
        <div className="saurio-banner">
          Contexto por defecto de 256K en la app de bandeja de Ollama: SaurioLLM siempre manda su
          propio `num_ctx` ({NUM_CTX_DEFAULT}) en cada request, pero si usás Ollama directamente
          desde otra herramienta, revisalo vos.
        </div>
      )}

      {/* Punto 2 del feedback post-v0.1: "cuando Ollama no responde, no mostrar listas vacías" — con
          el banner de arriba ya explicado, no hace falta además una lista vacía confusa acá. */}
      {anyProviderDown && !demo ? null : shownModels.length === 0 && !loading ? (
        <div className="saurio-empty-state">
          <span className="saurio-empty-state__icon"><CpuIcon width={20} height={20} /></span>
          <span className="saurio-empty-state__title">Todavía no tenés ningún modelo instalado</span>
          <span className="saurio-empty-state__hint">
            1. Anda a la pestaña &quot;Explorar&quot; y elegí un modelo (los que dicen &quot;Perfecto&quot; o
            &quot;Muy bueno&quot; andan mejor en esta PC).<br />
            2. Apretá &quot;Descargar&quot; y esperá a que termine — después vas a poder usarlo desde acá o
            desde un chat.
          </span>
        </div>
      ) : (
        <div className="saurio-row-list">
          {shownModels.map((model) => {
            const isLoaded = shownLoaded.some((l) => l.name === model.ref.name);
            const isCurrentChatModel = currentChatModelName === model.ref.name;
            const fit = shownFitByName[model.ref.name];
            const numCtxUsed = numCtxByName[model.ref.name] ?? NUM_CTX_DEFAULT;
            return (
              <div key={model.ref.name} className="saurio-row">
                <div className="saurio-row__header">
                  <strong className="saurio-mono saurio-row__title">{model.ref.name}</strong>
                  <span className="saurio-row__badges">
                    {isCurrentChatModel && <span className="saurio-badge measured">en uso en este chat</span>}
                    <span className={`saurio-badge ${isLoaded ? 'measured' : ''}`}>{isLoaded ? 'cargado' : 'no cargado'}</span>
                    <span className="saurio-badge local">{model.ref.locality}</span>
                  </span>
                </div>
                <div className="saurio-row__meta">
                  {model.family} · {model.parameterSize} · {model.quantization} · {formatBytes(model.sizeBytes)}
                  {model.contextMax && ` · contexto máx ${model.contextMax.toLocaleString('es-AR')}`}
                </div>
                <div className="saurio-row__line">Capabilities: {capabilityChips(model.capabilities)}</div>
                {fit && (
                  <div className="saurio-row__line">
                    Ajuste con num_ctx={numCtxUsed}: <strong>{fitClassLabel(fit.fitClass)}</strong>{' '}
                    <span className={`saurio-badge ${fit.quality}`}>{qualitySuffix(fit.quality)}</span>
                    {' '}({formatBytes(fit.vramNeededBytes)} de {formatBytes(fit.vramAvailableBytes)} VRAM)
                  </div>
                )}
                {/* Punto 1 del feedback post-v0.1: botón "Usar en este chat", con guía cuando no hay
                    ningún chat abierto (nunca queda sin explicación por qué está deshabilitado). */}
                {isCurrentChatModel ? (
                  <span className="saurio-row__line saurio-row__line--muted">Ya es el modelo de este chat.</span>
                ) : currentChatId ? (
                  <button type="button" className="saurio-btn-primary" disabled={usingModel === model.ref.name}
                    onClick={() => void handleUseInChat(model.ref)}>
                    {usingModel === model.ref.name ? 'Aplicando…' : 'Usar en este chat'}
                  </button>
                ) : (
                  <span className="saurio-row__line saurio-row__line--muted">Abrí o creá un chat para poder usarlo.</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Barra de pestañas Instalados/Explorar/Descargas (doc 13 §10) + filtro por uso (dentro de
 *  Explorar) + badge LOCAL/LAN/NUBE (doc 13 §9, ya presente en cada tarjeta). El modo demo (captura
 *  de UI sin Ollama) solo siembra "Instalados" — Explorar/Descargas piden IPC real, así que quedan
 *  fuera de la herramienta de verificación visual (no rompen: simplemente muestran su propio estado
 *  vacío/errores si se abren en modo demo). */
export function ModelsPanel(): React.JSX.Element {
  const [tab, setTab] = useState<ModelsTab>('installed');

  return (
    <div>
      <div className="saurio-subtabs">
        <button type="button" className={`saurio-subtab ${tab === 'installed' ? 'active' : ''}`} onClick={() => setTab('installed')}>
          Instalados
        </button>
        <button type="button" className={`saurio-subtab ${tab === 'explore' ? 'active' : ''}`} onClick={() => setTab('explore')}>
          Explorar
        </button>
        <button type="button" className={`saurio-subtab ${tab === 'downloads' ? 'active' : ''}`} onClick={() => setTab('downloads')}>
          Descargas
        </button>
      </div>
      {tab === 'installed' && <InstalledTab />}
      {tab === 'explore' && <ExploreTab />}
      {tab === 'downloads' && <DownloadsTab />}
    </div>
  );
}
