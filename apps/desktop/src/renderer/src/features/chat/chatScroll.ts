/** Margen tolerante a redondeos y al alto variable del compositor. */
export const CHAT_SCROLL_FOLLOW_THRESHOLD_PX = 48;

/**
 * Un chat sólo debe seguir los mensajes nuevos cuando la persona ya estaba leyendo el final.
 * Esto evita que `scrollIntoView` la saque de un mensaje anterior que estaba revisando.
 */
export function isNearChatScrollBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  thresholdPx = CHAT_SCROLL_FOLLOW_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}
