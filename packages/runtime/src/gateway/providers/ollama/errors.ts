// Clasificación de errores de Ollama a ProviderErrorCode — packages/runtime/src/gateway/providers/ollama/errors.ts.
// Define: doc 08-model-manager-y-scheduler.md §2 (qué puede fallar) y doc 04 §3 (ProviderErrorCode).
// Ollama entrega errores de tres formas distintas (investigación research-ollama.md §1): (a) fetch()
// rechaza (conexión rehusada, DNS, abort), (b) respuesta HTTP no-200 con body `{"error": "..."}",
// (c) chunk NDJSON con propiedad `error` a mitad de stream aunque el status HTTP ya sea 200. Esta
// función clasifica el mensaje/](status a un ProviderErrorCode; es heurística de texto porque Ollama
// no documenta códigos de error estables [VERIFICADO EN DOC OFICIAL: docs.ollama.com/api/errors sólo
// documenta status HTTP genéricos, no un enum de errores].
import type { ProviderErrorCode } from '../../types.js';

/** true cuando el error viene de que NOSOTROS cortamos la conexión (AbortController.abort()),
 *  nunca de un fallo real del servidor — el llamador debe tratarlo como cancelación limpia, no
 *  como ChatChunk de tipo 'error' (doc 08 §7.5). */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Errores de red antes de recibir cualquier respuesta HTTP (ECONNREFUSED, DNS, socket cerrado). */
export function classifyFetchError(err: unknown): ProviderErrorCode {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes('econnrefused') || lower.includes('fetch failed') || lower.includes('failed to fetch')) {
    return 'connection_refused';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  return 'unknown';
}

/** Errores con un status HTTP conocido (respuesta no-200 antes de empezar el stream). */
export function classifyHttpError(status: number, body: string): ProviderErrorCode {
  if (status === 404) return 'model_not_found';
  if (status === 429 || status === 503) return 'server_busy';
  const byBody = classifyErrorMessage(body);
  if (byBody !== 'unknown') return byBody;
  if (status >= 500) return 'unknown';
  return 'unknown';
}

/** Errores de texto libre: el chunk NDJSON `{"error": "..."}` a mitad de stream (HTTP ya en 200,
 *  doc 08 §2 tabla "carga/descarga explícita") o el body de una respuesta no-200. Heurística de
 *  substrings sobre los mensajes reales observados en `server.log`/`server-1.log` de este equipo
 *  (doc 11-roadmap.md, `cudaMalloc failed: out of memory`, `context size too large for model`,
 *  `server busy` de `ErrMaxQueue`) [COMPROBADO EN EQUIPO + VERIFICADO EN DOC OFICIAL: server/sched.go]. */
export function classifyErrorMessage(message: string): ProviderErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes('does not support tools') || lower.includes('no tools support') || lower.includes("doesn't support tools")) {
    return 'no_tools_support';
  }
  if (lower.includes('not found') || lower.includes('no such model') || lower.includes('model') && lower.includes('not exist')) {
    return 'model_not_found';
  }
  if (lower.includes('maximum pending requests') || lower.includes('server busy') || lower.includes('max_queue')) {
    return 'server_busy';
  }
  if (lower.includes('context size') && (lower.includes('too large') || lower.includes('exceed'))) {
    return 'context_too_large';
  }
  if (lower.includes('exceeds context window') || lower.includes('too large for model')) {
    return 'context_too_large';
  }
  if (lower.includes('out of memory') || lower.includes('cudamalloc failed') || lower.includes('oom')) {
    // No podemos distinguir load vs generate desde el solo texto; el llamador (client.ts) decide
    // 'oom_load' vs 'oom_generate' según si ya se había emitido contenido en el stream.
    return 'oom_load';
  }
  if (lower.includes('econnreset') || lower.includes('socket hang up') || lower.includes('unexpected end of')) {
    return 'stream_cut';
  }
  return 'unknown';
}

/** Reclasifica un `oom_load` como `oom_generate` cuando el corte ocurrió después de haber
 *  emitido contenido (la carga ya había terminado con éxito). */
export function refineOomCode(code: ProviderErrorCode, hadContent: boolean): ProviderErrorCode {
  if (code === 'oom_load' && hadContent) return 'oom_generate';
  return code;
}
