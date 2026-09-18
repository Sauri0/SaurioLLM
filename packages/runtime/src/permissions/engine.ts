// PermissionEngine — packages/runtime/src/permissions/engine.ts.
// Define: doc 06-permisos-y-modos.md §2 (categorías/default por preset), §3 (clasificación /
// agregación de subcomandos), §4 (reglas y patrón sugerido), §5 (invariantes), §6 (algoritmo de
// decisión), §7 ("recordar decisión"). Implementa `PermissionEngine` de
// packages/runtime/src/permissions/types.ts (contrato, NO se modifica).
//
// Gaps de contrato documentados (ver "deviations" de la salida estructurada de esta tarea):
//  1. `evaluate(call, mode, policy)` no recibe `touchedByRun` (que sí pide el algoritmo de doc §6
//     para `isBlockedByDefault`) ni `toolCallId` (que sí exige `PermissionRequestSchema`). Se agregan
//     como campos OPCIONALES en `EvaluateCall`, superconjunto estructural de
//     `ToolClassification & { toolName: string }` — un llamador que solo tenga el tipo del contrato
//     sigue siendo asignable (faltan opcionales), y el runtime real (que sí conoce ambos datos en el
//     paso 8 del flujo, doc 06 §6) puede pasarlos.
//  2. [RESUELTO en esta tarea] `PermissionRequestSchema` (@saurio/shared) ganó los campos reales
//     `noAllowOption`/`forceWarning` (doc 06 §5/§8/§12) — antes se simulaban sin tocar el schema
//     (`noAllowOption` como `rememberOptions: []`, `forceWarning` como el prefijo "COMANDO CRÍTICO:"
//     en `triggeredBy` + `risk: 'high'`), lo que no dejaba distinguir "sin patrón sugerido" de
//     "invariante: nunca se puede permitir siempre". Este motor ahora los produce de verdad para los
//     dos casos que doc §5 marca como invariantes no configurables (comando crítico: ambos en `true`;
//     `git_push`: solo `noAllowOption`) — el prefijo en `triggeredBy` y `rememberOptions: []` se
//     conservan igual (no rompen nada y siguen siendo legibles para un cliente viejo).
//  3. El orden de doc §6 es `modo -> deny (invariantes) -> reglas del agente -> reglas de sesión ->
//     reglas de proyecto -> reglas globales -> default`, pero la firma pública solo recibe un
//     `PermissionPolicy` (con un único `rules: PermissionRule[]`), no cuatro listas separadas — doc
//     §6 ya anota esto ("la firma pública ... se descompone acá"). Este motor asume que el llamador
//     ya fusionó "reglas del agente" dentro de `policy.rules` (p. ej. con `scope: 'session'`, ya que
//     `PermissionRule.scope` no tiene un valor `'agent'`) y aplica precedencia entre los scopes
//     presentes en `policy.rules` en el orden `session -> project -> global`.
import type { Mode, PermissionCategory, PermissionDecisionKind, PermissionRequest } from '@saurio/shared';
import type {
  CommandParser, ParsedCommand, PermissionDecision, PermissionEngine, PermissionPolicy, PermissionRule,
} from './types.js';
import type { ToolClassification } from '../tools/types.js';
import { commandParser as defaultCommandParser } from './command-parser.js';
import { isCriticalCommand, isBlockedByDefault, hasProtectedPathTarget } from './critical.js';
import { isProtectedPath } from './protected.js';
import {
  matchCommandPattern, matchGlob, normalizeRelPath, suggestCommandPattern, suggestPathPattern, tokenize,
} from './patterns.js';

export interface EvaluateCall extends ToolClassification {
  toolName: string;
  /** Opcional (gap de contrato #1 arriba). Sin esto, las llamadas se asumen `''`. */
  toolCallId?: string;
  /** Opcional (gap de contrato #1 arriba). Sin esto, `isBlockedByDefault` asume que nada fue
   *  tocado por el run (conservador: bloquea más, nunca menos). */
  touchedPaths?: Set<string>;
}

