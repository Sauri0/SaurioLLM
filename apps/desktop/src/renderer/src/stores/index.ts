// Slices de zustand por dominio: projectStore, chatStore, runStore, modelsStore, perfStore, terminalStore
// (doc 02 §1: apps/desktop/src/renderer/src/stores/, ADR-013; doc 01 §4.1).
import { onEvent } from '../ipc/client.js';
import { useRunStore } from './runStore.js';
import { useModelsStore } from './modelsStore.js';
import { usePerfStore } from './perfStore.js';

export * from './projectStore.js';
export * from './chatStore.js';
export * from './runStore.js';
export * from './modelsStore.js';
export * from './perfStore.js';
export * from './terminalStore.js';

let wired = false;

/** Conecta los tres eventos `main -> renderer` del MVP (doc 01 §6: `runtime:event`, `models:changed`,
 *  `metrics:tick`; `provider:health` y `download:*` no tienen store propio en este módulo — ver
 *  deviations) a sus stores. Se llama una sola vez, típicamente desde el layout raíz (otro agente,
 *  doc 04: "Exportá componentes para que el layout monte"); es idempotente. */
export function wireIpcEvents(): () => void {
  if (wired) {
    return () => {};
  }
  wired = true;
  const offRuntime = onEvent('runtime:event', (events) => {
    useRunStore.getState().applyEvents(events);
  });
  useModelsStore.getState().subscribe();
  usePerfStore.getState().subscribe();
  return () => {
    offRuntime();
    wired = false;
  };
}
