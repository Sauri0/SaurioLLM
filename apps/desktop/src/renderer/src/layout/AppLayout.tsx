// Layout de la app (rediseño de arquitectura de información): barra de navegación izquierda +
// seis secciones a pantalla completa — Inicio, Chats, Modelos, Agentes, Rendimiento, Ajustes — en
// vez del panel derecho angosto de siete pestañas que había antes (doc 01 §4.1, doc 02 §1).
// apps/desktop/src/renderer/src/layout/AppLayout.tsx.
//
// Motivo del rediseño: feedback real de un usuario de la v0.2.0 — "la interfaz con todo junto a la
// derecha no me cierra; es compleja y difícil de usar, muchas cosas muy compactas". Antes Modelos,
// Agentes, Rendimiento y Ajustes eran pestañas de un panel de 380px con etiquetas abreviadas ("Mod.",
// "Ag.", "Rend.", "Ajus.") que competían por espacio con Archivos/Diff/Terminal, que sí son propias de
// un chat puntual. Ahora esas cuatro son secciones propias, a todo el ancho, con su propio encabezado
// y aire (`WideView`); Archivos/Cambios/Terminal quedan como el único panel "contextual", colapsable,
// dentro de la sección Chats (`ChatsView.tsx`).
//
// Integración: acá se llama `wireIpcEvents()` una sola vez (conecta runtime:event -> runStore,
// models:changed -> modelsStore y metrics:tick -> perfStore, doc 01 §6) y se sincroniza el chat
// activo del layout con `chatStore.currentChatId`, que es el que consumen los componentes de
// features/chat.
import { useEffect, useState } from 'react';
import type { Project } from '@saurio/shared';
import { NavRail } from './NavRail.js';
import { ChatsView } from './ChatsView.js';
import { HomeScreen } from './HomeScreen.js';
import { AgentsView } from './AgentsView.js';
import { WideView } from './WideView.js';
import { StatusBar } from './StatusBar.js';
import { useChatStore, wireIpcEvents } from '../stores/index.js';
import { useUiNavStore, type SectionId } from '../stores/uiNavStore.js';
import { demoProject, isDemoMode, seedDemoState } from '../demo/demoState.js';
import { OnboardingWizard } from '../features/onboarding/index.js';
import { ModelsPanel } from '../features/models/index.js';
import { PerfPanel } from '../features/perf/index.js';
import { SettingsPanel } from '../features/settings/index.js';
import './theme.css';

// Herramienta de verificación visual (SAURIO_SMOKE_SHOT + SAURIO_SMOKE_STATE, ver
// apps/desktop/src/main/index.ts): la siembra de datos de ejemplo tiene que ocurrir ANTES de que
// los componentes hijos monten sus propios efectos (ChatPanel dispara `models:list`/`chat:history`
// al montar), porque en React los efectos de los hijos corren antes que los del padre. Por eso se
// hace acá, en el cuerpo del módulo (durante la primera evaluación de este archivo), no en un
// `useEffect`. Un módulo ES solo se evalúa una vez por proceso (StrictMode remonta el componente,
// no reevalúa el módulo), así que un flag de re-siembra acá nunca se llegaba a leer dos veces
// (`no-useless-assignment`, punto 6 del encargo) — se simplifica sin cambiar el comportamiento.
if (isDemoMode()) {
  seedDemoState();
}

/** Ctrl+1..6 (punto 5 del encargo de rediseño): saltar directo a una sección sin tocar el mouse.
 *  Se ignora mientras se está escribiendo en un campo de texto para no interferir con atajos propios
 *  del editor de mensajes o de un `<input>` (p. ej. seleccionar texto con el teclado). */
const SHORTCUT_SECTIONS: Record<string, SectionId> = {
  '1': 'inicio', '2': 'chats', '3': 'modelos', '4': 'agentes', '5': 'rendimiento', '6': 'ajustes',
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

export function AppLayout(): React.JSX.Element {
  const [project, setProject] = useState<Project | null>(() => (isDemoMode() ? demoProject() : null));
  const currentChatId = useChatStore((s) => s.currentChatId);
  const setCurrentChat = useChatStore((s) => s.setCurrentChat);
  const section = useUiNavStore((s) => s.section);
  const setSection = useUiNavStore((s) => s.setSection);

  useEffect(() => wireIpcEvents(), []);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent): void {
      if (!ev.ctrlKey || ev.altKey || ev.metaKey || isTypingTarget(ev.target)) return;
      const target = SHORTCUT_SECTIONS[ev.key];
      if (!target) return;
      ev.preventDefault();
      setSection(target);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setSection]);

  // Abrir una carpeta o crear un chat (desde Inicio, o desde cualquier lado) siempre termina en la
  // sección Chats — es donde vive la conversación recién creada/retomada (punto 4 del encargo: la
  // pantalla de Inicio sigue funcionando igual, pero ahora integrada como sección de la barra).
  function handleProjectChange(next: Project): void {
    setProject(next);
    setCurrentChat(undefined);
    setSection('chats');
  }
  function handleSelectChat(chatId: string): void {
    setCurrentChat(chatId);
    setSection('chats');
  }

  return (
    <div className="saurio-app">
      <NavRail section={section} onSelect={setSection} />
      <div className="saurio-view-root">
        {section === 'inicio' && (
          <HomeScreen project={project} onProjectChange={handleProjectChange} onSelectChat={handleSelectChat} />
        )}
        {section === 'chats' && (
          <ChatsView
            project={project}
            onProjectChange={handleProjectChange}
            activeChatId={currentChatId ?? null}
            onSelectChat={handleSelectChat}
          />
        )}
        {section === 'modelos' && <WideView><ModelsPanel /></WideView>}
        {section === 'agentes' && (
          <WideView><AgentsView projectId={project?.id ?? null} onSelectChat={handleSelectChat} /></WideView>
        )}
        {section === 'rendimiento' && <WideView><PerfPanel /></WideView>}
        {section === 'ajustes' && <WideView><SettingsPanel /></WideView>}
      </div>
      <StatusBar projectId={project?.id ?? null} chatId={currentChatId ?? null} />
      {/* Punto 5 del encargo original: se muestra una sola vez (settings.onboarding.completed) y se
          puede reabrir desde Ajustes. En modo demo (herramienta de verificación visual) no se monta,
          para no taparle la pantalla a otras capturas con un modal que no pidieron. */}
      {!isDemoMode() && <OnboardingWizard />}
    </div>
  );
}