/** Categorías que `plan`/`ask` nunca pueden ejecutar (doc §1: "el modo es el primer filtro, más
 *  restrictivo que cualquier regla"; hallazgo #1 de la revisión 2026-09-18). `read` y `mcp` no
 *  entran acá: `mcp` no está definido para estos modos en la tabla de §1, pero tampoco es una
 *  categoría de mutación — se deja fuera del corte duro por ahora, igual que hace el algoritmo del
 *  doc, y queda cubierta por el filtro de tools real (fuera del alcance de este archivo). */
const MODE_DENIED_CATEGORIES = new Set<PermissionCategory>([
  'write', 'delete', 'terminal', 'git_commit', 'git_push', 'network',
]);

const CATEGORY_PRIORITY: Record<PermissionCategory, number> = {
  delete: 0, git_push: 0, git_commit: 1, network: 1, terminal: 2, mcp: 2, delegate: 2, write: 3, read: 4,
};

function mostRestrictiveCategory(categories: PermissionCategory[]): PermissionCategory {
  return categories.reduce((acc, c) => (CATEGORY_PRIORITY[c] < CATEGORY_PRIORITY[acc] ? c : acc));
}

const DECISION_PRIORITY: Record<PermissionDecisionKind, number> = { deny: 0, ask: 1, allow: 2 };

/** deny -> ask -> allow, sin especificidad (doc §6, `applyDecisionPriority`). */
function priorityDecision(decisions: PermissionDecisionKind[]): PermissionDecisionKind {
  return decisions.reduce((acc, d) => (DECISION_PRIORITY[d] < DECISION_PRIORITY[acc] ? d : acc));
}

function isUnderSrc(relPath: string): boolean {
  return normalizeRelPath(relPath).startsWith('src/');
}

/** Default de categoría por preset (doc §2). `paths` solo importa para el caso `strict`+`read`
 *  fuera de `src/**`. */
function defaultForCategory(
  category: PermissionCategory, preset: PermissionPolicy['preset'], paths: string[] | undefined,
): PermissionDecisionKind {
  switch (category) {
    case 'read':
      if (preset === 'strict' && paths && !paths.every(isUnderSrc)) return 'ask';
      return 'allow';
    case 'write':
      // Decisión del usuario (2026-09-18): write = allow dentro del workspace por defecto en el
      // MVP (desvío respecto del default 'ask' de doc 06 §2 para el preset balanced) — ver
      // deviations. `strict` conserva 'ask' (doc: "no ofrece permitir siempre para write").
      return preset === 'strict' ? 'ask' : 'allow';
    case 'delete':
      return preset === 'trusting' ? 'allow' : 'ask';
    case 'terminal':
    case 'git_commit':
    case 'git_push':
    case 'network':
    case 'mcp':
      return 'ask';
    // Doc 19 §2 (E3a delegación): la tool `delegate` no se agrega a DEFAULT_ALLOWED_TOOLS y solo un
    // agente que la tenga explícita en su allowedTools puede verla — igual se pide confirmación por
    // defecto (mismo criterio cauteloso que terminal/network/mcp), sin agregar un preset nuevo.
    case 'delegate':
      return 'ask';
  }
}

function matchRule(rule: PermissionRule, toolName: string, pathsOrTokens: { paths?: string[]; tokens?: string[] }): boolean {
  const toolNameOk = rule.toolName === toolName || (toolName === 'run_command' && rule.toolName === '*');
  if (!toolNameOk) return false;
  if (rule.pattern === undefined) return true;
  if (pathsOrTokens.tokens) return matchCommandPattern(rule.pattern, pathsOrTokens.tokens);
  if (pathsOrTokens.paths) return pathsOrTokens.paths.every((p) => matchGlob(rule.pattern as string, p));
  return false;
}

interface LevelMatch { decision: PermissionDecisionKind; rule: PermissionRule }

/** Reglas que matchean, agrupadas por scope, evaluadas en orden session -> project -> global; el
 *  primer scope con al menos un match gana (doc §6, pasos 3-5) y dentro de ese scope se aplica
 *  `priorityDecision` sobre todas las que matchearon (doc §6, `applyDecisionPriority`). */
