/** Reglas puras de foco para overlays. Separarlas evita que un cierre de menú o diálogo robe foco
 * de un control que la persona ya eligió con el mouse o teclado. */
export function focusTrapTarget<T>(focusable: readonly T[], active: T | null, shiftKey: boolean): T | undefined {
  if (focusable.length === 0) return undefined;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (!focusable.includes(active as T)) return shiftKey ? last : first;
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return undefined;
}

export function shouldRestoreOverlayFocus<T>(
  active: T | null,
  body: T,
  containsActive: (target: T) => boolean,
): boolean {
  return active === body || (active !== null && containsActive(active));
}
