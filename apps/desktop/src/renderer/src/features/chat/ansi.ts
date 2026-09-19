// Elimina secuencias de escape ANSI (colores, cursor, etc.) de la salida de comandos antes de
// mostrarla en las tarjetas — queja real v0.2.1: "salida de comandos con códigos ANSI" (`[32m`,
// `[0m`, etc. crudos en pantalla en vez de una salida legible). apps/desktop/src/renderer/src/
// features/chat/ansi.ts.
//
// Patrón equivalente al del paquete `ansi-regex` (MIT, Sindre Sorhus) — no se agrega como dependencia
// nueva (esta tarea es "sin librerías nuevas") porque es una única expresión regular chica y estable.
const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z0-9]{1,2}(?:;[a-zA-Z0-9]{0,2})*)?\\u0007)',
    '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  ].join(''),
  'g',
);

/** `undefined`/`''` pasan igual (conveniencia para llamar sin chequear antes). */
export function stripAnsi(text: string | undefined): string | undefined {
  if (!text) return text;
  return text.replace(ANSI_PATTERN, '');
}
