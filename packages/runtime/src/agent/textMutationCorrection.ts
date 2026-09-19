export interface TextMutationCorrection {
  path: string;
}

function extractRelativePaths(text: string): string[] {
  const matches = text.matchAll(/(?:^|[\s"'`(])((?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+)(?=$|[\s"'`),:;!?])/g);
  const unique = new Map<string, string>();
  for (const match of matches) {
    const path = match[1]!;
    if (path.split(/[\\/]/).includes('..')) continue;
    unique.set(path.replaceAll('\\', '/').toLowerCase(), path);
  }
  return [...unique.values()];
}

/**
 * Detecta dos rechazos estrechos del primer turno de un modelo con tools por texto:
 * - pedirle al usuario el contenido/confirmación de la única ruta que pidió modificar;
 * - prometer literalmente que primero leerá el contenido de esa misma ruta, sin emitir la tool.
 *
 * El pedido del usuario conserva un gate intencionalmente estricto. Ante negación, condición,
 * ejemplo, cita, pregunta explicativa o más de una ruta, no propone ninguna corrección.
 */
export function textMutationCorrectionFor(
  userText: string,
  assistantText: string,
): TextMutationCorrection | undefined {
  const userPaths = extractRelativePaths(userText);
  if (userPaths.length !== 1) return undefined;

  const excludedUserIntent = /(?:c[oó]mo|how|por\s+qu[eé]|why|explic|describ|ejemplo|example|cita|quote|propon|suger)/i;
  if (excludedUserIntent.test(userText)) return undefined;
  const conditionalOrDeferred = /(?:\bsolo\s+si\b|\bsi\s+(?:te|yo|me)\b|\bcuando\b|\bdespu[eé]s\b|\bhasta\s+que\b|\btodav[ií]a\b|\bno\s+lo\s+hagas\b|\bonly\s+if\b|\bif\s+i\b|\bafter\b|\buntil\b|\bdo\s+not\b|\bdon't\b)/i;
  if (conditionalOrDeferred.test(userText)) return undefined;

  const mutationIntent = /^\s*(?:(?:por\s+favor|please)\s*[,:]?\s*)?(?:(?:pod[eé]s|puedes|can\s+you)\s+)?(?:arregl[aá]|arreglar|correg[ií]|corregir|edit[aá]|editar|modific[aá]|modificar|cambi[aá]|cambiar|reemplaz[aá]|reemplazar|actualiz[aá]|actualizar|fix|edit|modify|change|replace|update)(?=\s|$|[,:;.!?])/i;
  if (!mutationIntent.test(userText)) return undefined;

  const assistantPaths = extractRelativePaths(assistantText);
  if (assistantPaths.length !== 1) return undefined;
  const normalizedUserPath = userPaths[0]!.replaceAll('\\', '/').toLowerCase();
  const normalizedAssistantPath = assistantPaths[0]!.replaceAll('\\', '/').toLowerCase();
  if (normalizedAssistantPath !== normalizedUserPath) return undefined;

  const asksForInput = /(?:proporcion|compart|copi|peg|confirm|provide|share|copy|paste)/i;
  const namesFileContent = /(?:contenido|archivo|content|file)/i;
  const asksForContent = /[?¿]/.test(assistantText)
    && asksForInput.test(assistantText)
    && namesFileContent.test(assistantText);

  const reportsNoAccess = /(?:no\s+(?:puedo|podemos|tengo acceso)|sin\s+acceso|error\s+al\s+leer|can't|cannot|no\s+access|unable\s+to\s+read)/i;
  const explainsInstead = /(?:para\s+explicar|te\s+explico|explain\s+(?:why|how)|for\s+an\s+explanation)/i;
  const promisesImmediateRead = !reportsNoAccess.test(assistantText)
    && !explainsInstead.test(assistantText)
    // El modelo real antepone a veces una cláusula breve de propósito y recién después de la coma
    // declara que necesita leer. Se admite esa frontera de cláusula, pero no texto arbitrario: los
    // gates de intención mutante, ruta única coincidente y ausencia de error siguen siendo obligatorios.
    && /(?:^|[.!?]\s+|,\s+)(?:(?:primero|first)\s*[,:]?\s*)?(?:(?:necesito|debo|tengo\s+que)\s+leer\s+(?:el\s+)?contenido\s+(?:de|del)|i\s+(?:need|have)\s+to\s+read\s+(?:the\s+)?(?:contents?\s+of\s+)?)/i.test(assistantText);

  return asksForContent || promisesImmediateRead ? { path: userPaths[0]! } : undefined;
}
