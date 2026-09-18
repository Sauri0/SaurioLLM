// Handlers IPC del dominio "permission" (doc 02 §1: apps/desktop/src/main/ipc/permission.ts, doc 01 §6).
import { ipc } from '@saurio/shared';
import type { RuntimeHost } from '../host/RuntimeHost.js';
import { registerHandler } from './registerHandler.js';

export function registerPermissionHandlers(host: RuntimeHost): void {
  registerHandler('permission:answer', ipc['permission:answer'], async (input) => {
    await host.answerPermission(input);
  });

  // Punto 5 del encargo ("reanudar permisos pendientes tras reinicio en la UI — tarjeta de permiso
  // rehidratada"): la UI lo llama al abrir un proyecto para repoblar `PermissionCard` con lo que
  // quedó `awaiting_permission` de una sesión anterior, sin esperar a que llegue un evento en vivo
  // (que nunca llega solo, doc 10 §5.2 — `resumeAfterRestart` recién corre cuando el usuario responde).
  registerHandler('permission:pending', ipc['permission:pending'], async () => host.pendingPermissionRequests());
}
