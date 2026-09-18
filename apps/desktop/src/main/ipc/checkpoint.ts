// Handlers IPC del dominio "checkpoint" (doc 02 §1: apps/desktop/src/main/ipc/checkpoint.ts, doc 01 §6).
import { ipc } from '@saurio/shared';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import { registerHandler } from './registerHandler.js';

export function registerCheckpointHandlers(host: RuntimeHost): void {
  registerHandler('checkpoint:list', ipc['checkpoint:list'], async (input) =>
    host.checkpointRepository.listByChat(input.chatId));

  registerHandler('checkpoint:diff', ipc['checkpoint:diff'], async (input) =>
    host.checkpointService.diff(input.checkpointId, input.relPath));

  registerHandler('checkpoint:planRevert', ipc['checkpoint:planRevert'], async (input) =>
    host.checkpointService.planRevert(input.checkpointIds));

  registerHandler('checkpoint:revert', ipc['checkpoint:revert'], async (input) =>
    host.checkpointService.revert(input.checkpointIds, input.resolution));
}
