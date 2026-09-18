// Clasificación de errores de Anthropic a ProviderErrorCode —
// packages/runtime/src/gateway/providers/anthropic/errors.ts.
// Anthropic documenta `error.type` de forma estable para cada status HTTP [VERIFICADO EN DOC
// OFICIAL: api/messages, tabla de errores 401/403/404/429/5xx, 2026-09-18] — a diferencia de Ollama,
// acá el status HTTP y el `error.type` son ambos señales confiables (no hace falta heurística de
// substrings sobre el mensaje).
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

/** `error.type` -> ProviderErrorCode [VERIFICADO EN DOC OFICIAL: api/messages]:
 *  authentication_error/permission_error -> 401/403, not_found_error -> 404,
 *  rate_limit_error -> 429, overloaded_error -> HTTP 529 (o evento `error` a mitad de SSE). */
export function classifyErrorType(type: string | undefined): ProviderErrorCode {
  if (type === undefined) return 'unknown';
  if (type === 'authentication_error' || type === 'permission_error') return 'invalid_api_key';
  if (type === 'not_found_error') return 'model_not_found';
  if (type === 'rate_limit_error') return 'server_busy';
  if (type === 'overloaded_error') return 'server_busy';
  return 'unknown';
}

/** Status HTTP documentados por la tarea: 401/403 clave inválida, 404 modelo/recurso, 429 rate
 *  limit (con `Retry-After`), 529 overloaded (variante propia de Anthropic para "capacidad
 *  saturada", tratado igual que server_busy), 5xx genérico servidor. */
export function classifyHttpStatus(status: number, errorType?: string): ProviderErrorCode {
  if (status === 401 || status === 403) return 'invalid_api_key';
  if (status === 404) return 'model_not_found';
  if (status === 429 || status === 529) return 'server_busy';
  if (errorType !== undefined) return classifyErrorType(errorType);
  return 'unknown';
}

/** Nunca se loguea ni se propaga la clave real en un mensaje de error (regla de seguridad de la
 *  tarea). */
export function redact(message: string, secret: string | undefined): string {
  if (secret === undefined || secret.length < 4) return message;
  return message.split(secret).join('[REDACTED]');
}
