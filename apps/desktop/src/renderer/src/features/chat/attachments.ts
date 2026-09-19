// Adjuntos del compositor (rediseño del chat, punto 1: "botón adjuntar -- archivos e imágenes,
// también pegar imagen y arrastrar y soltar -- con chips removibles"). Lee el archivo como base64
// en el propio renderer (FileReader) — sin tocar preload/main (fuera de mi zona), y sin depender de
// `File.path` (Electron 32+ ya no lo expone en el renderer por seguridad).
// apps/desktop/src/renderer/src/features/chat/attachments.ts.
import type { Attachment } from '@saurio/shared';

/** Tope de tamaño para adjuntar inline como base64 — un archivo más grande igual se puede adjuntar
 *  (no hay límite duro en `AttachmentSchema`), pero acá se avisa antes en vez de trabar la UI
 *  serializando algo enorme a base64 en el hilo principal del renderer. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

export function formatAttachmentSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer el archivo'));
    reader.readAsDataURL(file);
  });
}

/** `dataUrl` viene como `data:<mime>;base64,<datos>` — `AttachmentSchema.dataBase64` es solo la
 *  parte de datos, sin el prefijo. */
function stripDataUrlPrefix(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',');
  return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

export async function fileToAttachment(file: File): Promise<Attachment> {
  const dataUrl = await readAsDataUrl(file);
  return {
    kind: file.type.startsWith('image/') ? 'image' : 'file',
    name: file.name,
    mime: file.type || 'application/octet-stream',
    dataBase64: stripDataUrlPrefix(dataUrl),
    sizeBytes: file.size,
  };
}
