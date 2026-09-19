export interface ClipboardWriter {
  writeText: (text: string) => Promise<void>;
}

export type MessageCopyResult =
  | { ok: true }
  | { ok: false; message: string };

/** Mantiene el fallo de portapapeles en la UI, en vez de usar una alerta del navegador. */
export async function copyMessageText(text: string, clipboard: ClipboardWriter | undefined): Promise<MessageCopyResult> {
  if (!clipboard) return { ok: false, message: 'El portapapeles no está disponible en esta ventana.' };

  try {
    await clipboard.writeText(text);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error && error.message.trim()
        ? error.message
        : 'No se pudo acceder al portapapeles.',
    };
  }
}
