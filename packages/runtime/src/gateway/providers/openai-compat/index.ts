// Punto de entrada del provider OpenAI-compatible — packages/runtime/src/gateway/providers/openai-compat/index.ts.
// Solo se importa desde packages/runtime/src/gateway/ (regla de imports doc 02 §3) — mismo criterio
// que providers/ollama/index.ts.
export { OpenAICompatProvider, type OpenAICompatProviderOptions } from './provider.js';
export { OpenAICompatHttpError, type OpenAICompatStreamEvent } from './client.js';
