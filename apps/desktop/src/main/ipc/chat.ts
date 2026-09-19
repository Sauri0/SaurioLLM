// Handlers IPC del dominio "chat" (doc 02 §1: apps/desktop/src/main/ipc/chat.ts, doc 01 §6).
// Delegan a los repositorios de packages/runtime/src/persistence/types.ts; hasta que la integración
// conecte instancias reales (persistence/schema.ts es hoy un placeholder de esqueleto), estos
// handlers responden con RuntimeNotWiredError — quedan registrados y tipados, listos para conectar.
import { ipc, CLOUD_CONSENT_SETTINGS_KEY, LOCAL_ONLY_SETTINGS_KEY, type ModelRef } from '@saurio/shared';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import { registerHandler } from './registerHandler.js';

/** Punto 4 del encargo (frontera local/nube): `chat:setModel` lanza esto cuando el modelo elegido es
 *  `locality: 'cloud'` y todavía no hay consentimiento explícito para ESTE proyecto. El mensaje lleva
 *  un prefijo estable (`CLOUD_CONFIRMATION_REQUIRED:`) porque `ipcMain.handle` no garantiza que
 *  propiedades custom de una subclase de Error sobrevivan la serialización hacia el renderer — el
 *  resto del código de esta app (`NotImplementedYetError`, etc.) ya asume esa misma limitación y solo
 *  se apoya en `error.message`. La UI lo detecta, muestra el diálogo de confirmación explícito y
 *  reintenta `chat:setModel` con `confirmed: true`. */
export class CloudConfirmationRequiredError extends Error {
  constructor(readonly providerLabel: string) {
    super(`CLOUD_CONFIRMATION_REQUIRED:${providerLabel}`);
    this.name = 'CloudConfirmationRequiredError';
  }
}

/** Punto 4 del encargo (frontera local/nube): "elegir un modelo NUBE para un chat pide confirmación
 *  explícita la primera vez por proyecto" + "ajuste global 'Solo local' que bloquea todo lo no local"
 *  + "jamás fallback automático" (ya lo garantiza `ModelGateway.chat()`, doc 18 §5 — acá se agrega la
 *  frontera del LADO DE LA UI, antes de que el modelo llegue a fijarse en un chat). Compartida entre
 *  `chat:create` (un chat nuevo con modelRef NUBE de entrada es otra forma de "elegir un modelo NUBE
 *  para un chat") y `chat:setModel`. El consentimiento fija `authorizedLocality` del run porque
 *  `RunController` ya deriva `authorizedLocality` del modelo del chat
 *  (`[live.effectiveConfig.model.locality]`); una vez guardado acá, cada run de este chat/proyecto
 *  queda autorizado para modelos NUBE, sin volver a preguntar. */
async function enforceLocalityGate(
  host: RuntimeHost, projectId: string, modelRef: ModelRef, confirmed: boolean | undefined,
): Promise<void> {
  if (modelRef.locality === 'local') return;
  const settings = host.settingsRepository;
  if (!settings) return;
  const localOnly = await settings.get(LOCAL_ONLY_SETTINGS_KEY, undefined);
  if (localOnly === true) {
    throw new Error(
      `saurio: "Solo modelos locales" está activado en Ajustes — no se puede elegir un modelo ` +
        `${modelRef.locality} para este chat mientras esté activado.`,
    );
  }
  if (modelRef.locality !== 'cloud') return;
  if (confirmed) {
    await settings.set(CLOUD_CONSENT_SETTINGS_KEY, true, projectId);
    return;
  }
  const consent = await settings.get(CLOUD_CONSENT_SETTINGS_KEY, projectId);
  if (consent !== true) {
    const providerLabel = host.listProviderConfigs().find((p) => p.id === modelRef.providerId)?.label ?? modelRef.providerId;
    throw new CloudConfirmationRequiredError(providerLabel);
  }
}

