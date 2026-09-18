// Handlers IPC del dominio "bench" (doc 02 §1: apps/desktop/src/main/ipc/bench.ts, doc 01 §6).
// v0.3 (Benchmark, doc 04 §16: "sin handler activo hasta v0.2/v0.3" — principio 8): se registran
// tipados contra el contrato, pero tiran NotImplementedYetError hasta esa fase.
import { ipc } from '@saurio/shared';
import { NotImplementedYetError } from '../host/RuntimeHost.js';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import { registerHandler } from './registerHandler.js';

export function registerBenchHandlers(_host: RuntimeHost): void {
  registerHandler('bench:run', ipc['bench:run'], async () => {
    throw new NotImplementedYetError('bench:run', 'v0.3');
  });
  registerHandler('bench:cancel', ipc['bench:cancel'], async () => {
    throw new NotImplementedYetError('bench:cancel', 'v0.3');
  });
  registerHandler('bench:list', ipc['bench:list'], async () => {
    throw new NotImplementedYetError('bench:list', 'v0.3');
  });
}
