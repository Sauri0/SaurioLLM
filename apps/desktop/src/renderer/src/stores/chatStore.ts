// chatStore: chats por proyecto + historial cargado (doc 01 §4.1, doc 04 §16 `chat:create/list/history`)
// — apps/desktop/src/renderer/src/stores/chatStore.ts.
import { create } from 'zustand';
import type { Chat, ChatPermissionPreset, Effort, IpcOutput, Mode, ModelRef, ToolCallRecord } from '@saurio/shared';
import { invoke } from '../ipc/client.js';
import { useRunStore, type RunStoreState } from './runStore.js';

type ChatHistory = IpcOutput<'chat:history'>;

/** Agrupa `ToolCallRecord[]` (de `chat:history`) por `runId`, en orden de `iteration` (y
 *  `startedAt` como desempate) — reconstruye lo que `runStore.toolCallOrderByRun` acumula en vivo
 *  con `tool.registered`, para que un run rehidratado tras reiniciar tenga por dónde pintar sus
 *  tarjetas de tool call en `ChatMessageList` (hallazgo #3). Separada de `loadHistory` para poder
 *  testearla sin zustand ni IPC (ver chatStore.test.ts). */
export function buildToolCallOrderByRun(toolCalls: ToolCallRecord[]): Record<string, string[]> {
  return toolCalls
    .slice()
    .sort((a, b) => (a.iteration - b.iteration) || ((a.startedAt ?? 0) - (b.startedAt ?? 0)))
    .reduce<Record<string, string[]>>((acc, call) => {
      const order = acc[call.runId] ?? [];
      return order.includes(call.id) ? acc : { ...acc, [call.runId]: [...order, call.id] };
    }, {});
}

export interface ChatStoreState {
  chatsByProject: Record<string, Chat[]>;
  currentChatId: string | undefined;
  /** Modo elegido en el selector de la barra del chat (doc 06 §1); se congela en `EffectiveConfig`
   *  al iniciar el run, pero la UI lo mantiene por chat para preseleccionar el siguiente `run:start`. */
  modeByChat: Record<string, Mode>;
  /** Modelo elegido para el *próximo* chat a crear en ese proyecto (hallazgo #1: antes no existía
   *  ninguna ruta para elegir modelo desde la UI — `ChatCenter` pasaba siempre el mismo
   *  `DEFAULT_MODEL_REF` fijo a `chat:create`). Por proyecto porque `ChatList`/`ChatPanel` viven
   *  por proyecto y el selector se muestra antes de que exista un chat. Cambiar el modelo de un
   *  chat ya creado necesitaría un canal IPC para actualizar `chats.model_ref_json`, que no existe
   *  todavía (fuera de `apps/desktop/src/renderer`, no se agrega acá). */
  draftModelRefByProject: Record<string, ModelRef>;
  /** Pines explícitos por proyecto. Son una preferencia visual y no modifican el chat persistido. */
  pinnedChatIdsByProject: Record<string, string[]>;
  /** Modo elegido en el bloque "próximo chat" de la barra lateral (pasada de diseño #1: antes solo
   *  existía `DEFAULT_MODE` fijo pasado a `chat:create`, sin forma de elegir Plan para el primer
   *  mensaje de un chat nuevo). Por proyecto, igual que `draftModelRefByProject`. */
  draftModeByProject: Record<string, Mode>;
  historyLoaded: Record<string, boolean>;
  loading: boolean;
  error: string | undefined;