export function registerChatHandlers(host: RuntimeHost): void {
  registerHandler('chat:create', ipc['chat:create'], async (input) => {
    await enforceLocalityGate(host, input.projectId, input.modelRef, input.confirmed);
    const now = Date.now();
    return host.chatRepository.create({
      id: `chat_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      projectId: input.projectId,
      agentId: input.agentId,
      mode: input.mode,
      modelRef: input.modelRef,
      createdAt: now,
      updatedAt: now,
      archived: false,
    });
  });

  registerHandler('chat:list', ipc['chat:list'], async (input) => host.chatRepository.listByProject(input.projectId));

  // Punto 3 del encargo: cambiar modelo/modo de un chat existente desde la cabecera del chat, sin
  // recrearlo. `ChatRepository.update` ya soportaba un patch parcial (persistence/types.ts); solo
  // faltaba el canal IPC (doc 16 no lo listaba porque el MVP fijaba modelo/modo al crear el chat).
  // No toca ningún run en curso: el próximo `run:start`/`run:continue` de ESTE chat toma el modelo
  // vigente en `chats.model_ref_json` (createRuntime.ts ya hereda el modelo del chat, ver doc 16 §2).
  registerHandler('chat:setModel', ipc['chat:setModel'], async (input) => {
    const chat = await host.chatRepository.get(input.chatId);
    if (!chat) throw new Error(`saurio: no existe el chat "${input.chatId}"`);
    await enforceLocalityGate(host, chat.projectId, input.modelRef, input.confirmed);
    return host.chatRepository.update(input.chatId, { modelRef: input.modelRef, updatedAt: Date.now() });
  });

  registerHandler('chat:setMode', ipc['chat:setMode'], async (input) =>
    host.chatRepository.update(input.chatId, { mode: input.mode, updatedAt: Date.now() }));

  // Punto 1a del encargo (feedback real v0.2.1): `unrestricted` ("Sin límites") exige confirmación
  // explícita al activarlo (input.confirmed) y queda auditado — reusa `audit_log` genérica (doc 03)
  // con `kind: 'permission.unrestricted_enabled'`, mismo mecanismo que
  // `NonLocalCallAuditEntry`/`providers:auditLog` para llamadas no locales.
  registerHandler('chat:setPermissionPreset', ipc['chat:setPermissionPreset'], async (input) => {
    const chat = await host.chatRepository.get(input.chatId);
    if (!chat) throw new Error(`saurio: no existe el chat "${input.chatId}"`);
    if (input.preset === 'unrestricted' && !input.confirmed) {
      throw new Error(
        'saurio: activar "Sin límites" requiere confirmación explícita (confirmed: true) — este preset no pregunta nada, ' +
          'salvo escribir dentro de .git del proyecto o un comando crítico.',
      );
    }
    if (input.preset === 'unrestricted') {
      host.auditLog.record({
        kind: 'permission.unrestricted_enabled',
        payload: { chatId: input.chatId, projectId: chat.projectId },
      });
    }
    return host.chatRepository.update(input.chatId, { permissionPreset: input.preset, updatedAt: Date.now() });
  });

  registerHandler('chat:setEffort', ipc['chat:setEffort'], async (input) =>
    host.chatRepository.update(input.chatId, { effort: input.effort, updatedAt: Date.now() }));

  registerHandler('chat:rename', ipc['chat:rename'], async (input) =>
    host.chatRepository.update(input.chatId, { title: input.title, updatedAt: Date.now() }));

  registerHandler('chat:archive', ipc['chat:archive'], async (input) =>
    host.chatRepository.update(input.chatId, { archived: input.archived, updatedAt: Date.now() }));

  // Punto 12 del encargo: soft-delete (ver comentario de la migración 0006 sobre por qué no es un
  // DELETE real de la fila) — el chat deja de aparecer en chat:list, el historial queda en disco.
  registerHandler('chat:delete', ipc['chat:delete'], async (input) => {
    await host.chatRepository.softDelete(input.chatId, Date.now());
  });

  registerHandler('chat:history', ipc['chat:history'], async (input) => {
    // `ToolCallRepository` (packages/runtime/src/persistence/types.ts) solo expone `listByRun`, y un
    // chat tiene varios runs en el tiempo (doc 01 §7.a): la integración resuelve primero los runs del
    // chat (RunRepository.listByChat) y concatena sus tool calls, en vez de tratar chatId como runId.
    const runs = await host.runsOfChat(input.chatId);
    const [messages, toolCallsByRun, checkpoints, tasks] = await Promise.all([
      host.messageRepository.listByChat(input.chatId),
      Promise.all(runs.map((run) => host.toolCallRepository.listByRun(run.id))),
      host.checkpointRepository.listByChat(input.chatId),
      host.taskRepository.listByChat(input.chatId),
    ]);
    return { messages, toolCalls: toolCallsByRun.flat(), checkpoints, tasks };
  });
}
