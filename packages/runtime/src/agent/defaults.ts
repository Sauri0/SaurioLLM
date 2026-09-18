// Agente builtin del MVP y su ContextPolicy por defecto — packages/runtime/src/agent/defaults.ts.
// Define: doc 05 §2.2 (EffectiveConfig), doc 07 §5 (presupuestos de contexto), doc 06 §2 (preset de
// permisos). Los números salen de las MEDICIONES del 2026-09-18 en este equipo (RTX 3060 Ti 8 GiB,
// Ollama 0.34.1): qwen3:8b y qwen2.5-coder:7b entran 100% en GPU con num_ctx 8192; con 16384 hay
// offload y la generación cae de ~60 tok/s a ~18 tok/s. De ahí numCtx 8192 y los presupuestos
// escalados a 8k (repo map ~1000 tokens, historial ~3500, reserva 1500) y `thinking: 'off'`.
import { createHash } from 'node:crypto';
import type { ModelRef, ToolTransport } from '@saurio/shared';
import type { AgentConfig, ContextPolicy } from './types.js';
import type { PermissionPolicy } from '../permissions/types.js';

export const DEFAULT_AGENT_ID = 'agent_builtin_lead';

/** Modelo por defecto del MVP en este equipo (medido: entra 100% en GPU con num_ctx 8192). */
export const DEFAULT_MODEL_REF: ModelRef = { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' };

/** MEDIDO 2026-09-18: qwen2.5-coder:7b declara soporte de `tools` pero responde el tool call en
 *  texto plano; con `toolTransport: 'auto'` el transporte efectivo para ese modelo es 'text'
 *  (columna vertebral §9, `settings.toolTransportOverrides`). */
export const DEFAULT_TOOL_TRANSPORT_OVERRIDES: Record<string, ToolTransport> = {
  'qwen2.5-coder': 'text',
};

/** Presupuestos escalados a 8k (doc 07 §5 los tabula para 16k; ContextPolicy.numCtx es ajustable). */
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  numCtx: 8192,
  reserveForResponse: 1500,
  repoMapTokens: 1000,
  historyBudgetRatio: 0.43,       // ~3500 tokens de historial sobre 8192
  maxReadLines: 250,
  maxSearchResults: 50,
  maxCommandLines: 250,
  compactAtRatio: 0.85,
  compactEveryTurns: 6,
  keepLastTurns: 6,
  fewShot: false,
};

/** Doc 16 (encargo "numCtx efectivo"): función inyectable para elegir un `numCtx` por defecto según
 *  el modelo, en vez del literal fijo de `DEFAULT_CONTEXT_POLICY.numCtx` (8192, medido SOLO para
 *  qwen3:8b/qwen2.5-coder:7b en este equipo) para cualquier modelo. Quien la implementa (fuera de
 *  esta zona: `ModelManager`/`HardwareProbe`, packages/runtime/src/models) puede devolver 8k/16k/32k+
 *  según cuánta VRAM libre mida para ESE modelo puntual; acá solo se define la forma y cómo se
 *  consume. `undefined`: sin preferencia para ese modelo, usar el default de siempre. */
export type DefaultNumCtxFor = (model: ModelRef) => number | undefined;

/** Puntos de referencia de doc 07 §5 (columnas 16k/32k, "fuente de la columna vertebral") para
 *  `reserveForResponse`/`repoMapTokens` — los dos campos de `ContextPolicy` que `context/budgets.ts`
 *  NO reescala solo (`repoMapTokens` porque ya es un campo explícito, `reserveForResponse` porque es
 *  presupuesto de RESPUESTA, no de bloques de prompt). El tier de 8k es el MEDIDO de este equipo
 *  (`DEFAULT_CONTEXT_POLICY`, comentario de arriba); 16k/32k son `[HIPÓTESIS A PROBAR]` como ya
 *  aclara el propio doc 07 §5 para esas dos columnas. */
interface NumCtxTier { numCtx: number; reserveForResponse: number; repoMapTokens: number }
const NUM_CTX_TIERS: readonly NumCtxTier[] = [
  { numCtx: 8_192, reserveForResponse: 1_500, repoMapTokens: 1_000 },
  { numCtx: 16_384, reserveForResponse: 2_250, repoMapTokens: 1_750 },
  { numCtx: 32_768, reserveForResponse: 3_750, repoMapTokens: 3_500 },
];

function nearestNumCtxTier(numCtx: number): NumCtxTier {
  return NUM_CTX_TIERS.reduce((closest, tier) => (
    Math.abs(tier.numCtx - numCtx) < Math.abs(closest.numCtx - numCtx) ? tier : closest
  ));
}

/** `ContextPolicy` completa para un `numCtx` arbitrario: escala `reserveForResponse`/`repoMapTokens`
 *  proporcionalmente al tier de referencia más cercano (8k/16k/32k+, doc 07 §5) en vez de heredar
 *  ciegamente los valores tuneados para 8192 cuando el modelo pide otro tamaño — mismo criterio que
 *  `context/budgets.ts` (`scale()`), que ya interpola los bloques derivados (system/tools/memoria/
 *  margen) contra un baseline; acá se completa lo que ese módulo deja fuera a propósito. El resto de
 *  `ContextPolicy` (ratios, límites de tools de exploración) no depende del tamaño de `numCtx`. */
