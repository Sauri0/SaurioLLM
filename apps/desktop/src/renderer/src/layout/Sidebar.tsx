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
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Chat, Mode, ModelRef, Project } from '@saurio/shared';
import { invoke } from '../ipc/client.js';
import { ChatIcon, FolderIcon } from '../ui/icons.js';
import { isDemoMode } from '../demo/demoState.js';
import { orderChatsByPin, useChatStore } from '../stores/chatStore.js';
import { PERSONAL_PROJECT_ID, useProjectStore } from '../stores/projectStore.js';
import { useModelsStore } from '../stores/modelsStore.js';
import { useProvidersStore } from '../stores/providersStore.js';
import { useOllamaHealthStore } from '../stores/ollamaHealthStore.js';
import { ModeSelector } from '../features/chat/ModeSelector.js';
import { ModelSelect } from '../features/models/ModelSelect.js';
import { pickDefaultModelRef } from './defaultModel.js';
import { TextActionDialog } from './TextActionDialog.js';
import { ChatSearchPanel } from './ChatSearchPanel.js';
import type { CatalogItem } from '@saurio/shared';
import './projectsSidebar.css';

const EMPTY_CHATS: Chat[] = [];
const DEFAULT_MODE: Mode = 'agent';

/** Agente builtin sembrado por el runtime al arrancar (packages/runtime/src/agent/defaults.ts) —
 *  esto SÍ es estable (siempre existe, no depende de qué haya instalado el usuario). El modelo, en
 *  cambio, ya no se asume: sale de `models:list` vía `pickDefaultModelRef` (PRIORIDAD CERO punto 6). */
