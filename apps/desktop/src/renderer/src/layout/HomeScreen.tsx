// Pantalla de inicio cuando no hay chat abierto (punto 3 de la tarea "Cerrá lo que falta"): estado
// del motor local y de los modelos + tres acciones grandes (Abrir carpeta / Elegir o instalar un
// modelo / Nuevo chat) + acceso a Proveedores por API — apps/desktop/src/renderer/src/layout/HomeScreen.tsx.
//
// Reemplaza los dos estados vacíos que había antes por separado ("Abrí una carpeta para empezar" en
// `ChatCenter.tsx` sin proyecto, "Elegí un chat o creá uno nuevo" en `ChatPanel.tsx` con proyecto
// pero sin chat): un usuario real que instaló la v0.1 reportó no entender "cómo instalar, seleccionar
// y saber si tengo modelos" (doc 16 §12.4) — este mismo problema aplica a la primera pantalla que ve,
// antes incluso de llegar al Centro de modelos.
import type { Chat, Project } from '@saurio/shared';
import { useState } from 'react';
import { invoke } from '../ipc/client.js';
import { useChatStore } from '../stores/chatStore.js';
import { useModelsStore } from '../stores/modelsStore.js';
import { useOllamaHealthStore } from '../stores/ollamaHealthStore.js';
import { useUiNavStore } from '../stores/uiNavStore.js';
import { useProjectStore } from '../stores/projectStore.js';
import { pickDefaultModelRef } from './defaultModel.js';
import { TextActionDialog } from './TextActionDialog.js';
import { FolderIcon, CpuIcon, ChatIcon, PlugIcon } from '../ui/icons.js';
import './homeScreen.css';

const DEFAULT_AGENT_ID = 'agent_builtin_lead';
const EMPTY_CHATS: Chat[] = [];

function engineStatusLabel(ok: boolean | null, starting: boolean): { text: string; tone: 'ok' | 'down' | 'checking' } {
  if (starting) return { text: 'Iniciando motor local…', tone: 'checking' };
  if (ok === null) return { text: 'Comprobando el motor local…', tone: 'checking' };
  return ok ? { text: 'Motor local conectado (Ollama)', tone: 'ok' } : { text: 'Motor local no conectado (Ollama)', tone: 'down' };
}

export interface HomeScreenProps {
  project: Project | null;
  onProjectChange: (project: Project) => void;
  onSelectChat: (chatId: string) => void;
}

