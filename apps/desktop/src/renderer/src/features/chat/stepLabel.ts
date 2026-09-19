// Etiquetas de una sola línea para cada paso/turno del bloque "Actividad" (rediseño del chat) —
// referencia exacta pedida: la línea plegada de Claude Code ("Ejecutó un comando, usó 2
// herramientas...") y cada fila del detalle es texto tenue de una sola línea, sin tarjetas grandes.
// apps/desktop/src/renderer/src/features/chat/stepLabel.ts.
import type { ToolCallRecord } from '@saurio/shared';
import type { TurnCounts } from './activityGrouping.js';

function firstArgString(args: unknown, keys: string[]): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Verbo según el estado, para que la fila diga "Leyendo" mientras corre y "Leyó" cuando terminó
 *  (mismo patrón que ya usaba `run.activity` en el runtime para su propia línea). */
function verb(status: ToolCallRecord['status'], presentContinuous: string, past: string): string {
  if (status === 'running' || status === 'pending') return presentContinuous;
  return past;
}

/** Línea de UNA tool call para la lista de detalle del bloque "Actividad" — nunca más de una línea,
 *  el detalle completo (args/salida) vive en el `<details>` de esa fila, no acá. */
export function toolStepLabel(call: ToolCallRecord): string {
  const path = firstArgString(call.args, ['path', 'relPath', 'file', 'filePath']);
  const query = firstArgString(call.args, ['query', 'pattern', 'q']);
  const command = firstArgString(call.args, ['command', 'cmd']);

  if (call.status === 'awaiting_permission') return `Esperando tu permiso: ${call.toolName}`;
  if (call.status === 'denied') return `Denegado: ${call.toolName}`;
  if (call.status === 'failed') return `Falló: ${call.toolName}`;
  if (call.status === 'cancelled') return `Cancelado: ${call.toolName}`;

  switch (call.category) {
    case 'read':
      if (query) return `${verb(call.status, 'Buscando', 'Buscó')} "${truncate(query, 60)}"`;
      return `${verb(call.status, 'Leyendo', 'Leyó')} ${path ? truncate(path, 70) : call.toolName}`;
    case 'terminal':
      return `${verb(call.status, 'Ejecutando', 'Ejecutó')}: ${command ? truncate(command, 70) : call.toolName}`;
    case 'write':
      return `${verb(call.status, 'Editando', 'Editó')} ${path ? truncate(path, 70) : call.toolName}`;
    case 'delete':
      return `${verb(call.status, 'Borrando', 'Borró')} ${path ? truncate(path, 70) : call.toolName}`;
    case 'git_commit':
      return verb(call.status, 'Haciendo commit', 'Hizo commit');
    case 'git_push':
      return verb(call.status, 'Haciendo push', 'Hizo push');
    case 'delegate':
      return verb(call.status, 'Delegando tarea', 'Delegó una tarea');
    case 'network':
      return `${verb(call.status, 'Llamando a', 'Llamó a')} ${call.toolName}`;
    case 'mcp':
      return `${verb(call.status, 'Usando', 'Usó')} ${call.toolName}`;
    default:
      return call.toolName;
  }
}

/** Resumen plegado de un turno ya terminado — formato pedido textualmente por el encargo:
 *  "Trabajó 14 s · 3 lecturas · 1 comando · 2 archivos editados". Sin partes en cero. */
export function turnSummaryLabel(counts: TurnCounts, elapsedMs: number | undefined): string {
  const parts: string[] = [];
  if (elapsedMs !== undefined) {
    const seconds = Math.max(1, Math.round(elapsedMs / 1000));
    parts.push(`Trabajó ${seconds} s`);
  } else {
    parts.push('Trabajó');
  }
  if (counts.reads > 0) parts.push(`${counts.reads} lectura${counts.reads === 1 ? '' : 's'}`);
  if (counts.commands > 0) parts.push(`${counts.commands} comando${counts.commands === 1 ? '' : 's'}`);
  if (counts.edits > 0) parts.push(`${counts.edits} archivo${counts.edits === 1 ? '' : 's'} editado${counts.edits === 1 ? '' : 's'}`);
  if (counts.other > 0) parts.push(`${counts.other} herramienta${counts.other === 1 ? '' : 's'}`);
  if (parts.length === 1 && counts.usedThinking) return `${parts[0]} · pensó antes de responder`;
  return parts.join(' · ');
}
