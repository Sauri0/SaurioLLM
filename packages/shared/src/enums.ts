// Enums compartidos (zod) — única fuente de verdad de nomenclatura para todo el monorepo.
// Define: doc 04 §1 (packages/shared/src/enums.ts); nombres/valores verbatim de esa sección.
import { z } from 'zod';

export const RunState = z.enum([
  'created', 'preparing', 'queued', 'generating', 'parsing',
  'awaiting_permission', 'executing_tool', 'compacting', 'cancelling',
  'completed', 'cancelled', 'failed', 'interrupted',
]);
export type RunState = z.infer<typeof RunState>;

export const ToolCallStatus = z.enum([
  'pending', 'awaiting_permission', 'approved', 'denied', 'running',
  'awaiting_input',              // v0.3: solo MCP tools que piden input intermedio
  'done', 'failed', 'cancelled', 'orphaned', 'abandoned',
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

export const PermissionCategory = z.enum([
  'read', 'write', 'delete', 'terminal', 'git_commit', 'git_push',
  'network',   // v0.3
  'mcp',       // v0.3
  'delegate',  // E3a (doc 19 §2): tool_calls.category ya admite este valor desde la migración 0001.
]);
export type PermissionCategory = z.infer<typeof PermissionCategory>;

export const PermissionDecisionKind = z.enum(['allow', 'ask', 'deny']);
export type PermissionDecisionKind = z.infer<typeof PermissionDecisionKind>;

export const Risk = z.enum(['low', 'medium', 'high']);
export type Risk = z.infer<typeof Risk>;

/** plan/agent en el MVP; ask/edit son filtros triviales que se activan en v0.2. */
export const Mode = z.enum(['plan', 'ask', 'edit', 'agent']);
export type Mode = z.infer<typeof Mode>;

/** local únicamente en el MVP; lan/proxied-cloud/cloud existen en el tipo desde el día 1
 *  para que ModelRef y PermissionPolicy no cambien de forma cuando se habiliten (v0.4). */
export const Locality = z.enum(['local', 'lan', 'proxied-cloud', 'cloud']);
export type Locality = z.infer<typeof Locality>;

export const ChatRole = z.enum(['system', 'user', 'assistant', 'tool']);
export type ChatRole = z.infer<typeof ChatRole>;

export const ToolTransport = z.enum(['native', 'text']);
export type ToolTransport = z.infer<typeof ToolTransport>;

export const AgentRole = z.enum(['lead', 'coder', 'reviewer', 'explorer', 'custom']);
export type AgentRole = z.infer<typeof AgentRole>;

export const MatchLevel = z.enum(['exact', 'eol', 'indent', 'whitespace', 'fuzzy']);
export type MatchLevel = z.infer<typeof MatchLevel>;

/** Toda cifra que ve el usuario declara su procedencia (regla 6 de la columna). */
export const Quality = z.enum(['measured', 'estimated', 'unavailable']);
export type Quality = z.infer<typeof Quality>;

// ── Doc 19 §1.2 (E2a "Mis agentes") ──────────────────────────────────────────
// `owner_kind` discrimina configuraciones de ejecución (`builtin`) de identidades de usuario
// (`personal`) y de las dos mecánicas de ejecución que reusan la misma fila por costo de FK
// (`worker`: subagente efímero de delegación, E3a; `coordinator`: fila casi vacía que solo satisface
// `chats.agent_id` en un chat de equipo, E3b) — doc 19 §0. `worker`/`coordinator` nunca se exponen en
// la UI de "Mis agentes" (siempre filtrados por `AgentRepository.listProfiles`).
export const AgentOwnerKind = z.enum(['builtin', 'personal', 'worker', 'coordinator']);
export type AgentOwnerKind = z.infer<typeof AgentOwnerKind>;

/** `fixed`: el agente usa siempre `AgentProfile.model`. `auto`: `agent/modelPolicy.ts` elige en
 *  tiempo de ejecución (doc 19 §1.5) — heurística mínima, ver comentario de ese archivo. */
export const ModelMode = z.enum(['fixed', 'auto']);
export type ModelMode = z.infer<typeof ModelMode>;

/** Procedencia de una fila de `agent_memories` (doc 19 §1.1/§1.7): nunca se muestra como hecho
 *  plano en el prompt ensamblado, siempre con esta etiqueta visible. */
export const MemorySourceKind = z.enum(['user_stated', 'inferred', 'file_derived']);
export type MemorySourceKind = z.infer<typeof MemorySourceKind>;

export const MemoryConfidence = z.enum(['confirmed', 'hypothesis']);
export type MemoryConfidence = z.infer<typeof MemoryConfidence>;

/** Mismos tres valores que `PermissionPolicy.preset` (packages/runtime/src/permissions/types.ts,
 *  unión TS literal, sin zod porque no cruzaba IPC hasta esta tarea) — acá se necesita un schema zod
 *  porque `AgentProfileSchema`/`AgentCreateInputSchema` sí cruzan `agents:*` (doc 19 §1.4). */
export const PermissionPreset = z.enum(['strict', 'balanced', 'trusting']);
export type PermissionPreset = z.infer<typeof PermissionPreset>;

// ── Feedback real v0.2.1 (usuario, modo Agente): preset de permisos POR CHAT ─────────────────────
// Distinto de `PermissionPreset` de arriba (ese es el preset de un AgentProfile, dimensión distinta):
// este es el control que el usuario cambia en el chat mismo. 'ask': preguntar todo lo que no sea
// lectura. 'edit_in_folder': ediciones dentro de la carpeta del proyecto sin preguntar, comandos
// preguntan. 'full_in_folder': ediciones Y comandos dentro de la carpeta sin preguntar; git push, red
// y rutas fuera de la carpeta preguntan igual. 'unrestricted' ("Sin límites"): no pregunta nada salvo
// escribir dentro de `.git` del proyecto (protected paths, ver permissions/protected.ts) — requiere
// confirmación explícita al activarlo y queda registrado en audit_log (packages/runtime/src/permissions).
export const ChatPermissionPreset = z.enum(['ask', 'edit_in_folder', 'full_in_folder', 'unrestricted']);
export type ChatPermissionPreset = z.infer<typeof ChatPermissionPreset>;

// ── Feedback real v0.2.1: "effort" por chat — mapea a think off/low/high (o equivalente según
// capabilities del modelo), numPredict y maxIterations (packages/runtime/src/agent/modelPolicy.ts). ──
export const Effort = z.enum(['fast', 'balanced', 'deep']);
export type Effort = z.infer<typeof Effort>;
