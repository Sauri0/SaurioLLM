// Máquina de estados pura del asistente de primer arranque (punto 5 del encargo) —
// apps/desktop/src/renderer/src/features/onboarding/onboardingLogic.ts.
// Separada del componente de vista (OnboardingWizard.tsx) para poder testear cada rama con
// vitest puro, sin renderizar React ni mockear IPC (mismo criterio que el resto del repo: los
// tests existentes son de lógica en .ts, no de componentes .tsx — no hay @testing-library/react
// instalado en este monorepo).
//
// Flujo (doc del encargo, punto 5): detecta si Ollama está instalado/corriendo; si falta, ofrece
// "Modelos en mi PC" (abre la descarga oficial con consentimiento explícito, nunca instala nada) o
// "Tengo una clave de API" (navega a Proveedores, que conecta otro agente); si Ollama responde,
// recomienda modelos para el equipo. Se muestra una sola vez y se puede reabrir desde Ajustes.
export type OnboardingStep =
  | 'checking'
  | 'ollama_missing'
  | 'confirm_download'
  | 'api_key_redirect'
  | 'recommendations'
  | 'done';

export type OnboardingEvent =
  | { type: 'health_checked'; ollamaOk: boolean }
  | { type: 'choose_pc_models' }
  | { type: 'choose_api_key' }
  | { type: 'confirm_download' }
  | { type: 'cancel_download' }
  | { type: 'recommendations_seen' }
  | { type: 'skip' };

/** Reducer puro: `step` actual + evento -> próximo `step`. Nunca ejecuta IO (fetch, IPC,
 *  `shell.openExternal`) — eso vive en OnboardingWizard.tsx, que llama a este reducer y por
 *  separado dispara el efecto que corresponda a la transición. */
export function reduceOnboarding(step: OnboardingStep, event: OnboardingEvent): OnboardingStep {
  switch (event.type) {
    case 'health_checked':
      return event.ollamaOk ? 'recommendations' : 'ollama_missing';
    case 'choose_pc_models':
      return step === 'ollama_missing' ? 'confirm_download' : step;
    case 'choose_api_key':
      return step === 'ollama_missing' ? 'api_key_redirect' : step;
    case 'confirm_download':
      // El usuario ya confirmó en el paso anterior (doc: "con consentimiento explícito"); acá solo
      // se cierra el asistente — instalar Ollama pasa fuera de SaurioLLM, en el navegador del SO.
      return step === 'confirm_download' ? 'done' : step;
    case 'cancel_download':
      return step === 'confirm_download' ? 'ollama_missing' : step;
    case 'recommendations_seen':
      return step === 'recommendations' ? 'done' : step;
    case 'skip':
      return 'done';
    default:
      return step;
  }
}

export function isTerminal(step: OnboardingStep): boolean {
  return step === 'done';
}

/** URL de descarga oficial de Ollama (doc del encargo: "abre la descarga oficial ... NO la
 *  ejecutes ni instales nada en esta máquina"). Constante nombrada para que el componente y los
 *  tests no dupliquen el literal. */
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
