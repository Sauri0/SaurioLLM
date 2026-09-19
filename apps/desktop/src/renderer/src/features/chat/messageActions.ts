import type { ChatMessage } from '@saurio/shared';

/**
 * Sólo las respuestas ya cerradas y con procedencia persistida pueden regenerarse. Mientras haya
 * un run vivo en el chat, el backend también rechaza empezar otro y la acción queda deshabilitada.
 */
export function regenerateRunIdForMessage(
  message: ChatMessage,
  streaming: boolean | undefined,
): string | undefined {
  return message.role === 'assistant' && !streaming ? message.originRunId : undefined;
}
