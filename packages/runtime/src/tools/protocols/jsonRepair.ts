// Parser JSON tolerante de segundo intento — packages/runtime/src/tools/protocols/jsonRepair.ts.
// Define: doc 05 §2.5 paso 20 bis ("tolerant parse... antes de la validación zod") y doc de
// investigación research-small-models.md §2.3 ("fences ```json```, comillas simples, coma final,
// arguments como string doblemente codificado, tag <tool_call> sin cerrar, texto narrativo antes del
// bloque"). Primer intento siempre es JSON.parse estricto (en el caller); esto es el segundo intento.
export interface RepairResult {
  value: unknown;
  repaired: boolean;
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

function stripFences(s: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(s.trim());
  return m ? (m[1] ?? '') : s;
}

function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, '$1');
}

function singleToDoubleQuotes(s: string): string {
  // Heurística: reemplaza comillas simples que delimitan claves/valores por dobles, sin tocar
  // apóstrofos dentro de contenido ya entre comillas dobles. No es un parser real; es best-effort.
  let out = '';
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== '\\') inDouble = !inDouble;
    if (c === "'" && !inDouble) { out += '"'; continue; }
    out += c;
  }
  return out;
}

function balanceBrackets(s: string): string {
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  return s + stack.reverse().join('');
}

/** Intenta reparar `raw` para que sea JSON válido, probando transformaciones en cascada.
 *  Devuelve el primer resultado que parsea, o lanza si ninguna transformación funciona. */
export function repairJson(raw: string): RepairResult {
  const strict = tryParse(raw);
  if (strict.ok) return { value: strict.value, repaired: false };

  const attempts: ((s: string) => string)[] = [
    (s) => stripFences(s),
    (s) => stripTrailingCommas(stripFences(s)),
    (s) => singleToDoubleQuotes(stripTrailingCommas(stripFences(s))),
    (s) => balanceBrackets(stripTrailingCommas(stripFences(s))),
    (s) => balanceBrackets(singleToDoubleQuotes(stripTrailingCommas(stripFences(s)))),
  ];
  for (const transform of attempts) {
    const attempt = tryParse(transform(raw));
    if (attempt.ok) return { value: attempt.value, repaired: true };
  }
  throw new Error(`no se pudo reparar JSON: ${raw.slice(0, 200)}`);
}

/** `arguments` puede venir doblemente codificado (string JSON dentro del string JSON). */
export function unwrapDoubleEncodedArguments(args: unknown): unknown {
  if (typeof args === 'string') {
    const attempt = tryParse(args);
    if (attempt.ok) return attempt.value;
    try {
      return repairJson(args).value;
    } catch {
      return args;
    }
  }
  return args;
}
