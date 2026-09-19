// Handlers IPC del dominio "run" (doc 02 §1: apps/desktop/src/main/ipc/run.ts, doc 01 §6).
// Delegan uno a uno a RunController (packages/runtime/src/agent/types.ts); RunEvent[] hacia el
// renderer se emite aparte por RunEventBatcher (doc 04 RendererEvents), no desde acá.
import { readFile, stat } from 'node:fs/promises';
import { ipc, type Attachment } from '@saurio/shared';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import { registerHandler } from './registerHandler.js';

// Punto 1c/9 del encargo (feedback real v0.2.1, adjuntos): "con límites de tamaño" — el proceso
// main es quien lee `path` de disco (packages/runtime no toca fs arbitrario fuera de WorkspaceFs),
// así que los límites de tamaño se aplican ACÁ, antes de que un archivo grande siquiera llegue a
// codificarse a base64 y viajar hacia RunController.
const MAX_TEXT_ATTACHMENT_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_ATTACHMENTS_PER_RUN = 10;

/** Resuelve `path` -> `dataBase64` (si no vino ya con `dataBase64`, ej. desde el portapapeles);
 *  valida el límite de tamaño según `kind`. Lanza un error accionable — nunca trunca en silencio un
 *  archivo entero sin avisar (regla 6 de la columna). */
async function resolveAttachment(att: Attachment): Promise<Attachment> {
  const limit = att.kind === 'image' ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES;
  if (att.dataBase64) {
    const sizeBytes = Buffer.byteLength(att.dataBase64, 'base64');
    if (sizeBytes > limit) {
      throw new Error(`saurio: el adjunto "${att.name}" pesa ${sizeBytes} bytes, por encima del límite de ${limit} bytes para ${att.kind === 'image' ? 'imágenes' : 'archivos de texto'}.`);
    }
    return { ...att, sizeBytes };
  }
  if (!att.path) throw new Error(`saurio: el adjunto "${att.name}" no trae ni "path" ni "dataBase64".`);
  const st = await stat(att.path);
  if (st.size > limit) {
    throw new Error(`saurio: "${att.name}" pesa ${st.size} bytes, por encima del límite de ${limit} bytes para ${att.kind === 'image' ? 'imágenes' : 'archivos de texto'}.`);
  }
  const buf = await readFile(att.path);
  return { ...att, dataBase64: buf.toString('base64'), sizeBytes: st.size };
}

async function resolveAttachments(attachments: Attachment[] | undefined): Promise<Attachment[] | undefined> {
  if (!attachments || attachments.length === 0) return undefined;
  if (attachments.length > MAX_ATTACHMENTS_PER_RUN) {
    throw new Error(`saurio: máximo ${MAX_ATTACHMENTS_PER_RUN} adjuntos por mensaje (llegaron ${attachments.length}).`);
  }
  return Promise.all(attachments.map(resolveAttachment));
}

export function registerRunHandlers(host: RuntimeHost): void {
  registerHandler('run:start', ipc['run:start'], async (input) =>
    host.runController.start(input.chatId, input.text, input.mode, await resolveAttachments(input.attachments)));

  registerHandler('run:cancel', ipc['run:cancel'], async (input) => {
    await host.runController.cancel(input.runId);
  });

  registerHandler('run:continue', ipc['run:continue'], async (input) =>
    host.runController.continueRun(input.runId, input.extraIterations));
}
