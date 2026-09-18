// Barra lateral única: proyecto, "+ Nuevo chat" + lista de chats, y un bloque compacto de
// configuración del próximo chat (modelo + modo) — apps/desktop/src/renderer/src/layout/Sidebar.tsx.
//
// Pasada de diseño #1: antes había TRES columnas a la izquierda del chat — esta barra lateral (solo
// proyecto + una lista de chats propia con `invoke('chat:list', …)` directo) y, adentro de
// `ChatPanel`, una segunda columna (`features/chat/ChatList.tsx`) con el selector de modelo, el
// botón "+ Nuevo chat" y OTRA lista de chats alimentada por `chatStore.loadChats` (que también
// llama `chat:list`). Quedaba esta barra como única fuente: lee y escribe `chatStore` en vez de
// mantener su propio `useState<Chat[]>` + invoke directo, `features/chat/ChatList.tsx` se borró y
// `ChatPanel` ya no monta ninguna columna propia — el chat ocupa el centro completo.
import { useEffect, useState } from 'react';
import type { Chat, Mode, ModelRef, Project } from '@saurio/shared';
import { invoke } from '../ipc/client.js';
import { ChatIcon, FolderIcon } from '../ui/icons.js';
import { isDemoMode } from '../demo/demoState.js';
import { useChatStore } from '../stores/chatStore.js';
import { useModelsStore } from '../stores/modelsStore.js';
import { useProvidersStore } from '../stores/providersStore.js';
import { ModeSelector } from '../features/chat/ModeSelector.js';
import { ModelSelect } from '../features/models/ModelSelect.js';

const EMPTY_CHATS: Chat[] = [];
const DEFAULT_MODE: Mode = 'agent';

/** Mismos valores que `layout/ChatCenter.tsx` usaba como fallback antes de que `models:list`
 *  responda (agente builtin sembrado por el runtime + modelo medido en este equipo). Vive acá
 *  ahora porque este bloque es el que crea el chat. */
const DEFAULT_AGENT_ID = 'agent_builtin_lead';
const DEFAULT_MODEL_REF = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' } as const;

export interface SidebarProps {
  project: Project | null;
  onProjectChange(project: Project): void;
  activeChatId: string | null;
  onSelectChat(chatId: string): void;
}

