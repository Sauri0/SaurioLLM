// Punto de entrada del provider Ollama — packages/runtime/src/gateway/providers/ollama/index.ts.
// Solo se importa desde packages/runtime/src/gateway/ (regla de imports doc 02 §3); ningún otro
// módulo del runtime debe importar directo de providers/ollama/* (ni siquiera ModelManager, que
// recibe sus Provider vía ModelGateway.providers() — doc 08 §1).
export { OllamaProvider, type OllamaProviderOptions } from './provider.js';
export { OllamaHttpError, type OllamaStreamEvent } from './client.js';
