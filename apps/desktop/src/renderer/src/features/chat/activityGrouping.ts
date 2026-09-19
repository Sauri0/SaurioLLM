// Agrupa mensajes + tool calls + checkpoints de UN CHAT en "turnos" (uno por cada mensaje de
// usuario) — rediseño del chat, feedback real v0.2.1: "cada turno interno del modelo se dibuja como
// una burbuja AGENTE vacía"; "las tarjetas de tools y los checkpoints aparecen TODOS JUNTOS AL FINAL
// del chat en vez de en su lugar cronológico". apps/desktop/src/renderer/src/features/chat/
// activityGrouping.ts.
//
// Puro y testeable sin zustand ni React (mismo patrón que buildToolCallOrderByRun en chatStore.ts):
// ChatMessageList arma los turnos con esto y decide cómo pintarlos (ActivityBlock plegado + texto
// final limpio), pero la agrupación en sí no depende de la UI.
import type { ChatMessage, Checkpoint, ToolCallRecord } from '@saurio/shared';

export type ActivityStep =
  | { kind: 'thinking'; messageId: string; text: string }
  // Texto de un mensaje INTERNO del turno (no el último) — caso raro (un provider que combina texto
  // + tool_calls a mitad del turno); igual se agrupa cronológicamente en vez de perderse o de
  // mostrarse como una burbuja "AGENTE" suelta.
  | { kind: 'text'; messageId: string; text: string }
  | { kind: 'tool'; toolCall: ToolCallRecord };

export interface ChatTurn {
  /** Id estable para `key` de React: el id del mensaje de usuario que abrió el turno, o `'leading'`
   *  para mensajes que aparecen antes del primer mensaje de usuario (system/seed, caso raro). */
  id: string;
  userMessage: ChatMessage | undefined;
  /** Pasos internos en orden cronológico — lo que hoy se ve como burbujas "AGENTE" vacías sueltas y
   *  tarjetas de tool call desperdigadas pasa a vivir acá, dentro del bloque "Actividad". */
  steps: ActivityStep[];
  /** Último mensaje assistant del turno con contenido real — se muestra limpio, fuera del plegable.
   *  `undefined` si el turno todavía no produjo un cierre de texto (run en curso, o —caso raro—
   *  terminó en una tool call sin texto de cierre). */
  finalMessage: ChatMessage | undefined;
  /** runId del turno, resuelto desde cualquier tool call que le pertenezca. `undefined` si el turno
   *  no usó ninguna herramienta (turno de solo texto: nada que agrupar ni buscar checkpoints). */
  runId: string | undefined;
  /** Checkpoints de `runId`, en el orden en que llegaron. */
  checkpoints: Checkpoint[];
}

function isBlank(text: string | undefined): boolean {
  return !text || text.trim().length === 0;
}

/** Agrupa mensajes YA CERRADOS (`message.done`, lo que trae `chat:history`/`messagesByChat`) — el
 *  turno EN VIVO (streaming) lo arma aparte `ChatMessageList` a partir de `streamingMessage` y
 *  `currentRunToolCalls`, que todavía no pasaron por acá. */
