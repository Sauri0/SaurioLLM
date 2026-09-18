// Punto de entrada del provider Anthropic — packages/runtime/src/gateway/providers/anthropic/index.ts.
// Solo se importa desde packages/runtime/src/gateway/ (regla de imports doc 02 §3) — mismo criterio
// que providers/ollama|openai-compat/index.ts.
export { AnthropicProvider, type AnthropicProviderOptions } from './provider.js';
export { AnthropicHttpError, type AnthropicStreamResult } from './client.js';
