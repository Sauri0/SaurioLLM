// Handlers IPC del dominio "run" (doc 02 §1: apps/desktop/src/main/ipc/run.ts, doc 01 §6).
// Delegan uno a uno a RunController (packages/runtime/src/agent/types.ts); RunEvent[] hacia el
// renderer se emite aparte por RunEventBatcher (doc 04 RendererEvents), no desde acá.
import { ipc } from '@saurio/shared';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import { registerHandler } from './registerHandler.js';

export function registerRunHandlers(host: RuntimeHost): void {
  registerHandler('run:start', ipc['run:start'], async (input) =>
    host.runController.start(input.chatId, input.text, input.mode));

  registerHandler('run:cancel', ipc['run:cancel'], async (input) => {
    await host.runController.cancel(input.runId);
  });

  registerHandler('run:continue', ipc['run:continue'], async (input) =>
    host.runController.continueRun(input.runId, input.extraIterations));
}
