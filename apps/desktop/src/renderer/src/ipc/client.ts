// Cliente IPC tipado del renderer — apps/desktop/src/renderer/src/ipc/client.ts.
// Define: doc 04 §16 (contrato + `PreloadApi`) + doc 01 §4.1 ("Salidas: invoke(channel, payload)...
// Entradas: RunEvent[] batched por runtime:event, models:changed, metrics:tick, download:progress,
// provider:health"). invoke() valida input/output contra el mismo contrato zod que main (ADR-014);
// onEvent() reenvía al `onEvent(channel, cb)` del preload (un canal de ipcRenderer por evento).
//
// Integración: la declaración global de `window.saurio` ahora es exactamente `PreloadApi`
// (packages/shared/src/ipc.ts), que es lo que apps/desktop/src/preload/index.ts expone de verdad.
// Antes declaraba una forma más vieja del scaffolding (`onEvent(cb)` de un solo argumento y
// `terminalPort(): never`) que compilaba pero no coincidía con el preload en runtime.
import { ipcContract, type IpcChannel, type IpcInput, type IpcOutput, type MessagePortLike, type PreloadApi, type RendererEvents } from '@saurio/shared';

declare global {
  interface Window {
    saurio: PreloadApi;
  }
}

/** invoke tipado: valida input y output contra el mismo contrato zod que usa `main` (ADR-014). */
export async function invoke<C extends IpcChannel>(
  channel: C,
  input: IpcInput<C>,
): Promise<IpcOutput<C>> {
  const contract = ipcContract[channel];
  const validInput = contract.input.parse(input) as IpcInput<C>;
  const rawOutput = await window.saurio.invoke(channel, validInput);
  return contract.output.parse(rawOutput) as IpcOutput<C>;
}

/** onEvent tipado sobre `PreloadApi.onEvent`. No se valida con zod porque `RendererEvents` no tiene
 *  schema zod propio en packages/shared (solo tipos TS derivados de domain/events) — confiamos en
 *  que `main` ya validó antes de emitir. */
export function onEvent<E extends keyof RendererEvents>(
  channel: E,
  cb: (payload: RendererEvents[E]) => void,
): () => void {
  return window.saurio.onEvent(channel, cb);
}

/** Punto 5 del encargo / doc 16 §11 Desvíos 5 (ya resuelto): `window.saurio` es exactamente
 *  `PreloadApi`, así que `onTerminalPort` no es un stub — se reexpone tipado acá en vez de que cada
 *  feature caiga a `layout/ipcRaw.ts` (que existía solo mientras el preload no coincidía con el
 *  contrato). */
export function onTerminalPort(cb: (terminalId: string, port: MessagePortLike) => void): () => void {
  return window.saurio.onTerminalPort(cb);
}
