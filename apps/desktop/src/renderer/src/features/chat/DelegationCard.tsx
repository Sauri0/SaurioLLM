// DelegationCard: tarjeta de una tool call `delegate` (doc 19 §2.6, E3a "Delegación desde el chat")
// — apps/desktop/src/renderer/src/features/chat/DelegationCard.tsx. Se renderiza donde ocurrió la
// tool call de categoría `delegate` (ChatMessageList, en vez de la ToolCallCard genérica): muestra el
// destino (agente existente o "worker temporal"), la tarea pedida y — cuando el run hijo termina —
// el resultado estructurado con un link "ver conversación completa".
import type { RunState, ToolCallRecord } from '@saurio/shared';
import { UserIcon } from '../../ui/icons.js';
import './chat.css';

interface DelegationArgs {
  targetAgentId?: string;
  role?: string;
  task?: string;
  expectedDeliverable?: string;
}

interface DelegationResultView {
  status?: 'completed' | 'failed' | 'needs_input';
  summary?: string;
  uncertainties?: string[];
  nextAction?: string;
}

function parseArgs(args: unknown): DelegationArgs {
  return args && typeof args === 'object' ? (args as DelegationArgs) : {};
}

/** `resultPreview` es el `JSON.stringify(DelegationResult)` que `RunController.runDelegateTool`
 *  arma (packages/runtime/src/agent/RunController.ts) — puede venir truncado a 500 chars
 *  (`previewOf`), así que un JSON.parse puede fallar si el summary era largo; se degrada a mostrar
 *  el texto crudo en ese caso, nunca revienta la tarjeta. */
function parseResult(preview: string | undefined): DelegationResultView | undefined {
  if (!preview) return undefined;
  try {
    return JSON.parse(preview) as DelegationResultView;
  } catch {
    return { summary: preview };
  }
}

const STATUS_LABEL: Record<string, string> = { completed: 'Completado', failed: 'Falló', needs_input: 'Necesita más info' };

export interface DelegationCardProps {
  call: ToolCallRecord;
  /** Resuelto por toolCallId para eventos nuevos; replays legacy conservan fallback por orden. */
  childChatId?: string;
  childRunId?: string;
  childRunState?: RunState;
  stopping?: boolean;
  stopError?: string;
  onStopChild?: (parentRunId: string, childRunId: string) => void;
  onOpenChat?: (chatId: string) => void;
}

const TERMINAL_RUN_STATES = new Set<RunState>(['completed', 'cancelled', 'failed', 'interrupted']);

export function DelegationCard({
  call, childChatId, childRunId, childRunState, stopping = false, stopError, onStopChild, onOpenChat,
}: DelegationCardProps): React.JSX.Element {
  const args = parseArgs(call.args);
  const result = call.status === 'done' || call.status === 'failed' ? parseResult(call.resultPreview) : undefined;
  const targetLabel = args.targetAgentId ? args.targetAgentId : 'worker temporal';
  const childActive = childRunState !== undefined && !TERMINAL_RUN_STATES.has(childRunState);

  return (
    <div className={`delegation-card status-${call.status}`}>
      <div className="delegation-card__header">
        <span className="delegation-card__icon" aria-hidden="true"><UserIcon width={13} height={13} /></span>
        <span className="delegation-card__title">Delegación a {targetLabel}</span>
      </div>
      {args.task && <p className="delegation-card__task"><strong>Tarea:</strong> {args.task}</p>}
      {args.expectedDeliverable && <p className="delegation-card__deliverable"><strong>Entregable esperado:</strong> {args.expectedDeliverable}</p>}
      {childRunId && childActive && onStopChild && (
        <button
          type="button"
          className="saurio-btn-ghost delegation-card__stop"
          disabled={stopping}
          onClick={() => onStopChild(call.runId, childRunId)}
        >
          {stopping ? 'Deteniendo…' : 'Detener worker'}
        </button>
      )}
      {stopError && <p className="saurio-text-dim delegation-card__error" role="alert">No se pudo detener: {stopError}</p>}
      {result ? (
        <div className={`delegation-card__result delegation-card__result--${result.status ?? 'unknown'}`}>
          <span className="delegation-card__result-status">{STATUS_LABEL[result.status ?? ''] ?? 'Resultado'}</span>
          {result.summary && <p className="delegation-card__summary">{result.summary}</p>}
          {result.uncertainties && result.uncertainties.length > 0 && (
            <ul className="delegation-card__uncertainties">
              {result.uncertainties.map((u, i) => <li key={i}>{u}</li>)}
            </ul>
          )}
          {childChatId && onOpenChat && (
            <button type="button" className="saurio-btn-ghost delegation-card__open-chat" onClick={() => onOpenChat(childChatId)}>
              Ver conversación completa
            </button>
          )}
        </div>
      ) : (
        <span className="saurio-text-dim delegation-card__pending">
          {call.status === 'running' ? 'Delegando…' : call.status}
        </span>
      )}
    </div>
  );
}
