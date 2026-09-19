// Mensaje de chat, con streaming — doc 01 §4.1. Rediseño del chat: el `thinking` de un mensaje ya
// NO se muestra acá — vive dentro del bloque "Actividad" de su turno (ActivityBlock.tsx), agrupado
// con los tool calls en vez de como un `<details>` suelto debajo de cada burbuja.
// apps/desktop/src/renderer/src/features/chat/MessageBubble.tsx.
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ChatMessage, Locality, ResponseMetrics } from '@saurio/shared';
import { MessageMetrics } from './MessageMetrics.js';
import { localityLabel } from '../models/locality.js';
import { copyMessageText } from './messageCopy.js';
import { RegenerateRunButton } from './RegenerateRunButton.js';
import { regenerateRunIdForMessage } from './messageActions.js';

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  system: 'Sistema', user: 'Vos', assistant: 'Agente', tool: 'Herramienta',
};

export interface MessageBubbleProps {
  message: ChatMessage;
  metrics?: ResponseMetrics;
  /** true mientras el mensaje sigue en streaming (doc 04 §6 `message.delta`); desactiva markdown
   *  para no re-parsear en cada delta y muestra un cursor de "generando". */
  streaming?: boolean;
  /** Un run vivo en el chat bloquea iniciar una regeneración paralela. */
  hasActiveRun?: boolean;
  /** Punto 4 del encargo (doc 16 §10.4/§10.9, migración 0003): fallback para mensajes de ANTES de
   *  esa migración, que no tienen `message.modelRef` persistido — la locality DEL MODELO ACTUAL del
   *  chat (`chat.modelRef.locality`), igual que hacía toda esta pantalla hasta ahora. Un mensaje con
   *  `modelRef` propio (generado después de la migración) siempre usa ese dato histórico en vez de
   *  este fallback, aunque el chat haya cambiado de modelo local ↔ nube después. */
  currentModelLocality?: Locality;
}

export function MessageBubble({ message, metrics, streaming, hasActiveRun = false, currentModelLocality }: MessageBubbleProps): React.JSX.Element {
  // `message.modelRef` (dato histórico real, migración 0003) tiene prioridad sobre el modelo VIGENTE
  // del chat — solo cae a este último para mensajes de antes de esa migración (sin `modelRef`).
  const effectiveLocality = message.modelRef?.locality ?? currentModelLocality;
  const showCloudBadge = message.role === 'assistant' && effectiveLocality && effectiveLocality !== 'local';
  const regenerateRunId = regenerateRunIdForMessage(message, streaming);
  const [copying, setCopying] = useState(false);
  const [copyResult, setCopyResult] = useState<'copied' | string | undefined>();

  async function handleCopy(): Promise<void> {
    if (copying) return;
    setCopying(true);
    setCopyResult(undefined);
    const result = await copyMessageText(message.content, navigator.clipboard);
    setCopyResult(result.ok ? 'copied' : result.message);
    setCopying(false);
  }

  return (
    <div className={`message-bubble role-${message.role}${message.ephemeral ? ' message-bubble--ephemeral' : ''}`}>
      <div className="message-bubble__role">
        {ROLE_LABEL[message.role]}
        {showCloudBadge && (
          <span
            className={`saurio-badge ${effectiveLocality}`}
            title="Este mensaje se generó con un modelo fuera de esta PC"
          >
            {localityLabel(effectiveLocality)}
          </span>
        )}
      </div>

      <div className="message-bubble__content">
        {streaming ? (
          <pre className="message-bubble__streaming-text">{message.content}<span className="message-bubble__cursor" /></pre>
        ) : (
          <ReactMarkdown>{message.content}</ReactMarkdown>
        )}
      </div>

      {message.content.trim().length > 0 && (
        <div className="message-bubble__actions">
          <button
            type="button"
            className="message-bubble__copy"
            onClick={() => void handleCopy()}
            disabled={copying}
          >
            {copying ? 'Copiando…' : copyResult === 'copied' ? 'Copiado' : 'Copiar'}
          </button>
          {copyResult === 'copied' && <span className="message-bubble__copy-status" role="status">Mensaje copiado.</span>}
          {copyResult && copyResult !== 'copied' && (
            <p className="message-bubble__copy-error" role="alert">No se pudo copiar: {copyResult}</p>
          )}
          {regenerateRunId && <RegenerateRunButton runId={regenerateRunId} disabled={hasActiveRun} />}
        </div>
      )}

      {/* PRIORIDAD CERO punto 5 (bloqueo real: el mensaje del USUARIO mostraba "costo: no
          disponible" / "NO DISPONIBLE"): `RunController.start()` persiste el mensaje del usuario
          reusando el evento `message.done` (ResponseMetricsSchema exige `metrics`, así que ese
          mensaje queda con `{quality:'unavailable'}` como relleno técnico, no como un dato real de
          esa respuesta) — nunca hubo una respuesta que medir para un mensaje que el usuario mismo
          escribió. Las métricas solo tienen sentido para lo que generó el modelo. */}
      {metrics && message.role === 'assistant' && <MessageMetrics metrics={metrics} />}
    </div>
  );
}
