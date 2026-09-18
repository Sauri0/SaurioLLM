// Tarjeta de tool call: nombre, args resumidos, estado, salida truncada (doc 01 §4.1)
// — apps/desktop/src/renderer/src/features/chat/ToolCallCard.tsx.
import type { ToolCallRecord } from '@saurio/shared';
import { CheckIcon, CircleDotIcon, FileIcon, GitBranchIcon, ShieldIcon, TerminalIcon, WrenchIcon } from '../../ui/icons.js';

const STATUS_LABEL: Record<ToolCallRecord['status'], string> = {
  pending: 'Pendiente', awaiting_permission: 'Esperando permiso', approved: 'Aprobada',
  denied: 'Denegada', running: 'Ejecutando…', awaiting_input: 'Esperando entrada',
  done: 'Hecha', failed: 'Falló', cancelled: 'Cancelada', orphaned: 'Huérfana', abandoned: 'Abandonada',
};

/** Icono por herramienta (heurística sobre el nombre — no hay un campo "categoría de icono" en el
 *  contrato); es solo decorativo, la información real está en `STATUS_LABEL` y en el texto. */
function toolIcon(toolName: string): React.JSX.Element {
  if (/read|list|search|grep|glob/i.test(toolName)) return <FileIcon width={13} height={13} />;
  if (/terminal|run_|shell|command/i.test(toolName)) return <TerminalIcon width={13} height={13} />;
  if (/git/i.test(toolName)) return <GitBranchIcon width={13} height={13} />;
  if (/permission/i.test(toolName)) return <ShieldIcon width={13} height={13} />;
  return <WrenchIcon width={13} height={13} />;
}

function statusIcon(status: ToolCallRecord['status']): React.JSX.Element | null {
  if (status === 'done') return <CheckIcon width={12} height={12} />;
  if (status === 'running' || status === 'pending' || status === 'awaiting_permission') return <CircleDotIcon width={12} height={12} />;
  return null;
}

export interface ToolCallCardProps {
  call: ToolCallRecord;
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  try {
    const text = JSON.stringify(args);
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  } catch {
    return String(args);
  }
}

/** "salida truncada" (doc 01 §4.1): acá se corta a nivel de UI ademas del truncado nivel 0 que ya
 *  aplica ToolSystem (doc 01 §4.3) antes de guardar `resultPreview`. */
function truncatePreview(preview: string | undefined): string | undefined {
  if (preview === undefined) return undefined;
  return preview.length > 400 ? `${preview.slice(0, 400)}…` : preview;
}

export function ToolCallCard({ call }: ToolCallCardProps): React.JSX.Element {
  const output = truncatePreview(call.resultPreview);
  return (
    <div className={`tool-call-card status-${call.status}`}>
      <div className="tool-call-card__header">
        <span className="tool-call-card__name">
          <span className="tool-call-card__icon" aria-hidden="true">{toolIcon(call.toolName)}</span>
          {call.toolName}
        </span>
        <span className="tool-call-card__status">
          {statusIcon(call.status)}
          {STATUS_LABEL[call.status]}
        </span>
      </div>
      <code className="tool-call-card__args">{summarizeArgs(call.args)}</code>
      {call.resultIsError && <p className="tool-call-card__error">Error</p>}
      {output && (
        // Salida colapsable (pasada de diseño UI): abierta por defecto para no ocultar el resultado
        // de una sola tool call corta, pero se puede cerrar cuando el output es largo.
        <details className="tool-call-card__output" open>
          <summary>Salida</summary>
          <pre>{output}</pre>
        </details>
      )}
      {call.error && <p className="tool-call-card__error">{call.error.message}</p>}
    </div>
  );
}
