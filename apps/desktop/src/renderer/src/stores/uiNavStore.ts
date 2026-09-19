// Navegación de toda la app (rediseño de arquitectura de información: barra de navegación
// izquierda + secciones a pantalla completa + panel contextual de la vista Chats) — doc 01 §2: esto
// es estado puramente de la UI, sin tocar el proceso main. apps/desktop/src/renderer/src/stores/uiNavStore.ts.
//
// Antes de este rediseño, este store solo tenía dos usos puntuales del asistente de primer arranque
// ("Tengo una clave de API" -> pestaña Ajustes del panel derecho angosto; reabrir el asistente desde
// Ajustes). Ahora Modelos/Agentes/Rendimiento/Ajustes dejaron de ser pestañas de un panel angosto de
// 380px para ser secciones a pantalla completa de la navegación principal (punto 1 del encargo de
// rediseño) y el panel derecho quedó reducido a lo que acompaña a un chat (Archivos/Cambios/Terminal,
// punto 2) — así que `requestTab(...)` ahora decide, según qué pestaña se pida, si navega a una
// sección o si abre el panel contextual de la vista Chats en esa pestaña. Se mantiene esa misma
// función y esos mismos nombres de pestaña (en vez de forzar a tocar cada archivo que ya la llama:
// features/onboarding/OnboardingWizard.tsx, features/models/ModelSelect.tsx,
// features/chat/OomLoadCard.tsx, layout/HomeScreen.tsx — ninguno de esos archivos necesitó cambios).
import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { getDemoRightPanelTab, isDemoMode } from '../demo/demoState.js';

/** Las seis secciones de la barra de navegación izquierda (punto 1 del encargo de rediseño). */
export type SectionId = 'inicio' | 'chats' | 'modelos' | 'agentes' | 'rendimiento' | 'ajustes';

/** Pestañas del panel CONTEXTUAL de la vista Chats (punto 2): solo lo que acompaña a un chat
 *  puntual. "Cambios" es el nombre completo de lo que antes era la pestaña abreviada "Diff". */
export type ContextTabId = 'Archivos' | 'Cambios' | 'Terminal';

/** Nombres históricos de pestaña que ya usaba media app antes del rediseño — se conservan como
 *  vocabulario de entrada de `requestTab` para no tener que tocar quien ya la llama (ver arriba). */
export type RightPanelTabId = 'Archivos' | 'Diff' | 'Terminal' | 'Modelos' | 'Agentes' | 'Rendimiento' | 'Ajustes';

const TAB_TO_SECTION: Partial<Record<RightPanelTabId, SectionId>> = {
  Modelos: 'modelos',
  Agentes: 'agentes',
  Rendimiento: 'rendimiento',
  Ajustes: 'ajustes',
};

const TAB_TO_CONTEXT: Partial<Record<RightPanelTabId, ContextTabId>> = {
  Archivos: 'Archivos',
  Diff: 'Cambios',
  Terminal: 'Terminal',
};

// 320 (no 280): la pestaña "Cambios" (features/diff/diff.css) reserva 260px fijos para la lista de
// checkpoints + separación — por debajo de ~320px la columna de contenido del diff queda tan angosta
// que el texto empieza a partirse letra por letra (confirmado con una captura real, ver ronda 4 de
// verificación visual de este rediseño). 380 como default iguala el ancho fijo que tenía el panel
// completo antes del rediseño, que ya convivía bien con ese mismo layout de Diff.
export const CONTEXT_WIDTH_MIN = 320;
export const CONTEXT_WIDTH_MAX = 560;
const CONTEXT_WIDTH_DEFAULT = 380;

/** Ancho de ventana por debajo del cual el panel contextual arranca oculto (punto 6 del encargo:
 *  "oculto por defecto en ventanas angostas"). Solo decide el valor INICIAL, antes de que exista
 *  cualquier preferencia guardada (ver `persist` más abajo) — una vez que alguien lo abre/cierra a
 *  mano, esa elección se recuerda entre sesiones sin importar el ancho de la ventana. */
const NARROW_WINDOW_PX = 1180;

function clampContextWidth(width: number): number {
  return Math.min(CONTEXT_WIDTH_MAX, Math.max(CONTEXT_WIDTH_MIN, width));
}

function defaultContextOpen(): boolean {
  if (typeof window === 'undefined') return true;
  return window.innerWidth >= NARROW_WINDOW_PX;
}

