// Agent Runtime: hash determinístico de argumentos de tool calls — packages/runtime/src/agent/hash.ts.
// Define: doc 10 §3 ("args_hash, un hash determinístico de los argumentos"). No depende de `crypto`
// para mantener el módulo Node-puro y liviano: FNV-1a de 32 bits alcanza para des-duplicar dentro de
// una ventana de 20 eventos (LoopDetector) y para el aviso "ya intentaste esto antes" — no es un
// requisito de seguridad criptográfica.

/** Serializa `value` con claves ordenadas para que el mismo objeto lógico siempre produzca el mismo
 *  string, sin importar el orden de inserción de sus propiedades. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortKeysDeep(v);
    return out;
  }
  return value;
}

/** FNV-1a de 32 bits, devuelto en hex (8 caracteres). */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function hashArgs(toolName: string, args: unknown): string {
  return fnv1a(`${toolName}:${stableStringify(args)}`);
}

export function hashText(text: string): string {
  return fnv1a(text);
}