export function Sidebar({ project, onProjectChange, activeChatId, onSelectChat }: SidebarProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [creating, setCreating] = useState(false);

  const chats = useChatStore((s) => (project ? (s.chatsByProject[project.id] ?? EMPTY_CHATS) : EMPTY_CHATS));
  const loadChats = useChatStore((s) => s.loadChats);
  const createChat = useChatStore((s) => s.createChat);
  const draftModelRef = useChatStore((s) => (project ? s.draftModelRefByProject[project.id] : undefined) ?? DEFAULT_MODEL_REF);
  const setDraftModelRef = useChatStore((s) => s.setDraftModelRef);
  const draftMode = useChatStore((s) => (project ? s.draftModeByProject[project.id] : undefined) ?? DEFAULT_MODE);
  const setDraftMode = useChatStore((s) => s.setDraftMode);

  const installedModels = useModelsStore((s) => s.installed);
  const providers = useProvidersStore((s) => s.providers);
  const loadProviders = useProvidersStore((s) => s.load);
  const modelsRefresh = useModelsStore((s) => s.refresh);
  const modelsSubscribe = useModelsStore((s) => s.subscribe);

  useEffect(() => {
    // Modo demo (herramienta de verificación visual): el chat de ejemplo ya está sembrado en
    // `chatStore` — pedir `chat:list` de verdad lo pisaría con una lista vacía.
    if (project && !isDemoMode()) void loadChats(project.id);
  }, [project, loadChats]);

  useEffect(() => {
    if (isDemoMode()) return; // ídem: `useModelsStore` ya viene sembrado por demo/demoState.ts.
    void modelsRefresh();
    modelsSubscribe();
  }, [modelsRefresh, modelsSubscribe]);

  useEffect(() => {
    if (isDemoMode()) return;
    void loadProviders();
  }, [loadProviders]);

  async function handleOpenProject(): Promise<void> {
    setOpening(true);
    setError(null);
    try {
      const opened = await invoke('project:open', {});
      onProjectChange(opened);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }

  function handleModelChange(ref: ModelRef): void {
    if (!project) return;
    setDraftModelRef(project.id, ref);
  }

  async function handleCreateChat(): Promise<void> {
    if (!project) return;
    setCreating(true);
    setError(null);
    try {
      const chat = await createChat(project.id, DEFAULT_AGENT_ID, draftMode, draftModelRef);
      onSelectChat(chat.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <aside className="saurio-sidebar" aria-label="Proyecto y chats">
      <h2>Proyecto</h2>
      <div className="saurio-sidebar-section">
        {project && (
          <div className="saurio-project-card" title={project.path}>
            <span className="saurio-project-card__icon"><FolderIcon width={16} height={16} /></span>
            <span className="saurio-project-card__text">
              <span className="saurio-project-card__name">{project.name}</span>
              <span className="saurio-project-card__path">{project.path}</span>
            </span>
          </div>
        )}
        <button
          type="button"
          className={`${project ? 'saurio-btn-ghost' : 'saurio-btn-primary'} saurio-sidebar-open-project-btn`}
          onClick={() => void handleOpenProject()}
          disabled={opening}
        >
          {opening ? 'Abriendo…' : project ? 'Cambiar carpeta…' : 'Abrir carpeta…'}
        </button>
      </div>
      {error && <div className="saurio-banner danger saurio-sidebar-error" role="alert">{error}</div>}

      <h2>Chats</h2>
      {project ? (
        <>
          <div className="saurio-sidebar-section">
            <button type="button" className="saurio-btn-primary saurio-sidebar-new-chat" onClick={() => void handleCreateChat()} disabled={creating}>
              {creating ? 'Creando…' : '+ Nuevo chat'}
            </button>
          </div>
          <div className="saurio-sidebar-section saurio-sidebar-chats">
            {chats.length > 0 ? (
              chats.filter((c) => !c.archived).map((chat) => (
                <div
                  key={chat.id}
                  role="button"
                  tabIndex={0}
                  className={`saurio-sidebar-item${chat.id === activeChatId ? ' active' : ''}`}
                  onClick={() => onSelectChat(chat.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectChat(chat.id); }}
                >
                  <span className="saurio-sidebar-item__title">{chat.title ?? `(${chat.mode}) ${chat.id.slice(0, 8)}`}</span>
                  <span className="saurio-sidebar-item__badges">
                    <span className="saurio-badge">{chat.mode === 'agent' ? 'Agente' : chat.mode}</span>
                    {chat.modelRef && <span className="saurio-badge local" title={chat.modelRef.name}>{chat.modelRef.name}</span>}
                  </span>
                </div>
              ))
            ) : (
              <div className="saurio-empty">Sin chats todavía. Creá uno con &quot;+ Nuevo chat&quot;.</div>
            )}
          </div>
        </>
      ) : (
        <div className="saurio-empty-state saurio-sidebar-empty-state">
          <span className="saurio-empty-state__icon"><ChatIcon width={18} height={18} /></span>
          <span className="saurio-empty-state__hint">Abrí una carpeta para empezar</span>
        </div>
      )}

      {project && (
        <div className="saurio-sidebar-next-chat">
          <h2>Próximo chat</h2>
          <div className="saurio-sidebar-section saurio-next-chat">
            <span className="saurio-next-chat__label">Modelo</span>
            <ModelSelect
              models={installedModels}
              providers={providers}
              value={draftModelRef}
              onChange={handleModelChange}
              title="Modelo del próximo chat"
            />
            <ModeSelector mode={draftMode} onChange={(m) => setDraftMode(project.id, m)} />
          </div>
        </div>
      )}
    </aside>
  );
}
