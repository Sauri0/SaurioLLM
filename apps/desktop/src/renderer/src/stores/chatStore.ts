// chatStore: chats por proyecto + historial cargado (doc 01 §4.1, doc 04 §16 `chat:create/list/history`)
// — apps/desktop/src/renderer/src/stores/chatStore.ts.
import { create } from 'zustand';
import type { Chat, IpcOutput, Mode, ModelRef, ToolCallRecord } from '@saurio/shared';
import { invoke } from '../ipc/client.js';
import { useRunStore } from './runStore.js';

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
  /** Modo elegido en el bloque "próximo chat" de la barra lateral (pasada de diseño #1: antes solo
   *  existía `DEFAULT_MODE` fijo pasado a `chat:create`, sin forma de elegir Plan para el primer
   *  mensaje de un chat nuevo). Por proyecto, igual que `draftModelRefByProject`. */
  draftModeByProject: Record<string, Mode>;
  historyLoaded: Record<string, boolean>;
  loading: boolean;
  error: string | undefined;

  loadChats: (projectId: string) => Promise<void>;
  createChat: (projectId: string, agentId: string, mode: Mode, modelRef: ModelRef) => Promise<Chat>;
  loadHistory: (chatId: string) => Promise<void>;
  /** `undefined` deselecciona (p. ej. al cambiar de proyecto desde el layout). */
  setCurrentChat: (chatId: string | undefined) => void;
  setMode: (chatId: string, mode: Mode) => void;
  setDraftModelRef: (projectId: string, modelRef: ModelRef) => void;
  setDraftMode: (projectId: string, mode: Mode) => void;
  /** Punto 3 del encargo: cambiar modelo/modo de un CHAT YA CREADO desde la cabecera, vía
   *  `chat:setModel`/`chat:setMode` (antes no existían — ver comentario que quedaba en
   *  `draftModelRefByProject` de más arriba, ahora resuelto). No toca ningún run en curso: el
   *  próximo `run:start`/`run:continue` de este chat toma el valor nuevo. */
  setChatModel: (chatId: string, modelRef: ModelRef) => Promise<void>;
  setChatMode: (chatId: string, mode: Mode) => Promise<void>;
}

/** Reemplaza un chat por su versión actualizada dentro de `chatsByProject`, sin tocar otros proyectos. */
function replaceChat(chatsByProject: Record<string, Chat[]>, updated: Chat): Record<string, Chat[]> {
  const list = chatsByProject[updated.projectId];
  if (!list) return chatsByProject;
  return { ...chatsByProject, [updated.projectId]: list.map((c) => (c.id === updated.id ? updated : c)) };
}

export const useChatStore = create<ChatStoreState>((set) => ({
  chatsByProject: {},
  currentChatId: undefined,
  modeByChat: {},
  draftModelRefByProject: {},
  draftModeByProject: {},
  historyLoaded: {},
  loading: false,
  error: undefined,

  loadChats: async (projectId) => {
    set({ loading: true, error: undefined });
    try {
      const chats = await invoke('chat:list', { projectId });
      set((state) => ({ loading: false, chatsByProject: { ...state.chatsByProject, [projectId]: chats } }));
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  // Mismo mecanismo de confirmación que `setChatModel` (frontera local/nube, punto 4 del encargo):
  // crear un chat nuevo YA con un modelo NUBE también pasa por `CLOUD_CONFIRMATION_REQUIRED`.
  createChat: async (projectId, agentId, mode, modelRef) => {
    function addChat(chat: Chat): Chat {
      set((state) => ({
        chatsByProject: { ...state.chatsByProject, [projectId]: [...(state.chatsByProject[projectId] ?? []), chat] },
        modeByChat: { ...state.modeByChat, [chat.id]: mode },
        currentChatId: chat.id,
      }));
      return chat;
    }
    try {
      return addChat(await invoke('chat:create', { projectId, agentId, mode, modelRef }));
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
      return addChat(await invoke('chat:create', { projectId, agentId, mode, modelRef, confirmed: true }));
    }
  },

  loadHistory: async (chatId) => {
    set({ loading: true, error: undefined });
    try {
      const history: ChatHistory = await invoke('chat:history', { chatId });
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
      useRunStore.setState((run) => ({
        ...run,
        messagesByChat: { ...run.messagesByChat, [chatId]: history.messages },
        checkpointsByChat: { ...run.checkpointsByChat, [chatId]: history.checkpoints },
        tasksByChat: { ...run.tasksByChat, [chatId]: history.tasks },
        toolCalls: history.toolCalls.reduce(
          (acc, call) => ({ ...acc, [call.id]: call }),
          run.toolCalls,
        ),
        toolCallOrderByRun: { ...run.toolCallOrderByRun, ...toolCallOrderByRunFromHistory },
      }));
      set((state) => ({ loading: false, historyLoaded: { ...state.historyLoaded, [chatId]: true } }));
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  setCurrentChat: (chatId) => set({ currentChatId: chatId }),
  setMode: (chatId, mode) => set((state) => ({ modeByChat: { ...state.modeByChat, [chatId]: mode } })),
  setDraftModelRef: (projectId, modelRef) => set((state) => ({
    draftModelRefByProject: { ...state.draftModelRefByProject, [projectId]: modelRef },
  })),
  setDraftMode: (projectId, mode) => set((state) => ({
    draftModeByProject: { ...state.draftModeByProject, [projectId]: mode },
  })),

  // Punto 4 del encargo (frontera local/nube): un modelo NUBE tira `CLOUD_CONFIRMATION_REQUIRED:
  // <proveedor>` (apps/desktop/src/main/ipc/chat.ts) la primera vez por proyecto — acá se atrapa,
  // se pide la confirmación explícita ("el contenido de este chat saldrá de tu PC hacia
  // <proveedor>") y, si el usuario confirma, se reintenta con `confirmed: true` (que además persiste
  // el consentimiento del proyecto, así no vuelve a preguntar). Si declina, el chat se queda con el
  // modelo anterior — nunca hay fallback automático a nube.
  setChatModel: async (chatId, modelRef) => {
    try {
      const updated = await invoke('chat:setModel', { chatId, modelRef });
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
}));