export function contextPolicyForNumCtx(numCtx: number, base: ContextPolicy = DEFAULT_CONTEXT_POLICY): ContextPolicy {
  if (numCtx === base.numCtx) return base;
  const tier = nearestNumCtxTier(numCtx);
  const scale = (value: number): number => Math.max(0, Math.round((value * numCtx) / tier.numCtx));
  return {
    ...base,
    numCtx,
    reserveForResponse: scale(tier.reserveForResponse),
    repoMapTokens: scale(tier.repoMapTokens),
  };
}

/** Preset del usuario (decisión del 2026-09-18): `balanced`, con `write` = allow dentro del
 *  workspace (ver permissions/engine.ts, `defaultForCategory`). Sin reglas persistidas de entrada. */
export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  preset: 'balanced',
  rules: [],
  terminalAllowlist: [],
};

export const DEFAULT_SYSTEM_PROMPT = [
  'Sos SaurioLLM, un asistente de programación que trabaja dentro del proyecto abierto por el usuario.',
  'Respondé siempre en español, con explicaciones cortas y concretas.',
  'Usá las tools disponibles para leer y modificar archivos en vez de suponer su contenido.',
  'Antes de editar un archivo, leelo. Cuando termines la tarea, llamá a la tool `finish`.',
  'No inventes rutas, funciones ni resultados de comandos: verificá con las tools.',
  // Doc 16 §4 ítem 6 ("agent: instrucción clara sobre old_string ambiguo"): sin esto, un modelo de
  // 7-8B tiende a repetir la misma llamada ambigua sin agregar contexto (hallazgo real del
  // 2026-09-18 con qwen3:8b, doc 16 §6, "el LoopDetector abortó el run"). `edit_file` ya devuelve
  // las coincidencias numeradas cuando falla por ambigüedad (packages/runtime/src/tools/matching.ts);
  // esta oración le dice al modelo qué hacer con esa información en vez de reintentar igual.
  'Si `edit_file` falla porque `old_string` es ambiguo (matchea más de una vez), no repitas la misma llamada: mirá las coincidencias numeradas que te devuelve el error y agregá más líneas de contexto (antes y/o después) al `old_string`, o usá `replace_all: true` si de verdad querés reemplazar todas las ocurrencias.',
].join('\n');

export function hashSystemPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

/** Las 10 builtins del MVP (doc 04 §4 BuiltinToolName). */
export const DEFAULT_ALLOWED_TOOLS = [
  'list_files', 'search_code', 'read_file', 'read_output', 'edit_file',
  'write_file', 'delete_file', 'run_command', 'task_update', 'finish',
];

/** Agente builtin que usa el MVP cuando el usuario todavía no creó ninguno (doc 03 §4.1,
 *  `agents.is_builtin = 1`). `workingDir` lo completa el host con la raíz del proyecto abierto.
 *  `defaultNumCtxFor` (doc 16, "numCtx efectivo") es opcional: sin él, `contextPolicy.numCtx` sigue
 *  siendo el literal de `DEFAULT_CONTEXT_POLICY` (8192, comportamiento previo a esta tarea) para
 *  cualquier modelo. Con él, se usa `contextPolicyForNumCtx()` para derivar una `ContextPolicy`
 *  completa (con `reserveForResponse`/`repoMapTokens` escalados al tier más cercano) a partir de lo
 *  que esa función devuelva para `model` — el resultado queda en `AgentConfig.contextPolicy.numCtx`,
 *  que `RunController.buildEffectiveConfig` copia tal cual a `EffectiveConfig.numCtx` (y de ahí a
 *  `run.effective_config_json`), así que un default por modelo queda "registrado en effective_config"
 *  sin ningún cambio adicional en el loop de ejecución. */
export function createDefaultAgentConfig(
  workingDir: string, model: ModelRef = DEFAULT_MODEL_REF, defaultNumCtxFor?: DefaultNumCtxFor,
): AgentConfig {
  const requestedNumCtx = defaultNumCtxFor?.(model);
  const contextPolicy = requestedNumCtx !== undefined && requestedNumCtx > 0
    ? contextPolicyForNumCtx(requestedNumCtx)
    : DEFAULT_CONTEXT_POLICY;
  return {
    id: DEFAULT_AGENT_ID,
    name: 'Saurio',
    role: 'lead',
    model,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    systemPromptHash: hashSystemPrompt(DEFAULT_SYSTEM_PROMPT),
    allowedTools: DEFAULT_ALLOWED_TOOLS,
    permissions: DEFAULT_PERMISSION_POLICY,
    workingDir,
    contextPolicy,
    memory: { readProjectMemory: true, writeProjectMemory: false },
    maxIterations: 25,
    temperature: 0.2,
    thinking: 'off',
    toolTransport: 'auto',
    defaultMode: 'agent',
  };
}
