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
import type { LoadedModel, MemoryEstimate, ModelInfo, ModelsFolderInfo, ProviderHealth } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { useModelsStore } from '../../stores/modelsStore.js';
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

  return (
    <div>
      <div className="saurio-panel__header">
        <strong className="saurio-panel__title">
          <CpuIcon width={16} height={16} className="saurio-models-title-icon" />
          Centro de modelos <span className="saurio-badge local">LOCAL</span>
        </strong>
        <button onClick={() => void refresh(true)} disabled={loading || demo}>{loading ? 'Actualizando…' : 'Actualizar'}</button>
      </div>

      {anyProviderDown && <div className="saurio-banner danger">Ollama no está corriendo (provider:health falló).</div>}
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

      {shownModels.length === 0 && !loading ? (
        <div className="saurio-empty-state">
          <span className="saurio-empty-state__icon"><CpuIcon width={20} height={20} /></span>
          <span className="saurio-empty-state__title">Sin modelos instalados</span>
          <span className="saurio-empty-state__hint">
            Instalá un modelo con Ollama (<code>ollama pull qwen3:8b</code>) y volvé a &quot;Actualizar&quot;,
            o revisá que Ollama esté corriendo.
          </span>
        </div>
      ) : (
        <div className="saurio-row-list">
          {shownModels.map((model) => {
            const isLoaded = shownLoaded.some((l) => l.name === model.ref.name);
            const fit = shownFitByName[model.ref.name];
            const numCtxUsed = numCtxByName[model.ref.name] ?? NUM_CTX_DEFAULT;
            return (
              <div key={model.ref.name} className="saurio-row">
                <div className="saurio-row__header">
                  <strong className="saurio-mono saurio-row__title">{model.ref.name}</strong>
                  <span className="saurio-row__badges">
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
