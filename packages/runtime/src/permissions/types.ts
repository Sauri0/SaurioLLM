// Permisos: reglas, política y motor de decisión — packages/runtime/src/permissions/types.ts.
// Define: doc 04 §7. Solo interfaces/tipos (sin implementación). MVP: 'plan'/'agent', categorías
// read|write|delete|terminal|git_commit|git_push, CommandParser pwsh + bash. `network`/`mcp` son v0.3.
// PermissionRequest/Decision/Answer tienen su schema zod en @saurio/shared (domain.ts) porque cruzan
// IPC ('permission:answer', RunEvent 'tool.permission'/'tool.decision') — doc 02 §3.
import type {
  PermissionCategory, PermissionDecisionKind, Mode,
  PermissionRequest, PermissionDecision, PermissionAnswer,
} from '@saurio/shared';
import type { ToolClassification } from '../tools/types.js';

export type { PermissionRequest, PermissionDecision, PermissionAnswer };

export interface PermissionRule {
  id?: string; scope: 'session' | 'project' | 'global';
  toolName: string; pattern?: string; decision: PermissionDecisionKind;
  source: 'user' | 'preset' | 'mode' | 'settings';
}

export interface PermissionPolicy {
  preset: 'strict' | 'balanced' | 'trusting';
  rules: PermissionRule[];
  terminalAllowlist: string[];
}

/** Orden de evaluación fijo deny -> ask -> allow, sin especificidad
 *  [VERIFICADO EN DOC OFICIAL: code.claude.com/docs/en/permissions]. */
export interface PermissionEngine {
  evaluate(call: ToolClassification & { toolName: string }, mode: Mode, policy: PermissionPolicy): PermissionDecision;
  isProtectedPath(relPath: string): boolean;
  isCriticalCommand(parsed: ParsedCommand): boolean;
  isBlockedByDefault(parsed: ParsedCommand, touchedByRun: Set<string>): boolean;
}

/** Salida de CommandParser (uno por shell: pwsh, bash); cada subcomando debe matchear
 *  para 'allow'; si el parser no está seguro, el resultado fuerza 'ask' [DECISIÓN DE DISEÑO]. */
export interface ParsedCommand {
  raw: string; shell: 'pwsh' | 'bash';
  subcommands: { tokens: string[]; category: PermissionCategory }[];
  confident: boolean;
}

export interface CommandParser { parse(raw: string, shell: 'pwsh' | 'bash'): ParsedCommand }
