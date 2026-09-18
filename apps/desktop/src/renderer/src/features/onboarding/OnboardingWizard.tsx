// Asistente de primer arranque (punto 5 del encargo) — apps/desktop/src/renderer/src/features/
// onboarding/OnboardingWizard.tsx. Vista fina sobre `onboardingLogic.ts` (la máquina de estados en
// sí, testeada aparte con vitest puro). Se muestra una sola vez (settings `onboarding.completed`) y
// se puede reabrir desde Ajustes > "Volver a ver el asistente de primer arranque"
// (stores/uiNavStore.ts).
import { useCallback, useEffect, useState } from 'react';
import type { Recommendation } from '@saurio/shared';
import { invoke } from '../../ipc/client.js';
import { useUiNavStore } from '../../stores/uiNavStore.js';
import { fitClassLabel, formatBytes } from '../models/format.js';
import { reduceOnboarding, OLLAMA_DOWNLOAD_URL, type OnboardingStep } from './onboardingLogic.js';
import './onboarding.css';

const ONBOARDING_COMPLETED_KEY = 'onboarding.completed';

export function OnboardingWizard(): React.JSX.Element | null {
  const open = useUiNavStore((s) => s.onboardingOpen);
  const openOnboarding = useUiNavStore((s) => s.openOnboarding);
  const closeOnboarding = useUiNavStore((s) => s.closeOnboarding);
  const [step, setStep] = useState<OnboardingStep>('checking');
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const checkOllama = useCallback(async () => {
    setStep('checking');
    setError(null);
    try {
      const health = await invoke('provider:health', undefined);
      const ollamaOk = health.some((h) => h.providerId === 'ollama' && h.ok);
      setStep(reduceOnboarding('checking', { type: 'health_checked', ollamaOk }));
      if (ollamaOk) {
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
  }, []);

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

  async function handleConfirmDownload(): Promise<void> {
    try {
      await invoke('app:openExternal', { url: OLLAMA_DOWNLOAD_URL });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setStep(reduceOnboarding(step, { type: 'confirm_download' }));
    await finish();
  }

  async function handleChooseApiKey(): Promise<void> {
    setStep(reduceOnboarding(step, { type: 'choose_api_key' }));
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
              No encontramos Ollama corriendo en <code>127.0.0.1:11434</code>. SaurioLLM trabaja sobre
              modelos locales por defecto — elegí cómo querés seguir:
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
            <p>
              Esto abre <code>{OLLAMA_DOWNLOAD_URL}</code> en tu navegador — SaurioLLM no descarga ni
              instala nada por vos; instalás Ollama desde ahí, a tu criterio, y volvés a abrir SaurioLLM
              cuando esté corriendo.
            </p>
            <div className="saurio-onboarding-choices">
              <button type="button" className="saurio-btn-primary" onClick={() => void handleConfirmDownload()}>
                Abrir la descarga oficial
              </button>
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
                  <div key={`${r.catalogEntry.name}:${r.catalogEntry.tag}`} className="saurio-row">
                    <div className="saurio-row__header">
                      <strong className="saurio-mono saurio-row__title">{r.catalogEntry.name}:{r.catalogEntry.tag}</strong>
                      <span className="saurio-badge local">LOCAL</span>
                    </div>
                    <div className="saurio-row__meta">{formatBytes(r.catalogEntry.sizeBytes)}</div>
                    <div className="saurio-row__line">
                      {fitClassLabel(r.fitClass)} — {r.tested ? `probado el ${new Date(r.tested.testedAt).toLocaleDateString('es-AR')}` : 'estimado'}
                    </div>
                  </div>
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
