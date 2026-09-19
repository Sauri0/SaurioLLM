// Context Management: presupuesto, compactación y ensamblado del prompt — packages/runtime/src/context/types.ts.
// Define: doc 04 §8. Solo interfaces/tipos (sin implementación). MVP: presupuesto a 16k, compactación
// nivel 0 y 2 (nivel 1 solo junto con nivel 2), lectura de SAURIO.md. Presupuesto a 32k y
// .saurio/rules/*.md son v0.2.
import type { ModelRef, ChatMessage, ContextBudgetReport, ContextInspection } from '@saurio/shared';
import type { AgentConfig } from '../agent/types.js';
import type { Mode } from '@saurio/shared';

export type { ContextBudgetReport };

export interface ContextBudget {
  numCtx: number; reserveForResponse: number;
  perBlock: { systemAndFewShot: number; toolDefs: number; repoMap: number; memoryAndTasks: number; history: number; margin: number };
}

export interface TokenCounter {
  estimate(text: string, kind: 'prose' | 'code' | 'json' | 'path'): number;
  calibrate(modelRef: ModelRef, estimated: number, measured: number): void;   // EMA sobre token_calibration
}

/** Alias documentado por la tarea de contratos (item 2: "TokenEstimator"); el doc 04 §8 lo nombra
 *  `TokenCounter` — ver deviations. */
export type TokenEstimator = TokenCounter;

export type ContextInspectionReason = NonNullable<ContextInspection['sources'][number]['reason']>;
export interface ContextInspectionInput {
  projectRoot: string;
  repoMapReason?: ContextInspectionReason;
  projectMemoryReason?: ContextInspectionReason;
  agentMemoryReason?: ContextInspectionReason;
  attachmentsKnown: boolean;
  attachments: ContextInspection['attachments'];
  /** Mensaje que aportó los adjuntos de este envío. Sólo vive en el run; no se persiste en el
   * inspector. Permite marcar los adjuntos como excluidos si ese mensaje ya no llegó al prompt. */
  attachmentMessageId?: string;
}

export interface CompactionResult {
  level: 0 | 1 | 2;
  summaryMessage?: ChatMessage;              // nivel 2: schema { objetivo, archivos_tocados[], decisiones[], ... }
  replacedMessageIds: string[];              // reciben compacted_by; nunca se borran
  tokensBefore: number; tokensAfter: number;
  /** Agregado en esta tarea (doc 16 §4 ítem 5, doc 07 §7.2 "assemble"): el historial resultante que
   *  reemplaza a `history` en el prefijo — `[summaryMessage?, ...recientes-con-stubs]`. Sin esto,
   *  quien llama a `compact()` no puede reconstruir el prompt cuando el "Plan B" de nivel 1 puro
   *  (doc 07 §7.3) no devuelve `summaryMessage`: los stubs de nivel 1 se calculaban adentro de
   *  `compact()` y se perdían al salir. */
  historyAfter: ChatMessage[];
}

export interface Compactor {
  shouldCompact(usedTokens: number, budget: ContextBudget, turnsSinceLast: number, policy: AgentConfig['contextPolicy']): boolean;
  compact(history: ChatMessage[], policy: AgentConfig['contextPolicy'], model: ModelRef): Promise<CompactionResult>;
}

/** Habla con el ProjectIndexer (utilityProcess); nunca construye el árbol tree-sitter en main. */
export interface RepoMapClient {
  build(projectRoot: string, opts: { budgetTokens: number; mentioned: string[]; touched: string[] }): Promise<{ text: string; tokens: number }>;
  invalidate(changedFiles: string[]): void;
}

/** Entrada común a `willCompact`/`build`, factoreada para no repetirla (doc 16 §4 ítem 5: agregado
 *  `turnsSinceCompaction` para el disparador por cantidad de turnos de doc 07 §7.1 punto 2, y
 *  `toolsText` para que `ContextBudgetReport.used.tools` deje de ser siempre 0 — antes `build()` no
 *  recibía nada de las definiciones de tools, que las antepone `ToolProtocol` fuera de este módulo). */
