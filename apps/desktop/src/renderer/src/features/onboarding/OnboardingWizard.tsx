// Asistente de primer arranque (punto 5 del encargo) — apps/desktop/src/renderer/src/features/
// onboarding/OnboardingWizard.tsx. Vista fina sobre `onboardingLogic.ts` (la máquina de estados en
// sí, testeada aparte con vitest puro). Se muestra una sola vez (settings `onboarding.completed`) y
// se puede reabrir desde Ajustes > "Volver a ver el asistente de primer arranque"
// (stores/uiNavStore.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DownloadJob, Recommendation } from '@saurio/shared';
import { invoke, onEvent } from '../../ipc/client.js';
import { useUiNavStore } from '../../stores/uiNavStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { useProjectStore } from '../../stores/projectStore.js';
import { fitClassLabel, formatBytes } from '../models/format.js';
import { visibleDownloadError } from '../models/downloadUi.js';
import { reduceOnboarding, type OnboardingStep } from './onboardingLogic.js';
import { EngineSetup } from './EngineSetup.js';
import { canUseDownloadedModel, createDownloadStartGuard, findDownloadForModel, hydrateDownloads, isDownloadActive, mergeDownloadJob } from './downloadState.js';
import { recommendedModelTarget } from './onboardingSelection.js';
import './onboarding.css';

const ONBOARDING_COMPLETED_KEY = 'onboarding.completed';
const PERSONAL_PROJECT_ID = 'project_personal';
const DEFAULT_AGENT_ID = 'agent_builtin_lead';

