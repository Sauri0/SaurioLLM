// Clasificación de errores OpenAI-compatible a ProviderErrorCode —
// packages/runtime/src/gateway/providers/openai-compat/errors.ts.
// A diferencia de Ollama (heurística de texto, sin códigos estables), la API pública de OpenAI SÍ
// documenta `error.type` de forma estable (authentication_error, not_found_error, rate_limit_error,
// etc. [VERIFICADO EN DOC OFICIAL: platform.openai.com/docs/guides/error-codes]); los servidores
// compatibles (LM Studio, llama.cpp, vLLM) no siempre lo replican, así que el status HTTP sigue
// siendo la señal primaria y `error.type` es el refuerzo cuando está presente.
import type { ProviderErrorCode } from '../../types.js';

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function classifyFetchError(err: unknown): ProviderErrorCode {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes('econnrefused') || lower.includes('fetch failed') || lower.includes('failed to fetch')) {
    return 'connection_refused';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  return 'unknown';
}

/** Status HTTP documentados por la tarea: 401/403 clave inválida, 404 modelo, 429 rate limit
 *  (con `Retry-After`), 5xx servidor. */
export function classifyHttpStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'invalid_api_key';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'server_busy';
  return 'unknown';
}

/** Refuerzo por `error.type` cuando el body sí lo trae (OpenAI real, OpenRouter, Groq); servidores
 *  locales (LM Studio/llama.cpp) suelen omitirlo y quedan cubiertos por `classifyHttpStatus`. */
export function classifyErrorType(type: string | undefined): ProviderErrorCode {
  if (type === undefined) return 'unknown';
  if (type.includes('authentication') || type.includes('permission')) return 'invalid_api_key';
  if (type.includes('not_found')) return 'model_not_found';
  if (type.includes('rate_limit')) return 'server_busy';
  return 'unknown';
}

/** Nunca se loguea ni se propaga la clave real en un mensaje de error (regla de seguridad de la
 *  tarea): si el `secret` resuelto aparece literalmente en el texto (por ejemplo, un servidor mal
 *  configurado que hace eco del header Authorization en el body de error), se reemplaza. */
export function redact(message: string, secret: string | undefined): string {
  if (secret === undefined || secret.length < 4) return message;
  return message.split(secret).join('[REDACTED]');
}