function resolveByRules(
  rules: PermissionRule[], toolName: string, target: { paths?: string[]; tokens?: string[] },
): LevelMatch | undefined {
  for (const scope of ['session', 'project', 'global'] as const) {
    const matches = rules.filter((r) => r.scope === scope && matchRule(r, toolName, target));
    if (matches.length === 0) continue;
    const decision = priorityDecision(matches.map((m) => m.decision));
    const winning = matches.find((m) => m.decision === decision) ?? matches[0];
    if (!winning) continue;
    return { decision, rule: winning };
  }
  return undefined;
}

function denyDecision(reason: string, ruleId?: string): PermissionDecision {
  return { decision: 'deny', decidedBy: ruleId ? 'rule' : 'mode', reason, ...(ruleId ? { ruleId } : {}) };
}

function allowDecision(reason: string, ruleId?: string): PermissionDecision {
  return { decision: 'allow', decidedBy: ruleId ? 'rule' : 'mode', reason, ...(ruleId ? { ruleId } : {}) };
}

function buildRememberOptions(call: EvaluateCall, offerAllowAlways: boolean): PermissionRequest['rememberOptions'] {
  if (!offerAllowAlways) return [];
  const suggested = call.command
    ? suggestCommandPattern(tokenize(call.command))
    : call.paths?.[0] ? suggestPathPattern(call.paths[0]) : undefined;
  if (!suggested) return [];
  return [
    { scope: 'project', suggestedPattern: suggested },
    { scope: 'global', suggestedPattern: suggested },
  ];
}

function askDecision(request: PermissionRequest): PermissionDecision {
  return { decision: 'ask', request };
}

function buildRequest(
  call: EvaluateCall, triggeredBy: string,
  opts: {
    offerAllowAlways: boolean; risk?: 'low' | 'medium' | 'high';
    /** Doc 06 §5: solo los DOS invariantes no configurables (comando crítico, `git_push`) lo pasan
     *  en `true` — un `ask` que viene de una regla o de un default de preset sigue sin esto, aunque
     *  también tenga `offerAllowAlways: true` en el mismo llamado (son cosas distintas: éste dice "la
     *  UI no debe ofrecer permitir siempre NUNCA para esto", no solo "esta vez no hay patrón"). */
    noAllowOption?: boolean;
    /** Doc 06 §5/§8: tarjeta con advertencia roja fija — hoy solo lo dispara el comando crítico. */
    forceWarning?: boolean;
  },
): PermissionRequest {
  return {
    toolCallId: call.toolCallId ?? '',
    toolName: call.toolName,
    category: call.category,
    risk: opts.risk ?? call.risk,
    summary: call.summary,
    triggeredBy,
    preview: { command: call.command, paths: call.paths },
    rememberOptions: buildRememberOptions(call, opts.offerAllowAlways),
    ...(opts.noAllowOption ? { noAllowOption: true as const } : {}),
    ...(opts.forceWarning ? { forceWarning: true as const } : {}),
  };
}

export class DefaultPermissionEngine implements PermissionEngine {
  constructor(private readonly commandParser: CommandParser = defaultCommandParser) {}

  isProtectedPath(relPath: string): boolean {
    return isProtectedPath(relPath);
  }

  isCriticalCommand(parsed: ParsedCommand): boolean {
    return isCriticalCommand(parsed);
  }

  isBlockedByDefault(parsed: ParsedCommand, touchedByRun: Set<string>): boolean {
    return isBlockedByDefault(parsed, touchedByRun);
  }

