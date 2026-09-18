// recover(): reclasificación de runs/tool_calls al arrancar la app — packages/runtime/src/agent/recover.ts.
// Define: doc 05 §1 (nota sobre awaiting_permission) y doc 10 §5 (recuperación al iniciar). Corre una
// sola vez en el bootstrap (fuera de este módulo: ese orden vive en main/index.ts). Principios (doc 10
// §1): nunca perder trabajo, nunca repetir sola una acción peligrosa, mostrar siempre el estado real.
//
// Fuera de alcance de este módulo (doc 10 §5.0, §5.7): `app.requestSingleInstanceLock()` y la limpieza
// de pids de `run_command` viven en el bootstrap de Electron (`main/index.ts`), no en `@saurio/runtime`.
// `owner_session_id`/`heartbeat_at` se persisten (ver ports.ts `RunRecord`) pero este `recover()` asume
// que es el único proceso activo sobre la base — la columna vertebral pone esa garantía en el bootstrap.
import type { RunState, ToolCallStatus } from '@saurio/shared';
import type { ChatMessage } from '@saurio/shared';
import type { ToolCallRecord } from './types.js';
import type { EventStore } from '../persistence/types.js';
import type { ToolCallRepository, MessageRepository, CheckpointRepository } from '../persistence/types.js';
import type { RunRepository, OrphanDiagnostics, Clock } from './ports.js';
import { RunStateMachine } from './RunStateMachine.js';

/** Las tres tools de archivo mutantes (doc 04 §4, BuiltinToolName); son las únicas para las que el
 *  diagnóstico por hash de doc 10 §5.4 tiene sentido — `run_command` no deja hash comparable. */
const FILE_TOOLS = new Set(['edit_file', 'write_file', 'delete_file']);

const SYNTHETIC_INTERRUPTED_TEXT =
  'interrumpido: esta herramienta no se ejecutó o no se sabe si terminó; verificá el estado antes de repetirla';

export interface RecoverDeps {
  runs: RunRepository;
  toolCalls: ToolCallRepository;
  messages: MessageRepository;
  checkpoints?: CheckpointRepository;
  events: EventStore;
  diagnostics?: OrphanDiagnostics;
  clock: Clock;
}

export interface RecoverResult { orphaned: ToolCallRecord[]; abandoned: ToolCallRecord[] }

/** Construye el mensaje sintético de doc 10 §5.6, para que `run:continue` siempre herede un historial
 *  bien formado (todo `assistant` con `tool_calls` tiene su `tool` de respuesta). */
export function synthesizeInterruptedResultMessage(call: ToolCallRecord, idSuffix: string): ChatMessage {
  if (call.transport === 'native') {
    return {
      id: `msg_${call.id}_${idSuffix}`,
      role: 'tool',
      content: SYNTHETIC_INTERRUPTED_TEXT,
      toolCallId: call.id,
      toolName: call.toolName,
    };
  }
  return {
    id: `msg_${call.id}_${idSuffix}`,
    role: 'user',
    content: `<tool_result name="${call.toolName}">${SYNTHETIC_INTERRUPTED_TEXT}</tool_result>`,
  };
}

export async function recover(deps: RecoverDeps): Promise<RecoverResult> {
  const stateMachine = new RunStateMachine();
  const activeRuns = await deps.runs.listActive();
  const openCalls = await deps.toolCalls.listOpenAtStartup();

  const allOrphaned: ToolCallRecord[] = [];
  const allAbandoned: ToolCallRecord[] = [];

  for (const run of activeRuns) {
    // doc 05 §1, nota: awaiting_permission es el único estado activo que sobrevive intacto.
    if (run.state === 'awaiting_permission') continue;

    const callsForRun = openCalls.filter((c) => c.runId === run.id);
    const orphanedForRun: ToolCallRecord[] = [];
    const abandonedForRun: ToolCallRecord[] = [];

    for (const call of callsForRun) {
      if (call.status === 'running') {
        const diagnosis = FILE_TOOLS.has(call.toolName)
          ? await diagnoseFileTool(deps, call)
          : { code: 'unknown' as const, message: describeNonFileOrphan(call) };
        const updated: ToolCallRecord = {
          ...call,
          status: 'orphaned' as ToolCallStatus,
          finishedAt: deps.clock.now(),
          resultPreview: diagnosis.message,
        };
        await deps.toolCalls.upsert(updated);
        orphanedForRun.push(updated);
      } else if (call.status === 'pending' || call.status === 'approved' || call.status === 'awaiting_permission') {
        const updated: ToolCallRecord = {
          ...call,
          status: 'abandoned' as ToolCallStatus,
          finishedAt: deps.clock.now(),
        };
        await deps.toolCalls.upsert(updated);
        abandonedForRun.push(updated);
      }
    }

    // doc 10 §5.6: mensaje `tool` sintético para que run:continue herede un historial bien formado.
    for (const call of [...orphanedForRun, ...abandonedForRun]) {
      await deps.messages.append(run.chatId, synthesizeInterruptedResultMessage(call, 'recovered'));
      deps.events.append({
        runId: run.id, chatId: run.chatId, ts: deps.clock.now(),
        type: 'tool.status', toolCallId: call.id, status: call.status,
        resultPreview: call.resultPreview,
      });
    }

    const from: RunState = run.state;
    stateMachine.assert(from, 'interrupted', { allowRecoverOnly: true });
    deps.events.append({ runId: run.id, chatId: run.chatId, ts: deps.clock.now(), type: 'run.state', from, to: 'interrupted' });
    deps.events.append({
      runId: run.id, chatId: run.chatId, ts: deps.clock.now(),
      type: 'run.recovered', orphaned: orphanedForRun, abandoned: abandonedForRun,
    });
    await deps.runs.update(run.id, { state: 'interrupted', lastEventSeq: deps.events.lastSeq(run.id) });

    allOrphaned.push(...orphanedForRun);
    allAbandoned.push(...abandonedForRun);
  }

  return { orphaned: allOrphaned, abandoned: allAbandoned };
}

function describeNonFileOrphan(call: ToolCallRecord): string {
  return `"${call.toolName}" quedó corriendo cuando la app se cerró; salida parcial no disponible sin retomar el proceso.`;
}

async function diagnoseFileTool(deps: RecoverDeps, call: ToolCallRecord): Promise<{ code: string; message: string }> {
  if (!deps.diagnostics) {
    return { code: 'unknown', message: 'Estado distinto a ambos (¿editado después?): sin diagnóstico por hash disponible.' };
  }
  const checkpoint = call.checkpointId && deps.checkpoints ? await deps.checkpoints.get(call.checkpointId) : undefined;
  const diagnosis = await deps.diagnostics.diagnose(call, checkpoint);
  return diagnosis;
}