/** Estado inicial pedido por la herramienta de verificación visual (`?demoState={"rightPanelTab":…}`,
 *  ver demo/demoState.ts): reusa el mismo vocabulario de `requestTab` para arrancar directo en una
 *  sección o con el panel contextual abierto en una pestaña, sin agregar ningún campo nuevo al JSON
 *  de demo ni tocar ese archivo. */
function demoInitialTab(): RightPanelTabId | undefined {
  const raw = getDemoRightPanelTab();
  return raw && (raw in TAB_TO_SECTION || raw in TAB_TO_CONTEXT) ? (raw as RightPanelTabId) : undefined;
}

function initialSection(): SectionId {
  const tab = demoInitialTab();
  if (!tab) return 'inicio';
  return TAB_TO_SECTION[tab] ?? (TAB_TO_CONTEXT[tab] ? 'chats' : 'inicio');
}

function initialContext(): { open: boolean; tab: ContextTabId } {
  const tab = demoInitialTab();
  const mapped = tab ? TAB_TO_CONTEXT[tab] : undefined;
  return mapped ? { open: true, tab: mapped } : { open: defaultContextOpen(), tab: 'Archivos' };
}

/** `localStorage` puede faltar (SSR nunca aplica acá, pero sí un entorno de test sin DOM) o tirar en
 *  una ventana privada — mismo criterio defensivo que `demo/demoState.ts` (try/catch alrededor de
 *  `URLSearchParams`), para que el store nunca rompa el montaje de la app por esto. */
function safeLocalStorage(): StateStorage {
  const noop: StateStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  if (typeof window === 'undefined') return noop;
  try {
    const probeKey = '__saurio_ls_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return window.localStorage;
  } catch {
    return noop;
  }
}

interface UiNavState {
  /** Sección activa de la navegación principal (punto 1 del encargo). */
  section: SectionId;
  /** Panel contextual de la vista Chats (punto 2): abierto/cerrado, ancho y pestaña activa. */
  contextOpen: boolean;
  contextWidth: number;
  contextTab: ContextTabId;
  onboardingOpen: boolean;
  setSection: (section: SectionId) => void;
  /** Compatibilidad con el vocabulario de pestaña anterior al rediseño (ver comentario de arriba). */
  requestTab: (tab: RightPanelTabId) => void;
  toggleContext: () => void;
  setContextOpen: (open: boolean) => void;
  setContextTab: (tab: ContextTabId) => void;
  setContextWidth: (width: number) => void;
  openOnboarding: () => void;
  closeOnboarding: () => void;
}

export const useUiNavStore = create<UiNavState>()(
  persist(
    (set) => ({
      section: initialSection(),
      contextOpen: initialContext().open,
      contextTab: initialContext().tab,
      contextWidth: CONTEXT_WIDTH_DEFAULT,
      onboardingOpen: false,

      setSection: (section) => set({ section }),

      requestTab: (tab) => {
        const section = TAB_TO_SECTION[tab];
        if (section) {
          set({ section });
          return;
        }
        const contextTab = TAB_TO_CONTEXT[tab];
        if (contextTab) set({ section: 'chats', contextTab, contextOpen: true });
      },

      toggleContext: () => set((s) => ({ contextOpen: !s.contextOpen })),
      setContextOpen: (open) => set({ contextOpen: open }),
      setContextTab: (tab) => set({ contextTab: tab, contextOpen: true }),
      setContextWidth: (width) => set({ contextWidth: clampContextWidth(width) }),

      openOnboarding: () => set({ onboardingOpen: true }),
      closeOnboarding: () => set({ onboardingOpen: false }),
    }),
    {
      name: 'saurio-ui-nav',
      storage: createJSONStorage(() => safeLocalStorage()),
      // El modo demo (herramienta de verificación visual) nunca debe heredar una preferencia guardada
      // de una corrida anterior sobre la misma máquina — cada captura tiene que partir del estado que
      // pide su propio `?demoState=`, no del último `localStorage` que haya quedado.
      skipHydration: isDemoMode(),
      // Sin `partialize`: persist ya descarta las funciones al serializar con `JSON.stringify` (no
      // son serializables), así que solo los cuatro campos de datos (`section`/`contextOpen`/
      // `contextTab`/`contextWidth`) terminan en `localStorage`; al rehidratar, el `merge` default de
      // zustand (`{ ...creado, ...persistido }`) los combina con las funciones del store recién creado.
    },
  ),
);