  evaluate(call: EvaluateCall, mode: Mode, policy: PermissionPolicy): PermissionDecision {
    const parsed = call.command ? this.commandParser.parse(call.command, 'pwsh') : undefined;
    const touched = call.touchedPaths ?? new Set<string>();

    // Paso 0/1: modo -> deny (doc §1/§6, hallazgo #1). No configurable: ningún preset ni regla
    // puede reabrir una categoría que el modo ya cierra.
    if ((mode === 'plan' || mode === 'ask') && MODE_DENIED_CATEGORIES.has(call.category)) {
      return denyDecision('mode_denied');
    }

    // Paso 1: invariantes (doc §5/§6), no configurables.
    if ((call.category === 'write' || call.category === 'delete') && call.paths?.some((p) => isProtectedPath(p))) {
      return denyDecision('protected_path');
    }
    if (parsed && isCriticalCommand(parsed)) {
      return askDecision(buildRequest(call, `COMANDO CRÍTICO: ${call.command ?? ''}`, {
        offerAllowAlways: false, risk: 'high', noAllowOption: true, forceWarning: true,
      }));
    }
    if (parsed && isBlockedByDefault(parsed, touched)) {
      return denyDecision('blocked_git_operation');
    }
    if (parsed && hasProtectedPathTarget(parsed)) {
      return denyDecision('protected_path');
    }
    const effectiveCategory = parsed
      ? mostRestrictiveCategory(parsed.subcommands.map((s) => s.category))
      : call.category;
    if (effectiveCategory === 'git_push') {
      return askDecision(buildRequest(
        { ...call, category: 'git_push' },
        'categoría git_push -> ask (invariante, nunca allow)',
        { offerAllowAlways: false, noAllowOption: true },
      ));
    }

    if (parsed) return this.evaluateCommand(parsed, call, policy);
    return this.evaluateSingle(call, policy);
  }

  private evaluateSingle(call: EvaluateCall, policy: PermissionPolicy): PermissionDecision {
    const match = resolveByRules(policy.rules, call.toolName, { paths: call.paths });
    if (match) {
      const triggeredBy = `regla de ${match.rule.scope} ${match.rule.toolName}(${match.rule.pattern ?? '*'}) -> ${match.decision}`;
      if (match.decision === 'deny') return denyDecision(triggeredBy, match.rule.id);
      if (match.decision === 'allow') return allowDecision(triggeredBy, match.rule.id);
      return askDecision(buildRequest(call, triggeredBy, { offerAllowAlways: true }));
    }

    const decision = defaultForCategory(call.category, policy.preset, call.paths);
    const triggeredBy = `categoría ${call.category} -> ${decision} (preset ${policy.preset})`;
    if (decision === 'deny') return denyDecision(triggeredBy);
    if (decision === 'allow') return allowDecision(triggeredBy);
    return askDecision(buildRequest(call, triggeredBy, { offerAllowAlways: true }));
  }

  /** Agregación de subcomandos (doc §3): cada subcomando se evalúa por separado y el resultado
   *  del conjunto es el más restrictivo — 'allow' automático solo si TODOS matchean 'allow'. */
  private evaluateCommand(parsed: ParsedCommand, call: EvaluateCall, policy: PermissionPolicy): PermissionDecision {
    if (!parsed.confident || parsed.subcommands.length === 0) {
      return askDecision(buildRequest(call, 'comando ambiguo (parser no confiable) -> ask', { offerAllowAlways: false }));
    }

    const perSub = parsed.subcommands.map((sub) => {
      const allowlisted = sub.category === 'terminal'
        && policy.terminalAllowlist.some((p) => matchCommandPattern(p, sub.tokens));
      if (allowlisted) return { decision: 'allow' as PermissionDecisionKind, rule: undefined as PermissionRule | undefined, sub };

      const match = resolveByRules(policy.rules, 'run_command', { tokens: sub.tokens });
      if (match) return { decision: match.decision, rule: match.rule, sub };

      const decision = defaultForCategory(sub.category, policy.preset, undefined);
      return { decision, rule: undefined as PermissionRule | undefined, sub };
    });

    const overall = priorityDecision(perSub.map((p) => p.decision));
    const effectiveCategory = mostRestrictiveCategory(parsed.subcommands.map((s) => s.category));

    if (overall === 'deny') {
      const denied = perSub.find((p) => p.decision === 'deny');
      return denyDecision(
        denied?.rule ? `regla de ${denied.rule.scope} ${denied.rule.toolName}(${denied.rule.pattern ?? '*'}) -> deny` : 'subcomando en deny',
        denied?.rule?.id,
      );
    }
    if (overall === 'allow') {
      return allowDecision('todos los subcomandos matchean allow', perSub[0]?.rule?.id);
    }
    const triggeredBy = `categoría ${effectiveCategory} -> ask: no todos los subcomandos matchean allow (preset ${policy.preset})`;
    return askDecision(buildRequest({ ...call, category: effectiveCategory }, triggeredBy, { offerAllowAlways: true }));
  }
}

export { resolveByRules, defaultForCategory, mostRestrictiveCategory, priorityDecision };
