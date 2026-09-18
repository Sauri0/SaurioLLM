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
