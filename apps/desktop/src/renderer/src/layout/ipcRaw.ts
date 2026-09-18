// Acceso IPC "crudo" para lo que el contrato tipado de packages/shared/src/ipc.ts todavía no
// cubre (doc 04 §16 lista los canales invoke del MVP; `files:tree`, el árbol de archivos del
// proyecto que pide doc 01 §4.1/doc 02 §1 "features/files/", no está entre ellos — ver deviations
// de este módulo). apps/desktop/src/renderer/src/layout/ipcRaw.ts.
//
// `apps/desktop/src/renderer/src/ipc/client.ts` (no es un directorio de esta tarea) declara
// `window.saurio` con la forma mínima del smoke test del scaffolding (`invoke`, `onEvent`,
// `terminalPort(): never`), más vieja que `PreloadApi` de packages/shared/src/ipc.ts (que ya
// define `onTerminalPort`). Para no reabrir esa declaración global (rompería la fusión de
// interfaces de TypeScript si el shape no calza exacto) este módulo NO se mete con `declare global`:
// castea `window.saurio` localmente a la forma mínima que cada función necesita.

/** Invoca un canal IPC sin pasar por el contrato zod de `ipcContract` (para canales que ese
 *  contrato todavía no declara). El preload real de `apps/desktop/src/main/preload` sigue
 *  validando/serializando como corresponda; acá solo se evita el `parse()` de un schema que no
 *  existe todavía para este canal. */
export async function invokeRaw(channel: string, payload: unknown): Promise<unknown> {
  const bridge = (window as unknown as { saurio?: { invoke(c: string, p: unknown): Promise<unknown> } }).saurio;
  if (!bridge) throw new Error(`saurio: preload bridge no disponible (canal "${channel}")`);
  return bridge.invoke(channel, payload);
}

/** MessagePort mínimo (doc 04 §16 `MessagePortLike`, sin depender de packages/shared para no
 *  arrastrar su tsconfig "sin DOM"). */
export interface RawMessagePort {
  postMessage(message: unknown, transfer?: unknown[]): void;
  start(): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Se suscribe al puerto de la terminal (doc 04 §16: `terminal:create` da `{ terminalId }`; el
 *  puerto real llega después por `postMessage` desde main, reexpuesto acá como `onTerminalPort`).
 *  `ipc/client.ts` todavía no implementa esto (`terminalPort(): never`) — se deja tipado a la
 *  espera de esa pieza (missingDeps de este módulo). Devuelve `undefined` si el preload actual no
 *  expone `onTerminalPort` todavía, para que el feature degrade con un aviso en vez de romper. */
export function onTerminalPort(cb: (terminalId: string, port: RawMessagePort) => void): (() => void) | undefined {
  const bridge = (window as unknown as {
    saurio?: { onTerminalPort?: (fn: (terminalId: string, port: RawMessagePort) => void) => () => void };
  }).saurio;
  return bridge?.onTerminalPort?.(cb);
}
