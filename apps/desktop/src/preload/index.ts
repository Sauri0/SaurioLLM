// Único archivo del preload: contextBridge.exposeInMainWorld con invoke(), onEvent() y
// onTerminalPort() (doc 02 §1, doc 04 §16 PreloadApi). Nunca expone ipcRenderer crudo (doc 01 §5
// "Seguridad de Electron"). Implementa exactamente `PreloadApi` de packages/shared/src/ipc.ts.
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcChannel, IpcInput, IpcOutput, MessagePortLike, PreloadApi, RendererEvents } from '@saurio/shared';

function invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutput<C>> {
  return ipcRenderer.invoke(channel, input) as Promise<IpcOutput<C>>;
}

/** Cada evento main->renderer viaja por su propio canal de `webContents.send` (doc 04 §16,
 *  RendererEvents); `channel` acá es literalmente el nombre de ese canal de ipcRenderer. */
function onEvent<E extends keyof RendererEvents>(channel: E, cb: (payload: RendererEvents[E]) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: RendererEvents[E]): void => cb(payload);
  ipcRenderer.on(channel as string, listener);
  return () => ipcRenderer.removeListener(channel as string, listener);
}

/** doc 04 §16, Desvíos §5: un MessagePort no puede devolverse como valor de retorno síncrono de
 *  contextBridge; main lo transfiere con `webContents.postMessage('terminal:port', { terminalId },
 *  [port1])` y acá se reexpone vía `event.ports[0]`. */
function onTerminalPort(cb: (terminalId: string, port: MessagePortLike) => void): () => void {
  const listener = (event: Electron.IpcRendererEvent, payload: { terminalId: string }): void => {
    const port = event.ports[0];
    if (!port) {
      console.error('[preload] terminal:port llegó sin MessagePort adjunto');
      return;
    }
    port.start();
    cb(payload.terminalId, port);
  };
  ipcRenderer.on('terminal:port', listener);
  return () => ipcRenderer.removeListener('terminal:port', listener);
}

const api: PreloadApi = { invoke, onEvent, onTerminalPort };

contextBridge.exposeInMainWorld('saurio', api);
