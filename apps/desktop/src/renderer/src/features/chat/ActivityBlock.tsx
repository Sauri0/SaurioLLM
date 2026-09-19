// Bloque "Actividad": UN mensaje por run, con todos los turnos internos, thinking, tool calls y
// permisos resueltos agrupados en un plegable — rediseño del chat (feedback real v0.2.1: "el chat es
// confuso y muy cargado", burbujas "AGENTE" vacías, tarjetas sueltas al final del chat en vez de en
// su lugar cronológico). apps/desktop/src/renderer/src/features/chat/ActivityBlock.tsx.
//
// Referencia exacta de estilo (capturas de Claude Code que pasó el usuario): una sola línea tenue
// con chevron ("Ejecutó un comando, usó 2 herramientas..."), viva mientras corre; al abrir, una
// lista compacta de una línea por paso, cada una con su propio chevron para el detalle. Sin tarjetas
// grandes ni colores fuertes en la fila — el detalle sí puede reusar ToolCallCard/DelegationCard
// (ya truncan/limpian ANSI), pero queda oculto hasta que el usuario lo pide.
import { useState } from 'react';
import type { ToolCallRecord } from '@saurio/shared';
import type { ActivityStep } from './activityGrouping.js';
import { toolStepLabel } from './stepLabel.js';
import { ChevronDownIcon } from '../../ui/icons.js';
import { ToolCallCard } from './ToolCallCard.js';
import { DelegationCard } from './DelegationCard.js';
import './chat.css';

function stepKey(step: ActivityStep, index: number): string {
  if (step.kind === 'tool') return `tool-${step.toolCall.id}`;
  return `${step.kind}-${step.messageId}-${index}`;
}

interface ActivityStepRowProps {
  step: ActivityStep;
  resolveDelegationChatId?: (call: ToolCallRecord) => string | undefined;
  onOpenChat?: (chatId: string) => void;
}

function ActivityStepRow({ step, resolveDelegationChatId, onOpenChat }: ActivityStepRowProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);

  if (step.kind === 'thinking') {
    return (
      <div className="activity-step">
        <button type="button" className="activity-step__row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="activity-step__label">Pensó</span>
          <ChevronDownIcon width={10} height={10} className={`activity-step__chevron${open ? '' : ' activity-step__chevron--closed'}`} />
        </button>
        {open && <pre className="activity-step__detail activity-step__thinking">{step.text}</pre>}
      </div>
    );
  }

  if (step.kind === 'text') {
    if (!step.text.trim()) return null; // vacío puro (turno todavía en curso) no aporta nada al detalle
    return (
      <div className="activity-step">
        <button type="button" className="activity-step__row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="activity-step__label">Escribió un mensaje intermedio</span>
          <ChevronDownIcon width={10} height={10} className={`activity-step__chevron${open ? '' : ' activity-step__chevron--closed'}`} />
        </button>
        {open && <pre className="activity-step__detail">{step.text}</pre>}
      </div>
    );
  }

  // step.kind === 'tool'
  const call = step.toolCall;
  const label = toolStepLabel(call);
  if (call.category === 'delegate') {
    const childChatId = resolveDelegationChatId?.(call);
    return (
      <div className="activity-step">
        <button type="button" className="activity-step__row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="activity-step__label">{label}</span>
          <ChevronDownIcon width={10} height={10} className={`activity-step__chevron${open ? '' : ' activity-step__chevron--closed'}`} />
        </button>
        {open && (
          <div className="activity-step__detail">
            <DelegationCard call={call} childChatId={childChatId} onOpenChat={onOpenChat} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="activity-step">
      <button type="button" className="activity-step__row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="activity-step__label">{label}</span>
        <ChevronDownIcon width={10} height={10} className={`activity-step__chevron${open ? '' : ' activity-step__chevron--closed'}`} />
      </button>
      {open && (
        <div className="activity-step__detail">
          <ToolCallCard call={call} />
        </div>
      )}
    </div>
  );
}

export interface ActivityBlockProps {
  steps: ActivityStep[];
  /** Línea colapsada: viva mientras corre ("Leyendo src/a.ts…"), resumen cuando terminó
   *  ("Trabajó 14 s · 3 lecturas · 1 comando · 2 archivos editados"). */
  headerLabel: string;
  live: boolean;
  defaultOpen?: boolean;
  resolveDelegationChatId?: (call: ToolCallRecord) => string | undefined;
  onOpenChat?: (chatId: string) => void;
}

/** `null` si no hay ningún paso interno (turno de solo texto) — ni siquiera se dibuja el renglón, la
 *  respuesta se ve como una conversación normal, sin ningún vestigio de "Actividad". */
export function ActivityBlock({ steps, headerLabel, live, defaultOpen = false, resolveDelegationChatId, onOpenChat }: ActivityBlockProps): React.JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen);
  if (steps.length === 0) return null;

  return (
    <div className={`activity-block${live ? ' activity-block--live' : ''}`}>
      <button
        type="button"
        className="activity-block__header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {live && <span className="activity-block__spinner" aria-hidden="true" />}
        <span className="activity-block__label">{headerLabel}</span>
        <ChevronDownIcon
          width={11}
          height={11}
          className={`activity-block__chevron${open ? '' : ' activity-block__chevron--closed'}`}
        />
      </button>
      {open && (
        <div className="activity-block__body">
          {steps.map((step, index) => (
            <ActivityStepRow
              key={stepKey(step, index)}
              step={step}
              resolveDelegationChatId={resolveDelegationChatId}
              onOpenChat={onOpenChat}
            />
          ))}
        </div>
      )}
    </div>
  );
}
