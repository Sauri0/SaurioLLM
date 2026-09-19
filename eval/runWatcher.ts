import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PermissionAnswer, RunEvent } from '@saurio/shared';

interface AwaitingToolCall {
  id: string;
  status: string;
  toolName?: string;
  args?: unknown;
}

interface EvalRuntime {
  events: {
    subscribe(listener: (event: RunEvent) => void): () => void;
    since(runId: string, seq: number): RunEvent[];
  };
  persistence: { repositories: { toolCalls: {
    listByRun(runId: string): Promise<AwaitingToolCall[]>;
  } } };
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
export const CODER_FIXTURE_TEST_SCRIPT = "node -e \"const fs=require('node:fs');const text=fs.readFileSync('src/coder.ts','utf8');if(!/return\\s+n\\s*\\*\\s*2\\s*;/.test(text))process.exit(1)\"";

function deny(toolCallId: string, reason: string): PermissionAnswer {
  return { toolCallId, answer: 'deny', reason };
}

/** Política del fixture para permisos incidentales de verificación.
 *
 * Sólo autoriza `npm test` en la raíz temporal cuando el `package.json` conserva exactamente el
 * script creado por el harness y no agregó hooks npm que también se ejecutarían. Cualquier otra
 * herramienta/comando se deniega explícitamente; un timeout nunca pasa por esta función y por lo
 * tanto nunca se convierte en una aprobación implícita.
 */
export function answerKnownFixtureTestPermission(
  toolCall: AwaitingToolCall,
  projectRoot: string,
  expectedTestScript: string,
): PermissionAnswer {
  if (toolCall.toolName !== 'run_command') {
    return deny(toolCall.id, `evaluación automática: ${toolCall.toolName ?? 'tool desconocida'} no está autorizada en este caso`);
  }
  if (!toolCall.args || typeof toolCall.args !== 'object' || Array.isArray(toolCall.args)) {
    return deny(toolCall.id, 'evaluación automática: argumentos de run_command inválidos');
  }
  const args = toolCall.args as Record<string, unknown>;
  if (args.command !== 'npm test') {
    return deny(toolCall.id, 'evaluación automática: sólo se autoriza el comando exacto npm test del fixture');
  }
  if (args.cwd !== undefined && args.cwd !== '.') {
    return deny(toolCall.id, 'evaluación automática: npm test sólo se autoriza en la raíz del fixture');
  }
  if (args.timeout !== undefined && (!Number.isInteger(args.timeout) || (args.timeout as number) < 1 || (args.timeout as number) > 120)) {
    return deny(toolCall.id, 'evaluación automática: timeout fuera del límite seguro del fixture');
  }

  const packagePath = path.join(projectRoot, 'package.json');
  if (!existsSync(packagePath)) {
    return deny(toolCall.id, 'evaluación automática: el fixture no tiene un package.json conocido');
  }
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) {
      return deny(toolCall.id, 'evaluación automática: el fixture no tiene scripts npm conocidos');
    }
    const scripts = parsed.scripts as Record<string, unknown>;
    if (scripts.test !== expectedTestScript || Object.keys(scripts).some((name) => name !== 'test')) {
      return deny(toolCall.id, 'evaluación automática: el script npm o sus hooks no coinciden con el fixture inspeccionado');
    }
  } catch {
    return deny(toolCall.id, 'evaluación automática: package.json no es legible como JSON');
  }
  return { toolCallId: toolCall.id, answer: 'allow_once', reason: 'evaluación automática: npm test coincide con el script seguro del fixture' };
}

/** Una suscripción por run, con replay y consumo. Nunca devuelve dos veces el mismo permiso. */
export async function driveThroughPermissionAsks(
  runtime: EvalRuntime,
  controller: { answerPermission(id: string, answer: PermissionAnswer): Promise<void>; cancel(runId: string): Promise<void> },
  runId: string,
  answer: (toolCallId: string, toolCall: AwaitingToolCall) => PermissionAnswer | Promise<PermissionAnswer>,
  opts: { maxRounds?: number; perRoundTimeoutMs?: number } = {},
): Promise<{ rounds: number; firstToolCallId: string | undefined; finalState: string }> {
  const queue: RunEvent[] = [];
  const seen = new Set<number>();
  let notify: (() => void) | undefined;
  const collect = (event: RunEvent) => {
    if (event.runId !== runId || seen.has(event.seq)) return;
    seen.add(event.seq);
    queue.push(event);
    notify?.();
  };
  const unsubscribe = runtime.events.subscribe(collect);
  let rounds = 0;
  let firstToolCallId: string | undefined;
  const timeoutMs = opts.perRoundTimeoutMs ?? 90_000;
  const maxRounds = opts.maxRounds ?? 5;
  try {
    // Un run rápido puede haber emitido el permiso o terminado antes de que start() retorne.
    for (const event of runtime.events.since(runId, 0)) collect(event);
    while (true) {
      if (queue.length === 0) {
        const received = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => { notify = undefined; resolve(false); }, timeoutMs);
          notify = () => { clearTimeout(timer); notify = undefined; resolve(true); };
        });
        if (!received) {
          await controller.cancel(runId);
          return { rounds, firstToolCallId, finalState: 'timeout' };
        }
      }
      const event = queue.shift()!;
      if (event.type === 'run.state' && TERMINAL.has(event.to)) {
        return { rounds, firstToolCallId, finalState: event.to };
      }
      if (event.type !== 'tool.permission') continue;
      const pending = (await runtime.persistence.repositories.toolCalls.listByRun(runId))
        .find((call) => call.id === event.request.toolCallId && call.status === 'awaiting_permission');
      if (!pending) continue;
      if (rounds >= maxRounds) {
        await controller.cancel(runId);
        return { rounds, firstToolCallId, finalState: 'permission_round_limit' };
      }
      firstToolCallId ??= pending.id;
      rounds += 1;
      await controller.answerPermission(pending.id, await answer(pending.id, pending));
    }
  } finally {
    unsubscribe();
  }
}