export function HomeScreen({ project, onProjectChange, onSelectChat }: HomeScreenProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const installedModels = useModelsStore((s) => s.installed);
  const chats = useChatStore((s) => (project ? (s.chatsByProject[project.id] ?? EMPTY_CHATS) : EMPTY_CHATS));
  const createChat = useChatStore((s) => s.createChat);
  const draftModelRefStored = useChatStore((s) => (project ? s.draftModelRefByProject[project.id] : undefined));
  const draftMode = useChatStore((s) => (project ? s.draftModeByProject[project.id] : undefined) ?? 'agent');
  const ollamaOk = useOllamaHealthStore((s) => s.ok);
  const ollamaStarting = useOllamaHealthStore((s) => s.starting);
  const requestTab = useUiNavStore((s) => s.requestTab);
  const createManagedProject = useProjectStore((s) => s.createManagedProject);

  const draftModelRef = draftModelRefStored ?? pickDefaultModelRef(installedModels, chats);
  const engine = engineStatusLabel(ollamaOk, ollamaStarting);

  async function handleOpenProject(): Promise<void> {
    setError(null);
    try {
      const opened = await invoke('project:open', {});
      onProjectChange(opened);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleNewChat(): Promise<void> {
    if (!project || !draftModelRef) return;
    setError(null);
    try {
      const chat = await createChat(project.id, DEFAULT_AGENT_ID, draftMode, draftModelRef);
      onSelectChat(chat.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCreateManagedProject(name: string): Promise<void> {
    setCreatingProject(true);
    setError(null);
    try {
      onProjectChange(await createManagedProject(name));
      setProjectDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setCreatingProject(false);
    }
  }

  function handleOpenProviders(): void {
    useUiNavStore.getState().setSettingsTab('providers');
    requestTab('Ajustes');
  }

  return (
    <div className="saurio-home">
      <div className="saurio-home__status" role="status">
        <span className={`saurio-home__status-item saurio-home__status-item--${engine.tone}`}>
          <PlugIcon width={14} height={14} />
          {engine.text}
        </span>
        <span className="saurio-home__status-item">
          <CpuIcon width={14} height={14} />
          {installedModels.length > 0
            ? `${installedModels.length} modelo${installedModels.length === 1 ? '' : 's'} instalado${installedModels.length === 1 ? '' : 's'}`
            : 'Sin modelos instalados'}
        </span>
      </div>

      <h1 className="saurio-home__title">
        {project ? 'Elegí un chat o empezá uno nuevo' : 'Bienvenido a SaurioLLM'}
      </h1>
      <p className="saurio-home__hint">
        {project
          ? 'Cada chat mantiene su propio modo, modelo e historial. También podés seguir uno de la lista, a la izquierda.'
          : 'Abrí una carpeta existente o creá un proyecto administrado para empezar.'}
      </p>
      {error && <div className="saurio-banner danger saurio-home__error" role="alert">{error}</div>}

      <div className="saurio-home__actions">
        <button type="button" className="saurio-home__action" onClick={() => void handleOpenProject()}>
          <FolderIcon width={20} height={20} />
          <span className="saurio-home__action-title">{project ? 'Cambiar carpeta…' : 'Abrir carpeta'}</span>
          <span className="saurio-home__action-hint">{project ? project.path : 'Elegí dónde trabaja el agente'}</span>
        </button>

          <button type="button" className="saurio-home__action" onClick={() => setProjectDialogOpen(true)}>
            <FolderIcon width={20} height={20} />
            <span className="saurio-home__action-title">Crear proyecto</span>
            <span className="saurio-home__action-hint">Un espacio administrado por SaurioLLM</span>
          </button>

        <button type="button" className="saurio-home__action" onClick={() => requestTab('Modelos')}>
          <CpuIcon width={20} height={20} />
          <span className="saurio-home__action-title">Elegir o instalar un modelo</span>
          <span className="saurio-home__action-hint">
            {installedModels.length > 0 ? 'Ver instalados o explorar más' : 'Todavía no instalaste ninguno'}
          </span>
        </button>

        <button
          type="button"
          className="saurio-home__action"
          onClick={() => void handleNewChat()}
          disabled={!project || !draftModelRef}
          title={!project ? 'Abrí o creá un proyecto primero' : (!draftModelRef ? 'Instalá o elegí un modelo antes de crear un chat' : undefined)}
        >
          <ChatIcon width={20} height={20} />
          <span className="saurio-home__action-title">Nuevo chat</span>
          <span className="saurio-home__action-hint">
            {!project ? 'Necesita un proyecto abierto' : (draftModelRef ? `Con ${draftModelRef.name}` : 'Necesita un modelo instalado')}
          </span>
        </button>
      </div>

      <button type="button" className="saurio-btn-ghost saurio-home__providers" onClick={handleOpenProviders}>
        ¿Usás una API de nube (OpenAI, Anthropic, etc.)? Configurar proveedores
      </button>
      {projectDialogOpen && <TextActionDialog
        title="Crear proyecto"
        label="Nombre del proyecto"
        placeholder="Mi proyecto"
        confirmLabel="Crear proyecto"
        busy={creatingProject}
        onCancel={() => { if (!creatingProject) setProjectDialogOpen(false); }}
        onConfirm={(name) => name ? handleCreateManagedProject(name) : undefined}
      />}
    </div>
  );
}
