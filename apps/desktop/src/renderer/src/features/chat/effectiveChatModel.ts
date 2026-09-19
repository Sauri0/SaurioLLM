import type { Chat, ChatMessage, ModelInfo, ModelRef } from '@saurio/shared';

/**
 * El modelo persistido representa una elección explícita. En modo automático, el único modelo
 * efectivo que la UI puede afirmar es el registrado por el último mensaje del asistente.
 */
export function displayedModelForChat(
  chat: Chat | undefined,
  messages: readonly ChatMessage[],
): ModelRef | undefined {
  if (!chat || chat.modelSelection !== 'auto') return chat?.modelRef;
  return [...messages].reverse().find((message) => message.role === 'assistant' && message.modelRef)?.modelRef;
}

/** La identidad de un modelo incluye proveedor y nombre; dos providers pueden publicar el mismo tag. */
export function isModelInstalled(modelRef: ModelRef, installedModels: readonly ModelInfo[]): boolean {
  return installedModels.some((model) => (
    model.ref.providerId === modelRef.providerId && model.ref.name === modelRef.name
  ));
}
