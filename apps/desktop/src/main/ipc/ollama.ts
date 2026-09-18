// Handler IPC del canal `ollama:ensureRunning` — PRIORIDAD CERO punto 1.
// apps/desktop/src/main/ipc/ollama.ts. No depende de RuntimeHost (a diferencia del resto de
// ipc/*.ts): `OllamaProcessManager` no necesita saurio.db ni ningún proyecto abierto, así que este
// canal responde aunque el runtime real no haya podido inicializarse (justo el caso en el que más
// hace falta poder arrancar Ollama y reintentar).
import { ipc } from '@saurio/shared';
import type { OllamaProcessManager } from '../services/ollama-process/index.js';
import { registerHandler } from './registerHandler.js';

export function registerOllamaHandlers(manager: OllamaProcessManager): void {
  registerHandler('ollama:ensureRunning', ipc['ollama:ensureRunning'], async () => manager.ensureRunning());
}