  loadChats: (projectId: string) => Promise<void>;
  createChat: (projectId: string, agentId: string, mode: Mode, modelRef?: ModelRef, modelSelection?: 'auto' | 'explicit') => Promise<Chat>;
  loadHistory: (chatId: string) => Promise<void>;
  /** `undefined` deselecciona (p. ej. al cambiar de proyecto desde el layout). */
  setCurrentChat: (chatId: string | undefined) => void;
  setMode: (chatId: string, mode: Mode) => void;
  setDraftModelRef: (projectId: string, modelRef: ModelRef) => void;
  setDraftMode: (projectId: string, mode: Mode) => void;
  toggleChatPinned: (chatId: string) => Promise<void>;
  /** Punto 3 del encargo: cambiar modelo/modo de un CHAT YA CREADO desde la cabecera, vía
   *  `chat:setModel`/`chat:setMode` (antes no existían — ver comentario que quedaba en
   *  `draftModelRefByProject` de más arriba, ahora resuelto). No toca ningún run en curso: el
   *  próximo `run:start`/`run:continue` de este chat toma el valor nuevo. */
  setChatModel: (chatId: string, modelRef: ModelRef) => Promise<void>;
  setChatMode: (chatId: string, mode: Mode) => Promise<void>;
  /** Compositor del chat (rediseño, punto 1): preset de permisos y potencia (effort) del chat.
   *  `chat:setPermissionPreset`/`chat:setEffort` — contrato aditivo de packages/shared (feedback
   *  real v0.2.1, puntos 1a/1b). `'unrestricted'` exige `confirmed: true` explícito del lado del
   *  handler; acá se pide esa confirmación ANTES de invocar (nunca se manda `confirmed` a ciegas),
   *  mismo patrón que la confirmación de modelo NUBE de `setChatModel` de arriba. */
  setChatPermissionPreset: (chatId: string, preset: ChatPermissionPreset, confirmed?: boolean) => Promise<void>;
  setChatEffort: (chatId: string, effort: Effort) => Promise<void>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  archiveChat: (chatId: string, archived: boolean) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
}

const LAST_CHAT_SETTINGS_KEY = 'ui.projects.lastChatId';
const PINNED_CHATS_SETTINGS_KEY = 'ui.chats.pinnedIds';
let chatListRevision = 0;
const historyLoadRevisionByChat = new Map<string, number>();

/** Firma mínima de la actividad conocida para un chat. `lastSeqByRun` cambia con cada evento live;
 *  estado y cantidad de errores también cubren siembra directa en tests/rehidrataciones. */
function chatRunRevision(run: RunStoreState, chatId: string): string {
  return JSON.stringify(Object.entries(run.runChatIds)
    .filter(([, candidateChatId]) => candidateChatId === chatId)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([runId]) => [
      runId,
      run.lastSeqByRun[runId] ?? null,
      run.runStates[runId] ?? null,
      (run.errorsByRun[runId] ?? []).length,
    ]));
}

function readPinnedChatIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : [];
}

/** Pines primero, luego actividad reciente y título como desempate. El archivo archivado se separa
 * en la Sidebar después de ordenar, por lo que nunca desplaza un chat disponible. */
export function orderChatsByPin(chats: Chat[], pinnedIds: readonly string[]): Chat[] {
  const pinned = new Set(pinnedIds);
  return chats.slice().sort((a, b) =>
    Number(pinned.has(b.id)) - Number(pinned.has(a.id))
    || b.updatedAt - a.updatedAt
    || (a.title ?? '').localeCompare(b.title ?? '', 'es-AR'));
}