export function OnboardingWizard(): React.JSX.Element | null {
  const open = useUiNavStore((s) => s.onboardingOpen);
  const openOnboarding = useUiNavStore((s) => s.openOnboarding);
  const closeOnboarding = useUiNavStore((s) => s.closeOnboarding);
  const [step, setStep] = useState<OnboardingStep>('checking');
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, DownloadJob>>({});
  const [downloadIds, setDownloadIds] = useState<Record<string, string>>({});
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [startingModels, setStartingModels] = useState<Set<string>>(new Set());
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  const downloadStartGuard = useRef(createDownloadStartGuard());
  const currentChatId = useChatStore((s) => s.currentChatId);
  const setChatModel = useChatStore((s) => s.setChatModel);
  const setDraftModelRef = useChatStore((s) => s.setDraftModelRef);
  const createChat = useChatStore((s) => s.createChat);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const refreshDownloadState = useCallback(async (): Promise<void> => {
    try {
      const [downloadList, installed] = await Promise.all([
        invoke('models:downloads', undefined),
        invoke('models:list', { refresh: false }),
      ]);
      const hydrated = hydrateDownloads(downloadList);
      setJobs(hydrated.jobs);
      setDownloadIds(hydrated.downloadIds);
      setInstalledNames(new Set(installed.map((model) => model.ref.name)));
    } catch {
      // El catálogo/recomendaciones sigue siendo usable aunque la hidratación sea transitoria.
    }
  }, []);

  const checkOllama = useCallback(async () => {
    setStep('checking');
    setError(null);
    try {
      const health = await invoke('provider:health', undefined);
      const ollamaOk = health.some((h) => h.providerId === 'ollama' && h.ok);
      setStep(reduceOnboarding('checking', { type: 'health_checked', ollamaOk }));
      if (ollamaOk) {
        await refreshDownloadState();
        // Doc del encargo, punto 5: "luego recomienda modelos para el equipo" — usa el mismo
        // RecommendationEngine que la pestaña Explorar/Recomendaciones del Centro de modelos
        // (packages/runtime/src/models/RecommendationEngine.ts), con "coding" como uso por defecto
        // porque es el prerrequisito documentado del hito 1 (doc 13 §8: "sin un modelo con tools que
        // entre 100% en GPU el hito 1 no se puede validar").
        try {
          setRecommendations(await invoke('models:recommend', { use: 'coding', goal: 'speed' }));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      // provider:health() fallando ES la señal de "Ollama no está corriendo" en modo attach — no es
      // un error del asistente, es justo la rama que hay que mostrar.
      setStep(reduceOnboarding('checking', { type: 'health_checked', ollamaOk: false }));
      void err;
    }
  }, [refreshDownloadState]);

  // Chequeo único al primer arranque (doc: "se muestra una sola vez"); `settings:get` vive en la
  // base SQLite (o el fallback JSON, ver RuntimeHost.settings), sobrevive a reinicios.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const completed = await invoke('settings:get', { key: ONBOARDING_COMPLETED_KEY });
        if (!cancelled && completed !== true) openOnboarding();
      } catch {
        // Sin runtime real (p. ej. la base no abrió) no se bloquea el arranque de la app por esto.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cada vez que se abre (primera vez o reabierto desde Ajustes) arranca desde el principio.
  useEffect(() => {
    if (open) void checkOllama();
  }, [open, checkOllama]);

  useEffect(() => {
    const recordJob = (job: DownloadJob): void => {
      setJobs((prev) => mergeDownloadJob(prev, job));
      setDownloadIds((prev) => ({ ...prev, [job.modelName]: job.id }));
    };
    const offProgress = onEvent('download:progress', recordJob);
    const offDone = onEvent('download:done', recordJob);
    const offFailed = onEvent('download:failed', recordJob);
    return () => { offProgress(); offDone(); offFailed(); };
  }, [refreshDownloadState]);

  async function downloadModel(recommendation: Recommendation): Promise<void> {
    const fullName = `${recommendation.catalogEntry.name}:${recommendation.catalogEntry.tag}`;
    setSelectedModel(fullName);
    setError(null);
    const existing = findDownloadForModel(jobs, fullName);
    if (isDownloadActive(existing) || !downloadStartGuard.current.begin(fullName)) return;
    setStartingModels((previous) => new Set(previous).add(fullName));
    try {
      const result = await invoke('models:pull', { name: fullName });
      setDownloadIds((previous) => ({ ...previous, [fullName]: result.downloadId }));
      setJobs((previous) => mergeDownloadJob(previous, { id: result.downloadId, providerId: 'ollama', modelName: fullName, status: 'queued', totalBytes: recommendation.catalogEntry.sizeBytes, completedBytes: 0, layers: [] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      downloadStartGuard.current.end(fullName);
      setStartingModels((previous) => {
        const next = new Set(previous);
        next.delete(fullName);
        return next;
      });
    }
  }

  async function cancelDownload(recommendation: Recommendation): Promise<void> {
    const fullName = `${recommendation.catalogEntry.name}:${recommendation.catalogEntry.tag}`;
    const downloadId = downloadIds[fullName];
    if (!downloadId) return;
    try {
      await invoke('models:pullCancel', { downloadId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUseRecommended(recommendation: Recommendation): Promise<void> {
    const ref = { providerId: 'ollama', name: `${recommendation.catalogEntry.name}:${recommendation.catalogEntry.tag}`, locality: 'local' as const };
    try {
      const target = recommendedModelTarget(currentChatId, currentProjectId);
      if (target.kind === 'chat') await setChatModel(target.chatId, ref);
      else if (target.kind === 'project-draft') setDraftModelRef(target.projectId, ref);
      else {
        await useProjectStore.getState().openPersonalProject();
        const created = await createChat(PERSONAL_PROJECT_ID, DEFAULT_AGENT_ID, 'agent', ref);
        useChatStore.getState().setCurrentChat(created.id);
      }
      useUiNavStore.getState().setSection('chats');
      await finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function finish(): Promise<void> {
    setStep('done');
    closeOnboarding();
    try {
      await invoke('settings:set', { key: ONBOARDING_COMPLETED_KEY, value: true });
    } catch (err) {
      console.error('[onboarding] no se pudo guardar onboarding.completed', err);
    }
  }

  async function handleChoosePcModels(): Promise<void> {
    setStep(reduceOnboarding(step, { type: 'choose_pc_models' }));
  }

  async function handleChooseApiKey(): Promise<void> {
    setStep(reduceOnboarding(step, { type: 'choose_api_key' }));
    useUiNavStore.getState().setSettingsTab('providers');
    useUiNavStore.getState().requestTab('Ajustes');
    await finish();
  }

  if (!open) return null;

  return (
    <div className="saurio-onboarding-backdrop" role="dialog" aria-modal="true" aria-label="Asistente de primer arranque">
      <div className="saurio-onboarding-card">
        <div className="saurio-onboarding-header">
          <strong>Bienvenido a SaurioLLM</strong>
          <button type="button" onClick={() => void finish()} aria-label="Cerrar asistente">×</button>
        </div>

        {error && <div className="saurio-banner danger">{error}</div>}

        {step === 'checking' && <p>Buscando Ollama en este equipo…</p>}

        {step === 'ollama_missing' && (
          <>
            <p>
              Elegí cómo querés trabajar. Podemos preparar los modelos en tu PC o conectar un proveedor por API.
            </p>
            <div className="saurio-onboarding-choices">
              <button type="button" className="saurio-btn-primary" onClick={() => void handleChoosePcModels()}>
                Modelos en mi PC
              </button>
              <button type="button" onClick={() => void handleChooseApiKey()}>
                Tengo una clave de API
              </button>
            </div>
          </>
        )}

        {step === 'confirm_download' && (
          <>
            <EngineSetup onReady={() => void checkOllama()} />
            <div className="saurio-onboarding-choices">
              <button type="button" onClick={() => setStep(reduceOnboarding(step, { type: 'cancel_download' }))}>
                Volver
              </button>
            </div>
          </>
        )}

        {step === 'recommendations' && (
          <>
            <p>Ollama está corriendo. Esto es lo que te recomendamos para programar en este equipo:</p>
            {recommendations.length === 0 ? (
              <p className="saurio-empty">Sin recomendaciones todavía (catálogo vacío o sin hardware detectado).</p>
            ) : (
              <div className="saurio-row-list">
                {recommendations.slice(0, 3).map((r) => (
                  (() => {
                    const fullName = `${r.catalogEntry.name}:${r.catalogEntry.tag}`;
                    const job = downloadIds[fullName] ? jobs[downloadIds[fullName]] : undefined;
                    const jobActive = isDownloadActive(job);
                    const active = jobActive || startingModels.has(fullName);
                    const done = canUseDownloadedModel(fullName, job, installedNames);
                    const pct = job && job.totalBytes > 0 ? Math.round((job.completedBytes / job.totalBytes) * 100) : 0;
                    return <div key={fullName} className={`saurio-row${selectedModel === fullName ? ' saurio-row--selected' : ''}`}>
                    <div className="saurio-row__header">
                      <strong className="saurio-mono saurio-row__title">{r.catalogEntry.name}:{r.catalogEntry.tag}</strong>
                      <span className="saurio-badge local">LOCAL</span>
                    </div>
                    <div className="saurio-row__meta">{formatBytes(r.catalogEntry.sizeBytes)}</div>
                    <div className="saurio-row__line">
                      {fitClassLabel(r.fitClass)} — {r.tested ? `probado el ${new Date(r.tested.testedAt).toLocaleDateString('es-AR')}` : 'estimado'}
                    </div>
                      {job && <div className="saurio-row__line">{job.status === 'failed' ? `Falló: ${visibleDownloadError(job.error ?? 'error desconocido')}` : job.status === 'cancelled' ? 'Descarga cancelada.' : `${pct}% descargado${job.etaMs !== undefined ? ` · faltan ~${Math.ceil(job.etaMs / 1000)} s` : ''}`}</div>}
                      {job && (active || done) && <div className="saurio-progress" aria-label={`Progreso de descarga ${pct}%`}><div className={`saurio-progress__fill ${job.status}`} style={{ width: `${pct}%` }} /></div>}
                      <div className="saurio-row__actions">
                        {!done && <button type="button" className="saurio-btn-primary" disabled={active} onClick={() => void downloadModel(r)}>{job?.status === 'failed' || job?.status === 'cancelled' ? 'Reintentar' : active ? 'Descargando…' : 'Descargar'}</button>}
                        {jobActive && <button type="button" onClick={() => void cancelDownload(r)}>Cancelar</button>}
                        {done && <button type="button" className="saurio-btn-primary" onClick={() => void handleUseRecommended(r)}>Usar este modelo</button>}
                      </div>
                    </div>;
                  })()
                ))}
              </div>
            )}
            <button type="button" className="saurio-btn-primary" onClick={() => void finish()}>Empezar a usar SaurioLLM</button>
          </>
        )}
      </div>
    </div>
  );
}