const DEFAULT_AGENT_ID = 'agent_builtin_lead';

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
  const [projectSearch, setProjectSearch] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    title: string;
    description?: string;
    label?: string;
    initialValue?: string;
    placeholder?: string;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm(value?: string): Promise<void>;
  } | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogRestoreFocusTo, setDialogRestoreFocusTo] = useState<HTMLElement | null>(null);
  const [dialogRestoreFocusFallbackTo, setDialogRestoreFocusFallbackTo] = useState<HTMLElement | null>(null);
  const [pendingMenuActionFocus, setPendingMenuActionFocus] = useState<{ trigger: HTMLElement | null; fallback: HTMLElement | null } | null>(null);
  const projectSearchRef = useRef<HTMLInputElement>(null);
  const chatSearchRef = useRef<HTMLInputElement>(null);

  const chats = useChatStore((s) => (project ? (s.chatsByProject[project.id] ?? EMPTY_CHATS) : EMPTY_CHATS));
  const loadChats = useChatStore((s) => s.loadChats);
  const createChat = useChatStore((s) => s.createChat);
  const setDraftModelRef = useChatStore((s) => s.setDraftModelRef);
  const draftMode = useChatStore((s) => (project ? s.draftModeByProject[project.id] : undefined) ?? DEFAULT_MODE);
  const setDraftMode = useChatStore((s) => s.setDraftMode);
  const renameChat = useChatStore((s) => s.renameChat);
  const archiveChat = useChatStore((s) => s.archiveChat);
  const deleteChat = useChatStore((s) => s.deleteChat);
  const pinnedChatIdsByProject = useChatStore((s) => s.pinnedChatIdsByProject);
  const pinnedChatIds = project ? pinnedChatIdsByProject[project.id] ?? [] : [];
  const toggleChatPinned = useChatStore((s) => s.toggleChatPinned);

  const projects = useProjectStore((s) => s.projects);
  const pinnedProjectIds = useProjectStore((s) => s.pinnedProjectIds);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const openStoredProject = useProjectStore((s) => s.openProject);
  const openPersonalProject = useProjectStore((s) => s.openPersonalProject);
  const createManagedProject = useProjectStore((s) => s.createManagedProject);
  const toggleProjectPinned = useProjectStore((s) => s.toggleProjectPinned);
  const renameProject = useProjectStore((s) => s.renameProject);
  const relocateProject = useProjectStore((s) => s.relocateProject);
  const removeProject = useProjectStore((s) => s.removeProject);

  const installedModels = useModelsStore((s) => s.installed);
  // Tarea "ModelSelect: estados explícitos" (punto 2): `models:catalog` es la API PÚBLICA que ya
  // expone el Centro de modelos por IPC (no se importa nada de packages/runtime/src/models/** ni de
  // features/models/** fuera de este contrato) — cruzarla contra `installedModels` alcanza para
  // "el mejor clasificado por la escala para este hardware" sin duplicar el cálculo del tier acá.
  const [catalog, setCatalog] = useState<CatalogItem[] | undefined>(undefined);
  // PRIORIDAD CERO punto 6 + tarea "ModelSelect: estados explícitos" — orden real: si el usuario ya
  // eligió uno para el próximo chat, se respeta; si no, `pickDefaultModelRef` (último usado en este
  // proyecto -> mejor clasificado para este hardware -> primer instalado); si no hay ningún modelo
  // instalado, `draftModelRef` queda `undefined` y la UI lo dice explícito en vez de fingir un valor.
  const draftModelRefStored = useChatStore((s) => (project ? s.draftModelRefByProject[project.id] : undefined));
  const draftModelRef = draftModelRefStored ?? pickDefaultModelRef(installedModels, chats, catalog);
  const providers = useProvidersStore((s) => s.providers);
  const loadProviders = useProvidersStore((s) => s.load);
  const modelsRefresh = useModelsStore((s) => s.refresh);
  const modelsSubscribe = useModelsStore((s) => s.subscribe);
  const ollamaOk = useOllamaHealthStore((s) => s.ok);
  const ollamaStarting = useOllamaHealthStore((s) => s.starting);
  const ollamaStartError = useOllamaHealthStore((s) => s.startError);
  const startOllama = useOllamaHealthStore((s) => s.start);
  const subscribeOllamaHealth = useOllamaHealthStore((s) => s.subscribe);
  const orderedChats = orderChatsByPin(chats, pinnedChatIds);

  useEffect(() => {
    // Modo demo (herramienta de verificación visual): el chat de ejemplo ya está sembrado en
    // `chatStore` — pedir `chat:list` de verdad lo pisaría con una lista vacía.
    if (project && !isDemoMode()) void loadChats(project.id);
  }, [project, loadChats]);

  useEffect(() => {
    if (!isDemoMode()) void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (isDemoMode()) return; // ídem: `useModelsStore` ya viene sembrado por demo/demoState.ts.
    void modelsRefresh();
    modelsSubscribe();
  }, [modelsRefresh, modelsSubscribe]);

  useEffect(() => {
    if (isDemoMode()) return;
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => subscribeOllamaHealth(), [subscribeOllamaHealth]);

  useLayoutEffect(() => {
    if (!menuOpenId) return;
    const menuId = menuOpenId.startsWith('project:')
      ? `project-menu-${menuOpenId.slice('project:'.length)}`
      : `chat-menu-${menuOpenId.slice('chat:'.length)}`;
    const menu = document.getElementById(menuId);
    const trigger = document.querySelector<HTMLButtonElement>(`button[aria-controls="${menuId}"]`);
    if (menu && trigger) {
      const anchor = trigger.getBoundingClientRect();
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, innerHeight - bounds.height - 8))}px`;
      menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') { setMenuOpenId(null); trigger?.focus({ preventScroll: true }); }
      if (menu?.contains(document.activeElement) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus({ preventScroll: true });
      }
    }
    function closeOnOutside(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && !menu?.contains(target) && !trigger?.contains(target)) setMenuOpenId(null);
    }
    function closeOnResize(): void {
      const focusWasInsideMenu = menu?.contains(document.activeElement) ?? false;
      setMenuOpenId(null);
      if (focusWasInsideMenu) trigger?.focus({ preventScroll: true });
    }
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOnOutside);
    window.addEventListener('resize', closeOnResize);
    return () => { document.removeEventListener('keydown', closeOnEscape); document.removeEventListener('pointerdown', closeOnOutside); window.removeEventListener('resize', closeOnResize); };
  }, [menuOpenId]);

  useLayoutEffect(() => {
    if (!pendingMenuActionFocus || menuOpenId) return;
    const target = pendingMenuActionFocus.trigger?.isConnected
      ? pendingMenuActionFocus.trigger
      : pendingMenuActionFocus.fallback?.isConnected ? pendingMenuActionFocus.fallback : null;
    target?.focus({ preventScroll: true });
    setPendingMenuActionFocus(null);
  }, [menuOpenId, pendingMenuActionFocus]);

  useEffect(() => {
    if (isDemoMode()) return;
    invoke('models:catalog', undefined).then(setCatalog).catch(() => setCatalog(undefined));
    // Se re-pide cuando Ollama vuelve a responder (auto-refresco del punto 2: el catálogo depende de
    // muestrear el hardware real vía el provider, que recién puede hacerlo con Ollama arriba).
  }, [ollamaOk]);

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

  async function handleSelectProject(next: Project): Promise<void> {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      onProjectChange(next.id === 'project_personal'
        ? await openPersonalProject()
        : await openStoredProject(next.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }

  async function handleCreateManagedProject(name: string): Promise<void> {
    setOpening(true);
    setError(null);
    try {
      onProjectChange(await createManagedProject(name.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setOpening(false);
    }
  }

  function domMenuId(menuId: string | null): string | undefined {
    return menuId?.startsWith('project:')
      ? `project-menu-${menuId.slice('project:'.length)}`
      : menuId?.startsWith('chat:')
        ? `chat-menu-${menuId.slice('chat:'.length)}`
        : undefined;
  }

  function menuFocusTargets(menuId: string | null): { trigger: HTMLElement | null; fallback: HTMLElement | null } {
    const id = domMenuId(menuId);
    return {
      trigger: id ? document.querySelector<HTMLButtonElement>(`button[aria-controls="${id}"]`) : null,
      fallback: menuId?.startsWith('project:') ? projectSearchRef.current : chatSearchRef.current,
    };
  }

  function openDialog(next: Omit<NonNullable<typeof dialog>, 'onConfirm'> & { onConfirm(value?: string): Promise<void> }): void {
    const menuId = domMenuId(menuOpenId);
    const isProjectMenu = menuOpenId?.startsWith('project:') ?? false;
    setDialogRestoreFocusTo(menuId
      ? document.querySelector<HTMLButtonElement>(`button[aria-controls="${menuId}"]`)
      : (document.activeElement instanceof HTMLElement ? document.activeElement : null));
    setDialogRestoreFocusFallbackTo(menuId ? (isProjectMenu ? projectSearchRef.current : chatSearchRef.current) : null);
    setMenuOpenId(null);
    setDialog(next);
  }

  async function confirmDialog(value?: string): Promise<void> {
    if (!dialog) return;
    setDialogBusy(true);
    try {
      await dialog.onConfirm(value);
      setDialog(null);
      setDialogRestoreFocusTo(null);
      setDialogRestoreFocusFallbackTo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setDialogBusy(false);
    }
  }

  async function runProjectAction(action: () => Promise<void>): Promise<void> {
    const { trigger, fallback } = menuFocusTargets(menuOpenId);
    try {
      setError(null);
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMenuOpenId(null);
      setPendingMenuActionFocus({ trigger, fallback });
    }
  }

  function handleModelChange(ref: ModelRef): void {
    if (!project) return;
    setDraftModelRef(project.id, ref);
  }

  async function handleCreateChat(): Promise<void> {
    if (!project || !draftModelRef) return; // el botón ya queda deshabilitado sin modelo (ver JSX)
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
        <div className="saurio-project-actions">
          <button type="button" className="saurio-btn-primary saurio-sidebar-open-project-btn" onClick={() => void handleOpenProject()} disabled={opening}>
            {opening ? 'Abriendo…' : 'Abrir carpeta…'}
          </button>
          <button type="button" className="saurio-btn-ghost saurio-sidebar-open-project-btn" onClick={() => openDialog({
            title: 'Nuevo proyecto',
            label: 'Nombre del proyecto',
            placeholder: 'Mi proyecto',
            confirmLabel: 'Crear proyecto',
            onConfirm: async (name) => { if (name) await handleCreateManagedProject(name); },
          })} disabled={opening}>
            Nuevo proyecto
          </button>
        </div>
        {projects.length > 0 && (
          <>
            <label className="saurio-project-search">
              <span className="sr-only">Buscar proyectos</span>
              <input ref={projectSearchRef} value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Buscar proyectos…" />
            </label>
            <div className="saurio-project-list" aria-label="Proyectos recientes">
              {projects.filter((candidate) => {
                if (candidate.id === PERSONAL_PROJECT_ID) return false;
                const search = projectSearch.trim().toLocaleLowerCase();
                return !search || `${candidate.name} ${candidate.path}`.toLocaleLowerCase().includes(search);
              }).map((candidate) => {
                const pinned = pinnedProjectIds.includes(candidate.id);
                return (
                  <div key={candidate.id} className={`saurio-project-row${candidate.id === project?.id ? ' active' : ''}`}>
                    <button type="button" className="saurio-project-row__open" disabled={opening} onClick={() => void handleSelectProject(candidate)} title={candidate.path}>
                      <FolderIcon width={15} height={15} />
                      <span>{pinned ? '★ ' : ''}{candidate.name}</span>
                    </button>
                    <button
                      type="button"
                      className="saurio-project-row__menu"
                      aria-label={`Acciones para ${candidate.name}`}
                      aria-haspopup="menu"
                      aria-controls={`project-menu-${candidate.id}`}
                      aria-expanded={menuOpenId === `project:${candidate.id}`}
                      onClick={() => setMenuOpenId(menuOpenId === `project:${candidate.id}` ? null : `project:${candidate.id}`)}
                    >
                      ⋯
                    </button>
                    {menuOpenId === `project:${candidate.id}` && (
                      <div id={`project-menu-${candidate.id}`} className="saurio-project-menu" role="menu" aria-label={`Acciones para ${candidate.name}`}>
                        <button type="button" role="menuitem" onClick={() => void runProjectAction(() => toggleProjectPinned(candidate.id))}>{pinned ? 'Despinear' : 'Pinear'}</button>
                        <button type="button" role="menuitem" onClick={() => openDialog({
                          title: 'Renombrar proyecto',
                          label: 'Nombre del proyecto',
                          initialValue: candidate.name,
                          confirmLabel: 'Guardar',
                          onConfirm: async (name) => { if (name) await renameProject(candidate.id, name); },
                        })}>Renombrar</button>
                        <button type="button" role="menuitem" onClick={() => openDialog({
                          title: 'Localizar carpeta del proyecto',
                          description: `Elegí la nueva ubicación de “${candidate.name}”. Conserva sus chats y configuración. No mueve ni copia archivos.`,
                          confirmLabel: 'Elegir carpeta',
                          onConfirm: async () => { await relocateProject(candidate.id); },
                        })}>Localizar carpeta…</button>
                        <button type="button" role="menuitem" onClick={() => openDialog({
                          title: 'Quitar proyecto de SaurioLLM',
                          description: `¿Quitar “${candidate.name}” de SaurioLLM? Sus archivos e historial se conservan.`,
                          confirmLabel: 'Quitar',
                          destructive: true,
                          onConfirm: async () => { await removeProject(candidate.id); },
                        })}>Quitar de SaurioLLM</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      {error && <div className="saurio-banner danger saurio-sidebar-error" role="alert">{error}</div>}

      <h2>Chats</h2>
      {project ? (
        <>
          {!chatSearch.trim() && <div className="saurio-sidebar-section">
            <button
              type="button"
              className="saurio-btn-primary saurio-sidebar-new-chat"
              onClick={() => void handleCreateChat()}
              disabled={creating || !draftModelRef}
              title={draftModelRef ? undefined : 'Instalá o elegí un modelo en la pestaña "Modelos" antes de crear un chat'}
            >
              {creating ? 'Creando…' : '+ Nuevo chat'}
            </button>
            {/* PRIORIDAD CERO punto 6 (bloqueo real: la app proponía qwen3:8b sin importar si estaba
                instalado): sin ningún modelo instalado, se lo dice explícito en vez de dejar el
                selector con un valor que en realidad no existe en este equipo. */}
            {!draftModelRef && (
              <div className="saurio-banner saurio-sidebar-no-models">
                No hay modelos instalados. Abrí la pestaña &quot;Modelos&quot; para instalar uno.
              </div>
            )}
          </div>}
          <div className="saurio-sidebar-section saurio-sidebar-chats">
            <label className="saurio-project-search">
              <span className="sr-only">Buscar chats</span>
              <input ref={chatSearchRef} value={chatSearch} maxLength={200} onChange={(event) => setChatSearch(event.target.value)} placeholder="Buscar chats…" />
            </label>
            {chatSearch.trim() ? (
              <ChatSearchPanel
                key={project.id}
                project={project}
                query={chatSearch}
                onClear={() => setChatSearch('')}
                onSelectChat={onSelectChat}
              />
            ) : chats.length > 0 ? (
              <>
              {orderedChats.filter((c) => !c.archived).map((chat) => (
                <div
                  key={chat.id}
                  role="button"
                  tabIndex={0}
                  className={`saurio-sidebar-item${chat.id === activeChatId ? ' active' : ''}`}
                  onClick={() => onSelectChat(chat.id)}
                  onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelectChat(chat.id); } }}
                >
                  {/* PRIORIDAD CERO punto 5 (bloqueo real: "(agent) chat_mu7" no dice nada del
                      chat) — "Chat nuevo" mientras no tenga título propio; el título autogenerado
                      desde el primer mensaje se muestra en la cabecera del chat (ChatHeader), que sí
                      tiene el historial cargado. */}
                  <span className="saurio-sidebar-item__title">{pinnedChatIds.includes(chat.id) && <span aria-label="Chat pineado">★ </span>}{chat.title ?? 'Chat nuevo'}</span>
                  <span className="saurio-sidebar-item__badges">
                    <span className="saurio-badge">{chat.mode === 'agent' ? 'Agente' : chat.mode}</span>
                    {chat.modelRef && <span className="saurio-badge local" title={chat.modelRef.name}>{chat.modelRef.name}</span>}
                  </span>
                  <button
                    type="button"
                    className="saurio-project-row__menu"
                    aria-label={`Acciones para ${chat.title ?? 'Chat nuevo'}`}
                    aria-haspopup="menu"
                    aria-controls={`chat-menu-${chat.id}`}
                    aria-expanded={menuOpenId === `chat:${chat.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuOpenId(menuOpenId === `chat:${chat.id}` ? null : `chat:${chat.id}`);
                    }}
                  >
                    ⋯
                  </button>
                  {menuOpenId === `chat:${chat.id}` && (
                    <div id={`chat-menu-${chat.id}`} className="saurio-project-menu saurio-chat-menu" role="menu" aria-label={`Acciones para ${chat.title ?? 'Chat nuevo'}`} onClick={(event) => event.stopPropagation()}>
                      <button type="button" role="menuitem" onClick={() => openDialog({
                        title: 'Renombrar chat',
                        label: 'Nombre del chat',
                        initialValue: chat.title ?? '',
                        confirmLabel: 'Guardar',
                        onConfirm: async (title) => { if (title) await renameChat(chat.id, title); },
                      })}>Renombrar</button>
                      <button type="button" role="menuitem" onClick={() => void runProjectAction(() => toggleChatPinned(chat.id))}>{pinnedChatIds.includes(chat.id) ? 'Despinear' : 'Pinear'}</button>
                      <button type="button" role="menuitem" onClick={() => void runProjectAction(() => archiveChat(chat.id, true))}>Archivar</button>
                      <button type="button" role="menuitem" onClick={() => openDialog({
                        title: 'Eliminar chat de la lista',
                        description: `¿Eliminar “${chat.title ?? 'Chat nuevo'}” de la lista? El historial queda guardado.`,
                        confirmLabel: 'Eliminar',
                        destructive: true,
                        onConfirm: async () => { await deleteChat(chat.id); },
                      })}>Eliminar de la lista</button>
                    </div>
                  )}
                </div>
              ))}
              {chats.length > 0 && orderedChats.length === 0 && <div className="saurio-empty">No hay chats que coincidan con la búsqueda.</div>}
              {orderedChats.some((chat) => chat.archived) && (
                <details className="saurio-sidebar-archived">
                  <summary>Archivados ({orderedChats.filter((chat) => chat.archived).length})</summary>
                  {orderedChats.filter((chat) => chat.archived).map((chat) => (
                    <button key={chat.id} type="button" className="saurio-sidebar-item" onClick={() => void archiveChat(chat.id, false)}>
                      Restaurar {pinnedChatIds.includes(chat.id) ? '★ ' : ''}{chat.title ?? 'Chat nuevo'}
                    </button>
                  ))}
                </details>
              )}
              </>
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

      {project && !chatSearch.trim() && (
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
              engineState={ollamaStarting ? 'starting' : (ollamaOk === false && installedModels.length === 0 ? 'down' : 'ready')}
              onStartEngine={() => void startOllama()}
              startEngineError={ollamaStartError}
            />
            <ModeSelector mode={draftMode} onChange={(m) => setDraftMode(project.id, m)} />
          </div>
        </div>
      )}
      {dialog && <TextActionDialog {...dialog} busy={dialogBusy} restoreFocusTo={dialogRestoreFocusTo} restoreFocusFallbackTo={dialogRestoreFocusFallbackTo} onCancel={() => {
        if (!dialogBusy) { setDialog(null); setDialogRestoreFocusTo(null); setDialogRestoreFocusFallbackTo(null); }
      }} onConfirm={(value) => confirmDialog(value)} />}
    </aside>
  );
}
