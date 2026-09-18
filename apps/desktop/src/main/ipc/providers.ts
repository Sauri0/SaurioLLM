// Handlers IPC del dominio "providers" (punto 3 del encargo: "Tabla/config de providers + canales
// IPC providers:list/add/update/remove/test") — apps/desktop/src/main/ipc/providers.ts.
// CRUD real sobre `providers` (SqlProvidersRepository) + almacén seguro de claves (SecureKeyStore,
// Electron safeStorage, punto 1) + `health()`/`listModels()` real ("probar conexión"). Tras cualquier
// cambio, `host.refreshProviders()` reconstruye `ModelGatewayImpl`/`ModelManager` en caliente
// (setProviders, cambio aditivo en packages/runtime de esta misma tarea) — sin esto, un provider
// recién agregado no podía usarse hasta reiniciar la app.
import { ipc } from '@saurio/shared';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import { registerHandler } from './registerHandler.js';
import { PROVIDER_PRESET_DEFAULTS } from '../host/createRuntime.js';
import { OLLAMA_PROVIDER_ID } from '../services/providers/SqlProvidersRepository.js';

export class ProviderNotFoundError extends Error {
  constructor(id: string) {
    super(`saurio: no existe ningún provider con id "${id}"`);
    this.name = 'ProviderNotFoundError';
  }
}

function requireBaseUrl(preset: keyof typeof PROVIDER_PRESET_DEFAULTS | 'custom', explicit: string | undefined): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  if (preset === 'custom') {
    throw new Error('saurio: "OpenAI-compatible personalizado" necesita un baseUrl (LM Studio, llama.cpp server, vLLM, Groq...).');
  }
  return PROVIDER_PRESET_DEFAULTS[preset].baseUrl;
}

function newProviderId(preset: string): string {
  return `${preset}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function registerProvidersHandlers(host: RuntimeHost): void {
  registerHandler('providers:list', ipc['providers:list'], async () => host.listProviderConfigs());

  registerHandler('providers:add', ipc['providers:add'], async (input) => {
    const kind = input.preset === 'custom' ? 'openai-compat' : PROVIDER_PRESET_DEFAULTS[input.preset].kind;
    const baseUrl = requireBaseUrl(input.preset, input.baseUrl);
    const id = newProviderId(input.preset);
    // Punto 1 del encargo ("si safeStorage no está disponible, avisar y no guardar"): si falla acá,
    // no se llega a insertar ninguna fila en `providers` — nada queda a medias.
    if (input.apiKey) host.secureKeyStore.set(id, input.apiKey);
    host.providersRepository.insert({ id, kind, baseUrl, preset: input.preset, label: input.label, headers: input.headers, enabled: true });
    host.refreshProviders();
    const created = host.listProviderConfigs().find((p) => p.id === id);
    if (!created) throw new ProviderNotFoundError(id);
    return created;
  });

  registerHandler('providers:update', ipc['providers:update'], async (input) => {
    if (!host.providersRepository.get(input.id)) throw new ProviderNotFoundError(input.id);
    if (input.apiKey === null) host.secureKeyStore.remove(input.id);
    else if (typeof input.apiKey === 'string' && input.apiKey.length > 0) host.secureKeyStore.set(input.id, input.apiKey);
    host.providersRepository.update(input.id, {
      label: input.label, baseUrl: input.baseUrl, enabled: input.enabled, headers: input.headers,
    });
    host.refreshProviders();
    const updated = host.listProviderConfigs().find((p) => p.id === input.id);
    if (!updated) throw new ProviderNotFoundError(input.id);
    return updated;
  });

  registerHandler('providers:remove', ipc['providers:remove'], async (input) => {
    if (input.id === OLLAMA_PROVIDER_ID) {
      throw new Error('saurio: el provider "ollama" (sembrado por defecto) no se puede borrar — deshabilitalo con providers:update en cambio.');
    }
    host.providersRepository.remove(input.id);
    host.secureKeyStore.remove(input.id);
    host.refreshProviders();
  });

  registerHandler('providers:test', ipc['providers:test'], async (input) => host.testProvider(input.id));

  // Punto 4 del encargo ("visor simple del audit_log... en Ajustes > Proveedores"): solo lectura,
  // más recientes primero (mismo límite por defecto que `SqlAuditLogRepository.listNonLocalCalls`).
  registerHandler('providers:auditLog', ipc['providers:auditLog'], async () => host.auditLog.listNonLocalCalls());
}