/** Reemplaza un chat por su versión actualizada dentro de `chatsByProject`, sin tocar otros proyectos. */
function replaceChat(chatsByProject: Record<string, Chat[]>, updated: Chat): Record<string, Chat[]> {
  const list = chatsByProject[updated.projectId];
  if (!list) return chatsByProject;
  return { ...chatsByProject, [updated.projectId]: list.map((c) => (c.id === updated.id ? updated : c)) };
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  chatsByProject: {},
  currentChatId: undefined,
  modeByChat: {},
  draftModelRefByProject: {},
  pinnedChatIdsByProject: {},
  draftModeByProject: {},
  historyLoaded: {},
  loading: false,
  error: undefined,

  loadChats: async (projectId) => {
    const revision = ++chatListRevision;
    set({ loading: true, error: undefined });
    try {
      const [chats, lastChatId, pinnedValue] = await Promise.all([
        invoke('chat:list', { projectId }),
        invoke('settings:get', { key: LAST_CHAT_SETTINGS_KEY }).catch(() => undefined),
        invoke('settings:get', { key: PINNED_CHATS_SETTINGS_KEY, projectId }).catch(() => undefined),
      ]);
      if (revision !== chatListRevision) return;
      const pinnedChatIds = readPinnedChatIds(pinnedValue).filter((id) => chats.some((chat) => chat.id === id));
      const preferredChatId = typeof lastChatId === 'string' && chats.some((chat) => chat.id === lastChatId && !chat.archived)
        ? lastChatId
        : (get().currentChatId && chats.some((chat) => chat.id === get().currentChatId && !chat.archived)
          ? get().currentChatId
          : undefined);
      set((state) => ({
        loading: false,
        currentChatId: preferredChatId,
        chatsByProject: { ...state.chatsByProject, [projectId]: chats },
        pinnedChatIdsByProject: { ...state.pinnedChatIdsByProject, [projectId]: pinnedChatIds },
      }));
    } catch (err) {
      if (revision !== chatListRevision) return;
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  // Mismo mecanismo de confirmación que `setChatModel` (frontera local/nube, punto 4 del encargo):
  // crear un chat nuevo YA con un modelo NUBE también pasa por `CLOUD_CONFIRMATION_REQUIRED`.
  createChat: async (projectId, agentId, mode, modelRef, modelSelection = 'explicit') => {
    function addChat(chat: Chat): Chat {
      chatListRevision += 1;
      set((state) => ({
        loading: false,
        chatsByProject: { ...state.chatsByProject, [projectId]: [...(state.chatsByProject[projectId] ?? []), chat] },
        modeByChat: { ...state.modeByChat, [chat.id]: mode },
        currentChatId: chat.id,
      }));
      return chat;
    }
    try {
      return addChat(await invoke('chat:create', { projectId, agentId, mode, modelRef, modelSelection }));
    } catch (err) {
      const marker = 'CLOUD_CONFIRMATION_REQUIRED:';
      const message = err instanceof Error ? err.message : String(err);
      const markerIndex = message.indexOf(marker);
      if (markerIndex === -1) throw err;
      const providerLabel = message.slice(markerIndex + marker.length).trim();
      const confirmed = window.confirm(
        `El contenido de este chat va a salir de tu PC hacia ${providerLabel}.\n\n` +
          '¿Confirmás usar este modelo para este chat? (se te va a preguntar una sola vez por proyecto)',
      );
      if (!confirmed) {
        throw new Error('Se canceló la creación del chat: no se confirmó el uso de un modelo en la nube.', { cause: err });
      }
      return addChat(await invoke('chat:create', { projectId, agentId, mode, modelRef, modelSelection, confirmed: true }));
    }
  },

  loadHistory: async (chatId) => {
    const loadRevision = (historyLoadRevisionByChat.get(chatId) ?? 0) + 1;
    historyLoadRevisionByChat.set(chatId, loadRevision);
    const runAtStart = useRunStore.getState();
    const capturedRunRevision = chatRunRevision(runAtStart, chatId);
    const existingRunIds = new Set(Object.entries(runAtStart.runChatIds)
      .filter(([, candidateChatId]) => candidateChatId === chatId)
      .map(([runId]) => runId));
    set({ loading: true, error: undefined });
    try {
      const history: ChatHistory = await invoke('chat:history', { chatId });
      if (historyLoadRevisionByChat.get(chatId) !== loadRevision) return;
      // El historial persistido se proyecta directamente sobre runStore para que la UI de chat
      // (mensajes, tool calls, checkpoints, tasks) tenga una única fuente sin importar si vino de
      // eventos en vivo o de `chat:history` (doc 01 §4.1: "todo derivado, reconstruible desde
      // chat:history e IPC").
      //
      // Corrección (hallazgo #3): además de volcar `toolCalls`, hay que reconstruir
      // `toolCallOrderByRun` (`buildToolCallOrderByRun` arriba) — si no, `ChatMessageList` no tiene
      // por dónde pintar las tarjetas de tool call de un run rehidratado (ver también
      // `packages/runtime/src/agent/RunController.ts`, que debería setear `ToolCallRecord.messageId`;
      // eso queda fuera de esta tarea porque no es un archivo de `apps/desktop/src/renderer`).
      const toolCallOrderByRunFromHistory = buildToolCallOrderByRun(history.toolCalls);
      useRunStore.setState((run) => {
        // Si apareció o avanzó un run mientras `chat:history` estaba en vuelo, su stream es más
        // nuevo que la foto persistida. En ese caso se cargan mensajes/artefactos, pero no se
        // reintroduce como "actual" el último run obsoleto de la respuesta.
        const mayHydrateLastRun = history.lastRun !== undefined
          && !existingRunIds.has(history.lastRun.id)
          && chatRunRevision(run, chatId) === capturedRunRevision;
        let runChatIds = run.runChatIds;
        let runStates = run.runStates;
        let errorsByRun = run.errorsByRun;
        if (mayHydrateLastRun && history.lastRun) {
          runChatIds = { ...runChatIds, [history.lastRun.id]: chatId };
          runStates = { ...runStates, [history.lastRun.id]: history.lastRun.state };
          errorsByRun = { ...errorsByRun };
          if (history.lastRun.error) errorsByRun[history.lastRun.id] = [history.lastRun.error];
          else delete errorsByRun[history.lastRun.id];
        }
        return {
          ...run,
          runChatIds,
          runStates,
          errorsByRun,
          messagesByChat: { ...run.messagesByChat, [chatId]: history.messages },
          checkpointsByChat: { ...run.checkpointsByChat, [chatId]: history.checkpoints },
          tasksByChat: { ...run.tasksByChat, [chatId]: history.tasks },
          toolCalls: history.toolCalls.reduce(
            (acc, call) => ({ ...acc, [call.id]: call }),
            run.toolCalls,
          ),
          toolCallOrderByRun: { ...run.toolCallOrderByRun, ...toolCallOrderByRunFromHistory },
          modelResolutionByChat: history.modelResolution
            ? { ...run.modelResolutionByChat, [chatId]: history.modelResolution }
            : Object.fromEntries(Object.entries(run.modelResolutionByChat).filter(([key]) => key !== chatId)),
        };
      });
      set((state) => ({ loading: false, historyLoaded: { ...state.historyLoaded, [chatId]: true } }));
    } catch (err) {
      if (historyLoadRevisionByChat.get(chatId) !== loadRevision) return;
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  setCurrentChat: (chatId) => {
    chatListRevision += 1;
    set({ currentChatId: chatId, loading: false });
    if (chatId) void invoke('settings:set', { key: LAST_CHAT_SETTINGS_KEY, value: chatId })
      .catch((reason) => set({ error: `No se pudo guardar el último chat: ${String(reason)}` }));
  },
  setMode: (chatId, mode) => set((state) => ({ modeByChat: { ...state.modeByChat, [chatId]: mode } })),
  setDraftModelRef: (projectId, modelRef) => set((state) => ({
    draftModelRefByProject: { ...state.draftModelRefByProject, [projectId]: modelRef },
  })),
  setDraftMode: (projectId, mode) => set((state) => ({
    draftModeByProject: { ...state.draftModeByProject, [projectId]: mode },
  })),
  toggleChatPinned: async (chatId) => {
    const chat = Object.values(get().chatsByProject).flat().find((item) => item.id === chatId);
    if (!chat) throw new Error('No se puede pinear un chat que no está cargado.');
    const current = get().pinnedChatIdsByProject[chat.projectId] ?? [];
    const pinnedChatIds = current.includes(chatId) ? current.filter((id) => id !== chatId) : [...current, chatId];
    await invoke('settings:set', { key: PINNED_CHATS_SETTINGS_KEY, value: pinnedChatIds, projectId: chat.projectId });
    set((state) => ({ pinnedChatIdsByProject: { ...state.pinnedChatIdsByProject, [chat.projectId]: pinnedChatIds } }));
  },

  // Punto 4 del encargo (frontera local/nube): un modelo NUBE tira `CLOUD_CONFIRMATION_REQUIRED:
  // <proveedor>` (apps/desktop/src/main/ipc/chat.ts) la primera vez por proyecto — acá se atrapa,
  // se pide la confirmación explícita ("el contenido de este chat saldrá de tu PC hacia
  // <proveedor>") y, si el usuario confirma, se reintenta con `confirmed: true` (que además persiste
  // el consentimiento del proyecto, así no vuelve a preguntar). Si declina, el chat se queda con el
  // modelo anterior — nunca hay fallback automático a nube.
  setChatModel: async (chatId, modelRef) => {
    try {
      const updated = await invoke('chat:setModel', { chatId, modelRef });
      useRunStore.setState((state) => {
        const { [chatId]: _oldBudget, ...contextBudgetByChat } = state.contextBudgetByChat;
        return { contextBudgetByChat };
      });
      set((state) => ({ chatsByProject: replaceChat(state.chatsByProject, updated) }));
    } catch (err) {
      const marker = 'CLOUD_CONFIRMATION_REQUIRED:';
      const message = err instanceof Error ? err.message : String(err);
      const markerIndex = message.indexOf(marker);
      if (markerIndex === -1) throw err;
      const providerLabel = message.slice(markerIndex + marker.length).trim();
      const confirmed = window.confirm(
        `El contenido de este chat va a salir de tu PC hacia ${providerLabel}.\n\n` +
          '¿Confirmás usar este modelo para este chat? (se te va a preguntar una sola vez por proyecto)',
      );
      if (!confirmed) return;
      const updated = await invoke('chat:setModel', { chatId, modelRef, confirmed: true });
      useRunStore.setState((state) => {
        const { [chatId]: _oldBudget, ...contextBudgetByChat } = state.contextBudgetByChat;
        return { contextBudgetByChat };
      });
      set((state) => ({ chatsByProject: replaceChat(state.chatsByProject, updated) }));
    }
  },

  setChatMode: async (chatId, mode) => {
    const updated = await invoke('chat:setMode', { chatId, mode });
    set((state) => ({
      chatsByProject: replaceChat(state.chatsByProject, updated),
      modeByChat: { ...state.modeByChat, [chatId]: mode },
    }));
  },

  setChatPermissionPreset: async (chatId, preset, confirmed) => {
    const updated = await invoke('chat:setPermissionPreset', { chatId, preset, confirmed });
    set((state) => ({ chatsByProject: replaceChat(state.chatsByProject, updated) }));
  },

  setChatEffort: async (chatId, effort) => {
    const updated = await invoke('chat:setEffort', { chatId, effort });
    set((state) => ({ chatsByProject: replaceChat(state.chatsByProject, updated) }));
  },

  renameChat: async (chatId, title) => {
    const updated = await invoke('chat:rename', { chatId, title });
    set((state) => ({ chatsByProject: replaceChat(state.chatsByProject, updated) }));
  },

  archiveChat: async (chatId, archived) => {
    const updated = await invoke('chat:archive', { chatId, archived });
    set((state) => ({
      chatsByProject: replaceChat(state.chatsByProject, updated),
      currentChatId: archived && state.currentChatId === chatId ? undefined : state.currentChatId,
    }));
  },

  deleteChat: async (chatId) => {
    const deletedChat = Object.values(get().chatsByProject).flat().find((chat) => chat.id === chatId);
    await invoke('chat:delete', { chatId });
    if (deletedChat) {
      const currentPinned = get().pinnedChatIdsByProject[deletedChat.projectId] ?? [];
      const pinnedChatIds = currentPinned.filter((id) => id !== chatId);
      await invoke('settings:set', { key: PINNED_CHATS_SETTINGS_KEY, value: pinnedChatIds, projectId: deletedChat.projectId });
    }
    set((state) => {
      const chatsByProject = Object.fromEntries(Object.entries(state.chatsByProject).map(([projectId, chats]) => [
        projectId,
        chats.filter((chat) => chat.id !== chatId),
      ]));
      const pinnedChatIdsByProject = Object.fromEntries(Object.entries(state.pinnedChatIdsByProject).map(([projectId, ids]) => [
        projectId,
        ids.filter((id) => id !== chatId),
      ]));
      return { chatsByProject, pinnedChatIdsByProject, currentChatId: state.currentChatId === chatId ? undefined : state.currentChatId };
    });
  },
}));
