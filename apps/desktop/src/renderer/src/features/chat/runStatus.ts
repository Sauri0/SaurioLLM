// Estado de run legible para humanos, para la cabecera del chat (pasada de diseño #2: antes no
// había cabecera ni forma de saber "en cola / generando / esperando permiso / completado" sin leer
// la checklist o el compositor). apps/desktop/src/renderer/src/features/chat/runStatus.ts.
//
// Solo deriva datos ya presentes en runStore (mismo criterio que antes usaba ChatPanel para
// `activeRunId`, ahora centralizado acá para que ChatCenter/ChatHeader y ChatPanel/ChatInput lean
// lo mismo sin duplicar el Set de estados terminales).
import type { RunState } from '@saurio/shared';

export const TERMINAL_RUN_STATES = new Set<RunState>(['completed', 'cancelled', 'failed', 'interrupted']);

/** Runs no terminales de un chat: en el MVP solo puede haber uno a la vez (doc 05 §1), así que el
 *  primero que aparece alcanza. */
export function findActiveRunId(
  chatId: string | undefined,
  runChatIds: Record<string, string>,
  runStates: Record<string, RunState>,
): string | undefined {
  if (!chatId) return undefined;
  return Object.entries(runChatIds).find(
    ([runId, rChatId]) => rChatId === chatId && !TERMINAL_RUN_STATES.has(runStates[runId] as RunState),
  )?.[0];
}

const RUN_STATUS_LABEL: Record<RunState, string> = {
  created: 'En cola',
  preparing: 'En cola',
  queued: 'En cola',
  generating: 'Generando',
  parsing: 'Generando',
  awaiting_permission: 'Esperando permiso',
  executing_tool: 'Ejecutando herramienta',
  compacting: 'Compactando contexto',
  cancelling: 'Cancelando',
  completed: 'Completado',
  cancelled: 'Cancelado',
  failed: 'Error',
  interrupted: 'Interrumpido',
};

/** `undefined` (sin run activo ni terminado todavía visible) se pinta como "Listo" — el chat existe
 *  pero no hay nada corriendo. */
export function runStatusLabel(state: RunState | undefined): string {
  return state ? RUN_STATUS_LABEL[state] : 'Listo';
}

export type RunStatusVisual = 'idle' | 'queued' | 'active' | 'waiting' | 'done' | 'error';

export function runStatusVisual(state: RunState | undefined): RunStatusVisual {
  if (!state) return 'idle';
  if (state === 'created' || state === 'preparing' || state === 'queued') return 'queued';
  if (state === 'awaiting_permission') return 'waiting';
  if (state === 'failed') return 'error';
  if (TERMINAL_RUN_STATES.has(state)) return 'done';
  return 'active';
}
