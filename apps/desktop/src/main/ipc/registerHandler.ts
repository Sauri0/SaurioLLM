// registerHandler(channel, schema, fn): valida con zod input/output y event.senderFrame (doc 02 §1,
// ADR-014 en docs/architecture/12-decisiones.md, doc 01 §5 "Seguridad de Electron").
import { ipcMain, type IpcMainInvokeEvent, type WebFrameMain } from 'electron';
import type { z } from 'zod';
import type { IpcChannel, IpcContract } from '@saurio/shared';

/**
 * Frames autorizados a invocar canales privilegiados: por ahora, solo el frame principal de cada
 * BrowserWindow registrado explícitamente. Un frame no autorizado (por ejemplo, una vista embebida de
 * terceros) nunca puede invocar un canal, aunque conozca su nombre.
 */
const allowedFrames = new Set<WebFrameMain>();

/** Observador opcional de respuestas (solo lo usa el smoke de arranque, ver ../smoke.ts). No forma
 *  parte del contrato de doc 04: en una ejecución normal queda en `undefined` y no se invoca. */
let responseObserver: ((channel: string, output: unknown) => void) | undefined;

export function observeResponses(observer: (channel: string, output: unknown) => void): void {
  responseObserver = observer;
}

export function allowFrame(frame: WebFrameMain): void {
  allowedFrames.add(frame);
}

function isAllowedFrame(frame: WebFrameMain | null): boolean {
  return frame !== null && allowedFrames.has(frame);
}

/**
 * Registra un handler IPC para `channel`, validando el payload de entrada contra `ipcContract[channel].input`
 * y el `event.senderFrame` contra `allowedFrames`. `fn` recibe el input ya tipado y debe devolver algo
 * compatible con `ipcContract[channel].output` (no se revalida la salida en runtime por costo; el tipo
 * de retorno de `fn` ya está acotado por el genérico `C`).
 */
export function registerHandler<C extends IpcChannel>(
  channel: C,
  contract: IpcContract[C],
  fn: (input: z.infer<IpcContract[C]['input']>, event: IpcMainInvokeEvent) => Promise<z.infer<IpcContract[C]['output']>> | z.infer<IpcContract[C]['output']>,
): void {
  ipcMain.handle(channel, async (event, rawPayload: unknown) => {
    if (process.env['SAURIO_SMOKE'] === '1') {
      console.log('[main][smoke] ipcMain.handle invocado', channel, JSON.stringify(rawPayload));
    }
    if (!isAllowedFrame(event.senderFrame)) {
      throw new Error(`saurio: frame no autorizado para invocar el canal "${channel}"`);
    }
    // TypeScript no correlaciona bien input/output de un mapa genérico channel -> {input, output}
    // dentro del cuerpo de una función genérica (limitación conocida de generic indexed access); el
    // cast es un detalle de implementación interno, la firma pública de registerHandler sigue exigiendo
    // el par input/output correcto a quien la llama.
    const input = contract.input.parse(rawPayload) as Parameters<typeof fn>[0];
    const output = await fn(input, event);
    responseObserver?.(channel, output);
    return output;
  });
}
