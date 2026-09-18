// Centro de chat: cabecera (título, modelo, modo, estado del run + checklist colapsable) y el
// panel de mensajes/entrada — apps/desktop/src/renderer/src/layout/ChatCenter.tsx.
//
// Pasada de diseño #2: antes este archivo montaba la checklist de tareas suelta, pegada arriba del
// todo (`.saurio-chat-center__tasks`), sin ningún encabezado con título/modelo/modo/estado del run.
// Ahora esa franja es `ChatHeader` (features/chat), que además colapsa la checklist por defecto
// cuando hay más de 3 tareas — la conversación se queda con la mayor parte de la altura disponible.
import { useEffect, useState } from 'react';
import type { Chat, Mode, ModelRef, Task } from '@saurio/shared';
import { ChatPanel, ChatHeader } from '../features/chat/index.js';
import { findActiveRunId } from '../features/chat/runStatus.js';
import { useChatStore } from '../stores/chatStore.js';
import { useRunStore } from '../stores/runStore.js';
import { useModelsStore } from '../stores/modelsStore.js';
import { useProvidersStore } from '../stores/providersStore.js';
import { invoke } from '../ipc/client.js';
import { FolderIcon } from '../ui/icons.js';

/** Referencia estable para "sin tareas". CAUSA RAÍZ (pantalla en blanco en dev, ver sesión de
 *  debugging): el selector de useRunStore devolvía `[]` como literal inline cuando no había
 *  currentChatId o no existía entrada en tasksByChat. React 19 (useSyncExternalStore) compara el
 *  snapshot anterior y el nuevo con Object.is; un array nuevo en cada llamada nunca es igual al
 *  anterior, así que cada render dispara una re-suscripción que vuelve a renderizar sin fin
 *  ("The result of getSnapshot should be cached to avoid an infinite loop" → "Maximum update depth
 *  exceeded" → React desmonta el árbol entero por falta de ErrorBoundary → ventana en blanco).
 *  Usar una misma referencia (`EMPTY_TASKS`) en vez de `[]`/`?? []` evita el bucle. */
const EMPTY_TASKS: Task[] = [];
const EMPTY_CHATS: Chat[] = [];
const DEFAULT_MODE: Mode = 'agent';

/** Agente builtin sembrado por el runtime al arrancar (packages/runtime/src/agent/defaults.ts) y
 *  modelo por defecto medido para este equipo (qwen3:8b, num_ctx 8192, 100% en GPU), usado como
 *  fallback antes de que `models:list` responda. El Centro de agentes (elegir otro agente por
 *  chat) es v0.2. Crear el chat en sí ahora lo dispara `layout/Sidebar.tsx` (pasada de diseño #1:
 *  único lugar con "+ Nuevo chat"); acá solo queda como semilla para el estado vacío de `ChatPanel`. */
const DEFAULT_AGENT_ID = 'agent_builtin_lead';
const DEFAULT_MODEL_REF = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' as const };

export interface ChatCenterProps {
  projectId: string | null;
  onOpenDiff: (checkpointId: string, relPath: string) => void;
}

export function ChatCenter({ projectId, onOpenDiff }: ChatCenterProps): React.JSX.Element {
  const currentChatId = useChatStore((s) => s.currentChatId);
  const chat = useChatStore((s) => {
    if (!projectId || !currentChatId) return undefined;
    return (s.chatsByProject[projectId] ?? EMPTY_CHATS).find((c) => c.id === currentChatId);
  });
  const mode = useChatStore((s) => (currentChatId ? (s.modeByChat[currentChatId] ?? DEFAULT_MODE) : DEFAULT_MODE));
  const tasks = useRunStore((s) => (currentChatId ? (s.tasksByChat[currentChatId] ?? EMPTY_TASKS) : EMPTY_TASKS));
  const runStates = useRunStore((s) => s.runStates);
  const runChatIds = useRunStore((s) => s.runChatIds);
  const activeRunId = findActiveRunId(currentChatId, runChatIds, runStates);
  const runState = activeRunId ? runStates[activeRunId] : undefined;
  const installedModels = useModelsStore((s) => s.installed);
  const providers = useProvidersStore((s) => s.providers);
  const loadProviders = useProvidersStore((s) => s.load);
  const setChatModel = useChatStore((s) => s.setChatModel);
  const setChatMode = useChatStore((s) => s.setChatMode);
  const [changingChatConfig, setChangingChatConfig] = useState(false);

  // Punto 3 del encargo (selector agrupado por proveedor): `providersStore` alimenta el `<optgroup>`
  // de `ModelSelect` con la etiqueta real de cada proveedor — se carga acá porque ChatCenter es lo
  // primero que se monta con un proyecto abierto, sin depender de que Ajustes ya se haya visitado.
  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  // Punto 5 del encargo ("reanudar permisos pendientes tras reinicio en la UI — tarjeta de permiso
  // rehidratada"): al abrir (o cambiar de) proyecto, se repobla `PermissionCard` con lo que quedó
  // `awaiting_permission` de una sesión anterior — sin esto, la tarjeta solo reaparecía si el usuario
  // dejaba la app abierta durante todo el reinicio (imposible) o si un evento en vivo volvía a
  // llegar (nunca pasa solo tras un reinicio real, doc 10 §5.2).
  useEffect(() => {
    if (!projectId) return;
    invoke('permission:pending', undefined)
      .then((pending) => useRunStore.getState().hydratePendingPermissions(pending))
      .catch((err) => console.error('[ChatCenter] no se pudo pedir permission:pending', err));
  }, [projectId]);

  // Punto 3 del encargo: cambiar modelo/modo de ESTE chat desde la cabecera, sin recrearlo
  // (`chat:setModel`/`chat:setMode`, doc 16 §2 ya menciona que `createRuntime.ts` hereda el modelo
  // vigente del chat en cada `run:start`/`run:continue`, así que el próximo turno ya usa el cambio).
  const handleChangeModel = (ref: ModelRef): void => {
    if (!currentChatId) return;
    setChangingChatConfig(true);
    void setChatModel(currentChatId, ref).finally(() => setChangingChatConfig(false));
  };
  const handleChangeMode = (nextMode: Mode): void => {
    if (!currentChatId) return;
    setChangingChatConfig(true);
    void setChatMode(currentChatId, nextMode).finally(() => setChangingChatConfig(false));
  };

  if (!projectId) {
    return (
      <div className="saurio-empty-state saurio-empty-state--fill">
        <span className="saurio-empty-state__icon"><FolderIcon width={22} height={22} /></span>
        <span className="saurio-empty-state__title">Abrí una carpeta para empezar</span>
        <span className="saurio-empty-state__hint">
          SaurioLLM trabaja sobre un proyecto local. Usá &quot;Abrir carpeta…&quot; en la barra
          lateral para elegir dónde va a leer y editar archivos.
        </span>
      </div>
    );
  }

  return (
    <div className="saurio-chat-center">
      {currentChatId && (
        <ChatHeader
          chat={chat}
          mode={mode}
          runState={runState}
          tasks={tasks}
          installedModels={installedModels}
          providers={providers}
          onChangeModel={handleChangeModel}
          onChangeMode={handleChangeMode}
          changing={changingChatConfig}
        />
      )}
      <div className="saurio-chat-center__panel">
        <ChatPanel
          projectId={projectId}
          chat={chat}
          defaultAgentId={DEFAULT_AGENT_ID}
          defaultModelRef={DEFAULT_MODEL_REF}
          onOpenDiff={onOpenDiff}
        />
      </div>
    </div>
  );
}
