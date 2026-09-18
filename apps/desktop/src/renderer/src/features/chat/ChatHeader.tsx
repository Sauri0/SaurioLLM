// Cabecera del chat: título, modelo activo, modo y estado del run — pasada de diseño #2. Antes no
// existía ninguna cabecera: la checklist de tareas quedaba pegada arriba del todo y empujaba la
// conversación hacia abajo. Ahora la checklist vive acá debajo, colapsada por defecto cuando hay
// más de 3 tareas (mostrando "2/4 hechas"), así la conversación se queda con la mayor parte de la
// altura del centro de chat. apps/desktop/src/renderer/src/features/chat/ChatHeader.tsx.
import { useEffect, useState } from 'react';
import type { AgentProfile, Chat, Mode, ModelInfo, ModelRef, ProviderConfig, RunState, Task } from '@saurio/shared';
import { TaskChecklist } from '../tasks/index.js';
import { runStatusLabel, runStatusVisual } from './runStatus.js';
import { ChevronDownIcon } from '../../ui/icons.js';
import { ModelSelect } from '../models/ModelSelect.js';
import { localityLabel } from '../models/locality.js';
import { useRunStore } from '../../stores/runStore.js';
import { useOllamaHealthStore } from '../../stores/ollamaHealthStore.js';
import './chat.css';

const MODE_LABEL: Record<Mode, string> = { plan: 'Plan', ask: 'Preguntar', edit: 'Editar', agent: 'Agente' };
const MODES: Mode[] = ['agent', 'edit', 'plan', 'ask'];
const TASKS_COLLAPSE_THRESHOLD = 3;
const AUTO_TITLE_MAX_CHARS = 48;

/** PRIORIDAD CERO punto 5 (bloqueo real: la cabecera mostraba "Chat sin título" o el id crudo del
 *  chat en vez de algo legible). `chat.title` no se autogenera todavía del lado del servidor (no
 *  hay canal IPC para persistirlo — fuera del alcance chico de este arreglo puntual); acá se deriva
 *  SOLO para mostrar, a partir del primer mensaje del usuario ya cargado en `runStore` para este
 *  chat, sin escribir nada nuevo en `chats.title`. */
export function deriveDisplayTitle(chat: Chat | undefined, firstUserMessage: string | undefined): string {
  if (chat?.title) return chat.title;
  if (firstUserMessage && firstUserMessage.trim().length > 0) {
    const oneLine = firstUserMessage.trim().replace(/\s+/g, ' ');
    return oneLine.length > AUTO_TITLE_MAX_CHARS ? `${oneLine.slice(0, AUTO_TITLE_MAX_CHARS)}…` : oneLine;
  }
  return 'Chat nuevo';
}

export interface ChatHeaderProps {
  chat: Chat | undefined;
  mode: Mode;
  runState: RunState | undefined;
  tasks: Task[];
  /** Punto 3 del encargo: cambiar modelo/modo de ESTE chat ya creado. `installedModels` es la
   *  fuente para el selector (mismo catálogo que el Centro de modelos, doc 13 §9 badge de
   *  localidad); si viene vacío el selector queda deshabilitado en vez de romper. */
  installedModels?: ModelInfo[];
  /** Para agrupar el selector por proveedor (punto 3 del encargo) — providersStore. */
  providers?: ProviderConfig[];
  onChangeModel?: (ref: ModelRef) => void;
  onChangeMode?: (mode: Mode) => void;
  changing?: boolean;
  /** Doc 19 §1.6/R04 ("identidad y alcance visibles"): presente cuando `chat.agentId` es un agente
   *  personal (no el builtin) — se muestra nombre+avatar junto al selector de modelo. `undefined`
   *  para el agente builtin, comportamiento previo sin cambios. */
  agent?: AgentProfile;
}

