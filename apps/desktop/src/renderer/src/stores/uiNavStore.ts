// Navegación cruzada entre componentes que no comparten padre directo (doc 01 §2: "la UI habla con
// main solo por IPC" no aplica acá — esto es estado puramente de la UI, sin tocar el proceso main).
// apps/desktop/src/renderer/src/stores/uiNavStore.ts.
//
// Dos usos concretos, ambos del asistente de primer arranque (punto 5 del encargo):
// 1. "Tengo una clave de API" navega a la pestaña Ajustes > Proveedores (RightPanel.tsx la escucha).
// 2. El botón "Volver a ver el asistente" en Ajustes reabre el OnboardingWizard (montado en
//    AppLayout, fuera del árbol de SettingsPanel).
import { create } from 'zustand';

export type RightPanelTabId = 'Archivos' | 'Diff' | 'Terminal' | 'Modelos' | 'Rendimiento' | 'Ajustes';

interface UiNavState {
  requestedTab: RightPanelTabId | null;
  onboardingOpen: boolean;
  requestTab: (tab: RightPanelTabId) => void;
  clearRequestedTab: () => void;
  openOnboarding: () => void;
  closeOnboarding: () => void;
}

export const useUiNavStore = create<UiNavState>((set) => ({
  requestedTab: null,
  onboardingOpen: false,
  requestTab: (tab) => set({ requestedTab: tab }),
  clearRequestedTab: () => set({ requestedTab: null }),
  openOnboarding: () => set({ onboardingOpen: true }),
  closeOnboarding: () => set({ onboardingOpen: false }),
}));
