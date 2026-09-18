// Handlers IPC del dominio "app" (doc 02 §1 no le da un archivo propio a nivel de doc porque este
// canal no estaba previsto ahí — se agrega junto al resto de apps/desktop/src/main/ipc/, mismo
// criterio que 'provider:health' en ipc/models.ts).
// apps/desktop/src/main/ipc/app.ts.
//
// 'app:openExternal' es del asistente de primer arranque (punto 5 del encargo): abre una URL en el
// navegador del sistema con `shell.openExternal`. Allowlist de host explícita (nunca abre cualquier
// URL que el renderer le pida) porque es la única vía por la que esta app toca algo "afuera" del
// propio proceso sin pasar por Ollama — mismo espíritu que ADR-2 ("nunca confiar en que el llamador
// mandó algo razonable"). El consentimiento en sí se pide en la UI, antes de invocar este canal.
import { shell } from 'electron';
import { ipc } from '@saurio/shared';
import { registerHandler } from './registerHandler.js';

const ALLOWED_HOSTS = new Set(['ollama.com', 'www.ollama.com']);

export function registerAppHandlers(): void {
  registerHandler('app:openExternal', ipc['app:openExternal'], async (input) => {
    const url = new URL(input.url);
    if (!ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(`saurio: "app:openExternal" solo abre ${[...ALLOWED_HOSTS].join(', ')}, no "${url.hostname}"`);
    }
    await shell.openExternal(url.toString());
  });
}