export function ChatHeader({
  chat, mode, runState, tasks, installedModels = [], providers = [], onChangeModel, onChangeMode, changing, agent,
}: ChatHeaderProps): React.JSX.Element {
  const sorted = [...tasks].sort((a, b) => a.ord - b.ord);
  const done = sorted.filter((t) => t.status === 'done').length;
  const [open, setOpen] = useState(sorted.length <= TASKS_COLLAPSE_THRESHOLD);
  const canEdit = Boolean(chat && (onChangeModel || onChangeMode));
  const firstUserMessage = useRunStore((s) => {
    if (!chat) return undefined;
    return (s.messagesByChat[chat.id] ?? []).find((m) => m.role === 'user')?.content;
  });
  const displayTitle = deriveDisplayTitle(chat, firstUserMessage);

  // Tarea "ModelSelect: estados explícitos" (punto 2): mismo store compartido que Sidebar.tsx — un
  // único poll de `provider:health` para toda la app, no uno por componente montado.
  const ollamaOk = useOllamaHealthStore((s) => s.ok);
  const ollamaStarting = useOllamaHealthStore((s) => s.starting);
  const ollamaStartError = useOllamaHealthStore((s) => s.startError);
  const startOllama = useOllamaHealthStore((s) => s.start);
  const subscribeOllamaHealth = useOllamaHealthStore((s) => s.subscribe);
  useEffect(() => subscribeOllamaHealth(), [subscribeOllamaHealth]);

  return (
    <header className="chat-header">
      <div className="chat-header__row">
        <h1 className="chat-header__title" title={chat?.title ? undefined : 'Título autogenerado del primer mensaje'}>{displayTitle}</h1>
        <div className="chat-header__meta">
          {agent && (
            <span className="saurio-badge chat-header__agent" title={agent.description ?? `Chat directo con "${agent.name}"`}>
              {agent.avatarEmoji ? `${agent.avatarEmoji} ` : ''}{agent.name}
            </span>
          )}
          {canEdit && onChangeModel ? (
            <ModelSelect
              models={installedModels}
              providers={providers}
              value={chat?.modelRef}
              onChange={onChangeModel}
              disabled={changing}
              title="Cambiar el modelo de este chat"
              engineState={ollamaStarting ? 'starting' : (ollamaOk === false && installedModels.length === 0 ? 'down' : 'ready')}
              onStartEngine={() => void startOllama()}
              startEngineError={ollamaStartError}
            />
          ) : (
            chat?.modelRef && (
              <>
                <span className="saurio-badge" title="Modelo activo de este chat">{chat.modelRef.name}</span>
                {/* Punto 4 del encargo: "badge NUBE visible... en cabecera del chat" — antes esto
                    siempre pintaba la clase `local` sin importar la localidad real del modelo. */}
                <span className={`saurio-badge ${chat.modelRef.locality}`}>{localityLabel(chat.modelRef.locality)}</span>
              </>
            )
          )}
          {canEdit && onChangeMode ? (
            <select
              value={mode}
              onChange={(ev) => onChangeMode(ev.target.value as Mode)}
              disabled={changing}
              title="Cambiar el modo de este chat"
            >
              {MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </select>
          ) : (
            <span className="saurio-badge" title="Modo del agente">{MODE_LABEL[mode]}</span>
          )}
          <span className={`chat-header__run-status chat-header__run-status--${runStatusVisual(runState)}`}>
            <span className="chat-header__run-dot" aria-hidden="true" />
            {runStatusLabel(runState)}
          </span>
        </div>
      </div>

      {sorted.length > 0 && (
        <div className="chat-header__tasks">
          <button
            type="button"
            className="chat-header__tasks-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <ChevronDownIcon
              width={12}
              height={12}
              className={`chat-header__tasks-chevron${open ? '' : ' chat-header__tasks-chevron--closed'}`}
            />
            Tareas
            <span className="chat-header__tasks-count">{done}/{sorted.length} hechas</span>
          </button>
          {open && (
            <div className="chat-header__tasks-body">
              <TaskChecklist tasks={sorted} />
            </div>
          )}
        </div>
      )}
    </header>
  );
}
