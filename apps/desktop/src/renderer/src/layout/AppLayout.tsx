// Layout de la app: barra lateral (proyecto + chats), panel central de chat, panel derecho con
// pestañas (doc 01 §4.1, doc 02 §1). apps/desktop/src/renderer/src/layout/AppLayout.tsx.
//
// Integración: acá se llama `wireIpcEvents()` una sola vez (conecta runtime:event -> runStore,
// models:changed -> modelsStore y metrics:tick -> perfStore, doc 01 §6) y se sincroniza el chat
// activo del layout con `chatStore.currentChatId`, que es el que consumen los componentes de
// features/chat.
import { useEffect, useState } from 'react';
import type { Project } from '@saurio/shared';
import { Sidebar } from './Sidebar.js';
import { RightPanel } from './RightPanel.js';
import { ChatCenter } from './ChatCenter.js';
import { StatusBar } from './StatusBar.js';
import { useChatStore, wireIpcEvents } from '../stores/index.js';
import { demoProject, isDemoMode, seedDemoState } from '../demo/demoState.js';
import { OnboardingWizard } from '../features/onboarding/index.js';
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

export function AppLayout(): React.JSX.Element {
  const [project, setProject] = useState<Project | null>(() => (isDemoMode() ? demoProject() : null));
  const currentChatId = useChatStore((s) => s.currentChatId);
  const setCurrentChat = useChatStore((s) => s.setCurrentChat);

  useEffect(() => wireIpcEvents(), []);

  return (
    <div className="saurio-app">
      <Sidebar
        project={project}
        onProjectChange={(next) => { setProject(next); setCurrentChat(undefined); }}
        activeChatId={currentChatId ?? null}
        onSelectChat={setCurrentChat}
      />
      <main className="saurio-main">
        <ChatCenter
          projectId={project?.id ?? null}
          // El diff en sí vive en la pestaña "Diff" del panel derecho (features/diff): abrir un
          // diff desde el chat es equivalente a mirar los checkpoints de ese chat ahí.
          onOpenDiff={() => { /* la pestaña Diff del panel derecho ya lista los checkpoints del chat */ }}
        />
      </main>
      <RightPanel projectId={project?.id ?? null} chatId={currentChatId ?? null} />
      <StatusBar projectId={project?.id ?? null} chatId={currentChatId ?? null} />
      {/* Punto 5 del encargo: se muestra una sola vez (settings.onboarding.completed) y se puede
          reabrir desde Ajustes. En modo demo (herramienta de verificación visual) no se monta, para
          no taparle la pantalla a otras capturas con un modal que no pidieron. */}
      {!isDemoMode() && <OnboardingWizard />}
    </div>
  );
}
