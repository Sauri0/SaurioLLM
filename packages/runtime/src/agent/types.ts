// Agent Runtime: configuración, run y máquina de estados — packages/runtime/src/agent/types.ts.
// Define: doc 04 §5. Solo interfaces/tipos (sin implementación). MVP salvo `fileScope` (v0.4) y
// `parentRunId` con delegación real (v0.4; existe desde el día 1 por costo de migración, principio 8).
// Adjustment/RunError/ToolCallRecord tienen su schema zod en @saurio/shared (domain.ts) porque
// cruzan IPC/RunEvent — doc 02 §3.
import type {
  RunState, ModelRef, AgentRole, Mode, ToolTransport, Adjustment, RunError, ToolCallRecord,
} from '@saurio/shared';
import type { ChatRequest } from '../gateway/types.js';
import type { PermissionPolicy } from '../permissions/types.js';

export type { Adjustment, RunError, ToolCallRecord };

export interface ContextPolicy {
  numCtx: number; reserveForResponse: number; repoMapTokens: number; historyBudgetRatio: number;
  maxReadLines: number; maxSearchResults: number; maxCommandLines: number;
  compactAtRatio: number; compactEveryTurns: number; keepLastTurns: number;
  fewShot: boolean;
}

export interface AgentConfig {
  id: string; name: string; role: AgentRole; model: ModelRef;
  systemPrompt: string; systemPromptHash: string;
  allowedTools: string[]; permissions: PermissionPolicy;
  workingDir: string; contextPolicy: ContextPolicy;
  memory: { readProjectMemory: boolean; writeProjectMemory: boolean };
  maxIterations: number; temperature: number; thinking: 'off' | 'on' | 'auto';
  toolTransport: 'auto' | 'native' | 'text'; defaultMode: Mode;
  profileId?: string;
  fileScope?: string;          // v0.4: restringe el agente a un subárbol del proyecto
}

/** Congelada al iniciar el run (regla 4: prefijo estable); nunca cambia dentro del mismo run. */
export interface EffectiveConfig {
  model: ModelRef; numCtx: number; think: ChatRequest['think']; tools: string[];
  transport: ToolTransport; promptHash: string; profileId?: string; adjustments: Adjustment[];
}

/** Ver doc 04, Nomenclatura agregada: "Session" del brief = Chat + Run; Run es la ejecución
 *  concreta, Chat es el contenedor persistente donde viven varios runs en el tiempo. */
export interface Run {
  id: string; chatId: string; parentRunId?: string;      // parentRunId: subagentes, v0.4
  agent: AgentConfig; mode: Mode; state: RunState; iteration: number;
  effectiveConfig: EffectiveConfig;
}

/** Transiciones válidas de la máquina de estados (columna §12); usado para validar en tiempo de
 *  ejecución y para generar el diagrama de estados sin duplicar la lista a mano.
 *  Doc 04, Desvíos §1: `interrupted` es terminal (sin salidas); solo `recover()` puede llevar
 *  a un run a `interrupted` desde los estados marcados "solo recover()". */
export const RUN_TRANSITIONS: Record<RunState, RunState[]> = {
  created: ['preparing', 'interrupted'],             // 'interrupted' solo la emite recover()
  preparing: ['queued', 'failed', 'interrupted'],     // 'interrupted' solo la emite recover()
  queued: ['generating', 'compacting', 'cancelling', 'failed', 'interrupted'],           // 'interrupted' solo la emite recover(); 'compacting': doc 07 §7.1, el disparador se evalúa al armar el contexto en 'queued', antes de generar (doc 16 §4 ítem 5 — arista agregada, antes solo existía la de executing_tool)
  generating: ['parsing', 'cancelling', 'failed', 'interrupted'],          // 'interrupted' solo la emite recover()
  // 'queued': doc 05 §2.5 pasos 23-25 (reintento de parseo, "elegí una tool o llamá a finish",
  // permiso denegado) vuelven a encolar el turno sin pasar por executing_tool; antes esto se hacía
  // con un bypass fuera de RUN_TRANSITIONS (returnToQueue) porque la arista no existía acá. Doc 16
  // §4 ítem 7: se agrega la arista real y se elimina el bypass en RunController.
  parsing: ['completed', 'awaiting_permission', 'executing_tool', 'queued', 'cancelling', 'failed', 'interrupted'],  // 'interrupted' solo la emite recover()
  awaiting_permission: ['executing_tool', 'parsing', 'cancelling', 'failed'],  // 'failed': chat/proyecto borrado mientras se esperaba respuesta
  executing_tool: ['compacting', 'queued', 'cancelling', 'failed', 'interrupted'],  // 'interrupted' solo la emite recover()
  compacting: ['queued', 'cancelling', 'failed', 'interrupted'],    // 'interrupted' solo la emite recover(); 'cancelling': doc 10 §2 lista esta arista (compacting es un estado activo más, doc 07 §7.2 "corrección sobre slots" — ocupa un slot real y por lo tanto debe poder cancelarse igual que 'generating')
  cancelling: ['cancelled'],
  completed: [], cancelled: [], failed: [], interrupted: [], // terminal; run:continue crea un run nuevo en 'created'
};

/** El RunController orquesta ContextManager, ToolSystem, PermissionEngine, CheckpointService,
 *  TaskManager y ModelGateway; ver flujo completo en la columna §6. Firma resumida: */
export interface RunController {
  start(chatId: string, text: string, mode: Mode): Promise<{ runId: string }>;
  cancel(runId: string): Promise<void>;
  continueRun(runId: string, extraIterations?: number): Promise<{ runId: string }>;   // crea un run nuevo
  recover(): Promise<{ orphaned: ToolCallRecord[]; abandoned: ToolCallRecord[] }>;      // al arrancar la app
}
