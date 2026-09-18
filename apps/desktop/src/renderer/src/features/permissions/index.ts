// Panel "permissions" del renderer (doc 02 §1 y §2: apps/desktop/src/renderer/src/features/permissions/).
// Tarjeta de permiso bloqueante (doc 06 §8); el layout (otro agente) la monta en el chat cuando
// runStore.pendingPermissions tiene una entrada para el toolCallId correspondiente.
export { PermissionCard, type PermissionCardProps } from './PermissionCard.js';
