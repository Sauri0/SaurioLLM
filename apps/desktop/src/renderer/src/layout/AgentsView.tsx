// Sección "Agentes" a pantalla completa (punto 1 del encargo de rediseño) — apps/desktop/src/renderer/src/layout/AgentsView.tsx.
//
// Antes esto era la pestaña "Agentes" del panel derecho angosto (`layout/RightPanel.tsx`); acá se
// mueve solo el "cómo se monta" (envoltorio ancho + la lógica de "abrir chat con este agente", que
// vivía en RightPanel.tsx) — `AgentsPanel` (features/agents/**) no cambia.
import { useModelsStore } from '../stores/modelsStore.js';
import { useProvidersStore } from '../stores/providersStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiNavStore } from '../stores/uiNavStore.js';
import { AgentsPanel } from '../features/agents/index.js';
import { pickDefaultModelRef } from './defaultModel.js';

/** Doc 19 §0: proyecto personal sintético (packages/runtime/src/agent/personalProject.ts,
 *  PERSONAL_PROJECT_ID) — se repite acá el literal en vez de importarlo (la UI no depende
 *  directamente de @saurio/runtime, doc 01 §2 principio 9; mismo criterio que antes en RightPanel.tsx). */
const PERSONAL_PROJECT_ID = 'project_personal';

export interface AgentsViewProps {
  projectId: string | null;
  onSelectChat: (chatId: string) => void;
}

export function AgentsView({ projectId, onSelectChat }: AgentsViewProps): React.JSX.Element {
  const installedModels = useModelsStore((s) => s.installed);
  const providers = useProvidersStore((s) => s.providers);
  const createChat = useChatStore((s) => s.createChat);
  const setSection = useUiNavStore((s) => s.setSection);

  return (
    <AgentsPanel
      installedModels={installedModels}
      providers={providers}
      onChatWithAgent={(agent) => {
        const targetProjectId = projectId ?? PERSONAL_PROJECT_ID;
        const modelRef = agent.model ?? pickDefaultModelRef(installedModels);
        if (!modelRef) return; // sin ningún modelo instalado, igual que antes en RightPanel.tsx
        void createChat(targetProjectId, agent.id, 'agent', modelRef).then((chat) => {
          onSelectChat(chat.id);
          setSection('chats');
        });
      }}
    />
  );
}