export interface ContextBuilderInputBase {
  agent: AgentConfig; mode: Mode; history: ChatMessage[]; repoMap: string; projectMemory?: string;
  /** Memorias recuperadas para ESTE agente/proyecto por el adaptador autorizado. Es un bloque
   * distinto de `projectMemory`/`SAURIO.md`: conserva procedencia y se presenta como datos, no instrucciones. */
  agentMemory?: string;
  /** Texto ya serializado de las definiciones de tools de este turno (JSON Schema o el bloque de
   *  texto del transporte Hermes); se estima como tokens 'json' para `report.used.tools`. Opcional:
   *  sin esto, `used.tools` sigue en 0 (comportamiento previo, documentado como límite conocido). */
   toolsText?: string;
  /** Turnos transcurridos desde la última compactación (doc 07 §7.1 punto 2: dispara cada
   *  `compactEveryTurns` aunque el ratio de tokens nunca se cruce). Quien orquesta el loop
   *  (RunController) es quien puede contar turnos; por eso viaja como input en vez de vivir acá. */
  turnsSinceCompaction?: number;
  /** Doc 07 §7.1 ("nunca dispara durante un reintento de formato"): al `false`, ni `willCompact` ni
   *  `build` disparan compactación en esta llamada puntual, sin importar el ratio de tokens ni
   *  `turnsSinceCompaction`. Default `true` (comportamiento previo si se omite). */
  allowCompaction?: boolean;
  /** numCtx REAL que va a viajar al provider en esta request, ya confirmado/capeado por el host.
   *  Cuando difiere de `agent.contextPolicy.numCtx`, ContextBuilder deriva una policy completa para
   *  este valor y la usa para compactación, poda, reserva y reporte; no es sólo una etiqueta de UI. */
  effectiveNumCtx?: number;
  /** Punto 3 del encargo: bloque de entorno real (carpeta de trabajo, SO, shell) que se concatena
   *  al final de `agent.systemPrompt` (antes del sufijo de modo plan). Ver
   *  `agent/environmentPrompt.ts`. Opcional/aditivo: sin esto, el system message queda igual que
   *  antes de esta tarea. */
  environmentInfo?: string;
  /** Metadata segura para el inspector: estados y nombres, nunca contenido completo. */
  inspection?: ContextInspectionInput;
}

/** Ensamblador del prompt: system inmutable -> few-shot -> repo map -> memoria -> resumen ->
 *  historial -> mensaje efímero final. Garantiza tokens <= numCtx - reserveForResponse. */
export interface ContextBuilder {
  /** Doc 16 §4 ítem 5: permite a quien orquesta el loop (RunController) saber, ANTES de llamar a
   *  `build()`, si esta vuelta va a compactar — así puede emitir la transición `run.state ->
   *  'compacting'` (doc 05 §1) alrededor de la llamada real, que en `build()` puede tardar (nivel 2
   *  le pide un resumen al modelo, doc 07 §7.2 "corrección sobre slots de inferencia": esa llamada
   *  ocupa un slot de inferencia real). Usa la misma heurística que `build()` aplicará a
   *  continuación; llamado sin efectos secundarios. */
  willCompact(input: Pick<ContextBuilderInputBase, 'agent' | 'history' | 'turnsSinceCompaction' | 'allowCompaction' | 'effectiveNumCtx'>): boolean;
  build(input: ContextBuilderInputBase): Promise<{
    messages: ChatMessage[];
    report: ContextBudgetReport;
    /** Presente solo si esta llamada compactó (doc 16 §4 ítem 5: "que build() informe si
     *  compactó"). RunController usa esto para emitir `context.compacted` con datos reales en vez
     *  de nunca emitirlo. */
    compaction?: CompactionResult;
  }>;
}
