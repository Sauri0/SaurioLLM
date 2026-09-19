// Sección "Agentes" a pantalla completa (punto 1 del encargo de rediseño) — apps/desktop/src/renderer/src/layout/AgentsView.tsx.
//
// Antes esto era la pestaña "Agentes" del panel derecho angosto (`layout/RightPanel.tsx`); acá se
// mueve solo el "cómo se monta" (envoltorio ancho + la lógica de "abrir chat con este agente", que
// vivía en RightPanel.tsx) — `AgentsPanel` (features/agents/**) no cambia.
import { useState } from 'react';
import type { AgentProfile, ModelInfo, ModelRef } from '@saurio/shared';
import { useModelsStore } from '../stores/modelsStore.js';
import { useProvidersStore } from '../stores/providersStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useProjectStore } from '../stores/projectStore.js';
import { useUiNavStore } from '../stores/uiNavStore.js';
import { AgentsPanel } from '../features/agents/index.js';
import { pickDefaultModelRef } from './defaultModel.js';

export interface AgentsViewProps {
  projectId: string | null;
  onSelectChat: (chatId: string) => void;
}

export function modelSelectionForAgent(
  agent: AgentProfile, installedModels: ModelInfo[],
): { modelRef: ModelRef | undefined; modelSelection: 'auto' | 'explicit' } | undefined {
  const availableLocalModel = pickDefaultModelRef(installedModels.filter((model) => model.ref.locality === 'local'));
  if (agent.modelMode === 'auto') {
    // Crear el espacio de trabajo no ejecuta un modelo. La disponibilidad local se verifica al
    // enviar; así se puede preparar un agente/chat antes de descargar el modelo o encender el motor.
    return { modelRef: undefined, modelSelection: 'auto' };
  }
  const modelRef = agent.model ?? availableLocalModel;
  return modelRef ? { modelRef, modelSelection: 'explicit' } : undefined;
}

export function AgentsView({ projectId, onSelectChat }: AgentsViewProps): React.JSX.Element {
  const installedModels = useModelsStore((s) => s.installed);
  const providers = useProvidersStore((s) => s.providers);
  const createChat = useChatStore((s) => s.createChat);
  const openPersonalProject = useProjectStore((s) => s.openPersonalProject);
  const setSection = useUiNavStore((s) => s.setSection);
  const [chatError, setChatError] = useState<string>();

  async function handleChatWithAgent(agent: AgentProfile): Promise<void> {
    setChatError(undefined);
    const selection = modelSelectionForAgent(agent, installedModels);
    if (!selection) {
      const message = 'Conectá o instalá un modelo para abrir chat.';
      setChatError(message);
      throw new Error(message);
    }
    try {
      const targetProjectId = projectId ?? (await openPersonalProject()).id;
      const chat = await createChat(targetProjectId, agent.id, 'agent', selection.modelRef, selection.modelSelection);
      onSelectChat(chat.id);
      setSection('chats');
    } catch (reason) {
      const message = `No se pudo abrir el chat con ${agent.name}: ${reason instanceof Error ? reason.message : String(reason)}`;
      setChatError(message);
      throw new Error(message, { cause: reason });
    }
  }

  return (
    <>
      {chatError && (
        <div className="saurio-banner danger" role="alert">
          <span>{chatError}</span>{' '}
          <button type="button" className="saurio-btn-ghost" onClick={() => setSection('modelos')}>Ir a Modelos</button>
          <button type="button" className="saurio-btn-ghost" onClick={() => { useUiNavStore.getState().setSettingsTab('providers'); setSection('ajustes'); }}>Configurar APIs</button>
        </div>
      )}
      <AgentsPanel
        installedModels={installedModels}
        providers={providers}
        onChatWithAgent={handleChatWithAgent}
      />
    </>
  );
}