export function groupMessagesIntoTurns(
  messages: ChatMessage[],
  toolCallsById: Record<string, ToolCallRecord>,
  checkpoints: Checkpoint[],
): ChatTurn[] {
  const allToolCalls = Object.values(toolCallsById);
  const turns: ChatTurn[] = [];
  let current: ChatTurn | undefined;

  function startTurn(id: string, userMessage: ChatMessage | undefined): void {
    if (current) turns.push(current);
    current = { id, userMessage, steps: [], finalMessage: undefined, runId: undefined, checkpoints: [] };
  }

  for (const message of messages) {
    if (message.role === 'user') {
      startTurn(message.id, message);
      continue;
    }
    if (message.role === 'system' || message.role === 'tool') {
      // Mensajes de soporte del contexto del modelo — no tienen bubble propia en el rediseño (el
      // resultado de una tool ya se ve en su ToolCallCard); si llegaran antes de cualquier mensaje de
      // usuario, no hay turno para agregarlos, y no vale la pena crear uno vacío solo para esto.
      continue;
    }
    if (!current) startTurn('leading', undefined);
    const turn = current!;

    // Un mensaje nuevo con contenido real reemplaza al "final" anterior — el anterior (si lo había)
    // pasa a ser un paso de texto interno (más de un mensaje con contenido en el mismo turno).
    if (turn.finalMessage && !isBlank(turn.finalMessage.content)) {
      turn.steps.push({ kind: 'text', messageId: turn.finalMessage.id, text: turn.finalMessage.content });
    }
    if (!isBlank(message.thinking)) {
      turn.steps.push({ kind: 'thinking', messageId: message.id, text: message.thinking! });
    }
    const ownToolCalls = allToolCalls
      .filter((c) => c.messageId === message.id)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    for (const call of ownToolCalls) {
      turn.steps.push({ kind: 'tool', toolCall: call });
      if (!turn.runId) turn.runId = call.runId;
    }
    turn.finalMessage = message;
  }
  if (current) turns.push(current);

  for (const turn of turns) {
    // El "final" solo cuenta si tiene contenido real; si el turno terminó en un mensaje vacío
    // (cerró en una tool call, sin texto de cierre) pasa a ser un paso interno más — no debería
    // quedar un turno terminado sin ningún texto visible, salvo que de verdad no lo tuvo.
    if (turn.finalMessage && isBlank(turn.finalMessage.content)) {
      turn.steps.push({ kind: 'text', messageId: turn.finalMessage.id, text: turn.finalMessage.content });
      turn.finalMessage = undefined;
    }
    if (turn.runId) {
      turn.checkpoints = checkpoints.filter((c) => c.runId === turn.runId);
    }
  }
  return turns;
}

export interface TurnCounts {
  reads: number;
  commands: number;
  edits: number;
  other: number;
  toolCallCount: number;
  usedThinking: boolean;
}

/** Cuenta pasos por categoría — insumo del resumen plegado ("Trabajó 14 s · 3 lecturas · 1 comando ·
 *  2 archivos editados"). Los "archivos editados" del resumen se calculan aparte, a partir de los
 *  checkpoints del turno (más preciso que contar tool calls de escritura: un checkpoint ya dedupe
 *  por archivo realmente tocado) — ver `describeCheckpoints` en RunCheckpointCard.tsx. */
export function countTurnSteps(steps: ActivityStep[]): TurnCounts {
  const counts: TurnCounts = { reads: 0, commands: 0, edits: 0, other: 0, toolCallCount: 0, usedThinking: false };
  for (const step of steps) {
    if (step.kind === 'thinking') {
      counts.usedThinking = true;
      continue;
    }
    if (step.kind !== 'tool') continue;
    counts.toolCallCount += 1;
    switch (step.toolCall.category) {
      case 'read':
        counts.reads += 1;
        break;
      case 'terminal':
        counts.commands += 1;
        break;
      case 'write':
      case 'delete':
        counts.edits += 1;
        break;
      default:
        counts.other += 1;
    }
  }
  return counts;
}

/** Rango [inicio, fin] de un turno completo, a partir de `startedAt`/`finishedAt` de sus tool calls
 *  (los mensajes no llevan timestamp propio en el contrato — ver ChatMessageSchema). `undefined` si
 *  el turno no tiene ninguna tool call con esos datos (turno de solo texto, o datos viejos sin
 *  timestamps persistidos). */
export function turnElapsedMs(steps: ActivityStep[]): number | undefined {
  const timed = steps
    .filter((s): s is Extract<ActivityStep, { kind: 'tool' }> => s.kind === 'tool')
    .filter((s) => s.toolCall.startedAt !== undefined);
  if (timed.length === 0) return undefined;
  const start = Math.min(...timed.map((s) => s.toolCall.startedAt!));
  const end = Math.max(...timed.map((s) => s.toolCall.finishedAt ?? s.toolCall.startedAt!));
  return Math.max(0, end - start);
}
