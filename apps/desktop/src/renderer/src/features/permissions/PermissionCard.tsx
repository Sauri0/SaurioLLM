// Tarjeta de permiso bloqueante (doc 06 §8, doc 01 §4.1 "tarjetas de tool/permiso/checkpoint")
// — apps/desktop/src/renderer/src/features/permissions/PermissionCard.tsx.
import { useState } from 'react';
import type { PermissionAnswer, PermissionRequest } from '@saurio/shared';
import { ShieldIcon } from '../../ui/icons.js';
import './permissions.css';

const CATEGORY_LABEL: Record<PermissionRequest['category'], string> = {
  read: 'Lectura', write: 'Escritura', delete: 'Borrado', terminal: 'Terminal',
  git_commit: 'Git commit', git_push: 'Git push', network: 'Red', mcp: 'MCP',
};

const RISK_LABEL: Record<PermissionRequest['risk'], string> = { low: 'Bajo', medium: 'Medio', high: 'Alto' };

export interface PermissionCardProps {
  request: PermissionRequest;
  /** `noAllowOption` (doc 06 §12, campo agregado a `PermissionRequest`) no está en el schema zod
   *  compartido (packages/shared/src/domain.ts no lo declara — ver deviations); se recibe acá como
   *  prop opcional para que el consumidor pueda pasarlo si su capa de runtime lo agrega por fuera
   *  del contrato tipado, sin bloquear la UI mientras tanto. */
  noAllowOption?: boolean;
  onAnswer: (answer: PermissionAnswer) => void;
}

/** Botones y motivo de denegación (doc 06 §7/§8: allow_once / allow_always con scope project|global /
 *  deny con motivo opcional en texto libre) y patrón editable (doc 06 §4 "sintaxis de pattern",
 *  `suggestedPattern` de cada `rememberOptions`). */
export function PermissionCard({ request, noAllowOption, onAnswer }: PermissionCardProps): React.JSX.Element {
  const projectOption = request.rememberOptions.find((o) => o.scope === 'project');
  const globalOption = request.rememberOptions.find((o) => o.scope === 'global');
  const [pattern, setPattern] = useState(projectOption?.suggestedPattern ?? globalOption?.suggestedPattern ?? '');
  const [denyReason, setDenyReason] = useState('');
  const [showDenyReason, setShowDenyReason] = useState(false);

  function allowOnce(): void {
    onAnswer({ toolCallId: request.toolCallId, answer: 'allow_once' });
  }
  function allowAlways(scope: 'project' | 'global'): void {
    onAnswer({ toolCallId: request.toolCallId, answer: 'allow_always', rememberScope: scope, pattern });
  }
  function deny(): void {
    onAnswer({ toolCallId: request.toolCallId, answer: 'deny', reason: denyReason || undefined });
    setShowDenyReason(false);
    setDenyReason('');
  }

  return (
    <div className={`permission-card risk-${request.risk}`} role="alertdialog" aria-label="Solicitud de permiso">
      <div className="permission-card__header">
        <span className="permission-card__icon" aria-hidden="true"><ShieldIcon width={15} height={15} /></span>
        <span className={`permission-card__category cat-${request.category}`}>{CATEGORY_LABEL[request.category]}</span>
        <span className="permission-card__risk">Riesgo: {RISK_LABEL[request.risk]}</span>
        {noAllowOption && <span className="permission-card__warning">⚠ Acción crítica</span>}
      </div>
      <p className="permission-card__summary">{request.summary}</p>
      <p className="permission-card__triggered-by">Motivo del pedido: {request.triggeredBy}</p>

      {request.preview && (
        <div className="permission-card__preview">
          {request.preview.command && <pre className="permission-card__command">{request.preview.command}</pre>}
          {request.preview.diff && <pre className="permission-card__diff">{request.preview.diff}</pre>}
          {request.preview.paths && request.preview.paths.length > 0 && (
            <ul className="permission-card__paths">
              {request.preview.paths.map((p) => (<li key={p}>{p}</li>))}
            </ul>
          )}
        </div>
      )}

      {!noAllowOption && request.rememberOptions.length > 0 && (
        <div className="permission-card__pattern">
          <label htmlFor={`pattern-${request.toolCallId}`}>Patrón a recordar</label>
          <input
            id={`pattern-${request.toolCallId}`}
            type="text"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
          />
        </div>
      )}

      {showDenyReason && (
        <div className="permission-card__deny-reason">
          <label htmlFor={`deny-reason-${request.toolCallId}`}>Motivo (opcional)</label>
          <input
            id={`deny-reason-${request.toolCallId}`}
            type="text"
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
          />
        </div>
      )}

      <div className="permission-card__actions">
        <button type="button" className="saurio-btn-primary" onClick={allowOnce}>Permitir una vez</button>
        {!noAllowOption && projectOption && (
          <button type="button" onClick={() => allowAlways('project')}>Permitir siempre en este proyecto</button>
        )}
        {!noAllowOption && globalOption && (
          <button type="button" onClick={() => allowAlways('global')}>Permitir siempre</button>
        )}
        {showDenyReason ? (
          <button type="button" className="permission-card__deny saurio-btn-danger" onClick={deny}>Confirmar denegación</button>
        ) : (
          <button type="button" className="permission-card__deny saurio-btn-ghost" onClick={() => setShowDenyReason(true)}>Denegar</button>
        )}
      </div>
    </div>
  );
}
