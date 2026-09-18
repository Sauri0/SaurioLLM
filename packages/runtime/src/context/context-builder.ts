// ContextBuilder: arma el prompt con prefijo estable y garantiza tokens <= numCtx - reserveForResponse
// — packages/runtime/src/context/context-builder.ts.
// Define: doc 07-context-manager.md §4 (orden fijo del prefijo), §7 (disparador y algoritmo de
// compactación) y doc 04 §8 (interfaz `ContextBuilder`, en ./types.ts). Orden: system inmutable ->
// few-shot -> primer user (repo map + SAURIO.md) -> resumen de compactación (si compactó esta vuelta)
// -> historial -> mensaje efímero final.
//
// Cambios de esta tarea (doc 16 §4 ítem 5, "Emitir estado compacting y evento context.compacted
// cuando el ContextBuilder compacta"): antes `build()` no disparaba compactación ni la reportaba —
// el disparador vivía documentado en doc 07 §7.1 pero sin dueño en código, y `ContextBuilder.build`
// no tenía forma de decirle a quien la llama si compactó. Ahora `DefaultContextBuilder` recibe un
// `Compactor` opcional (mismo del módulo, compactor.ts) y:
//   (a) expone `willCompact()` para que el `RunController` pueda emitir la transición de estado
//       `-> compacting` ANTES de la llamada real (que puede tardar: nivel 2 le pide un resumen al
//       modelo, doc 07 §7.2, y esa llamada ocupa un slot de inferencia real);
//   (b) `build()` aplica la compactación si corresponde y devuelve `compaction` con el resultado,
//       para que el llamador emita `context.compacted` con datos reales (antes: nunca se emitía).
// También agrega `used.tools` real (antes hardcodeado a 0: `build()` no recibía nada de las
// definiciones de tools) y la regla "[respuesta cortada]" de doc 07 §4.5 para mensajes con
// `ChatMessage.truncated` que entran al prompt de un run que no es el que los generó (ver
// `context-builder.test.ts` y RunController: el reintento inmediato del mismo turno nunca llega a
// pushear ese mensaje a `history`, así que esta regla solo se ejercita en `run:continue`).
import type { ChatMessage, ContextBudgetReport } from '@saurio/shared';
import type { ContextBuilder, ContextBuilderInputBase, TokenCounter, Compactor, CompactionResult } from './types.js';
import { computeBudget } from './budgets.js';

const SYSTEM_MESSAGE_ID = 'system';
const PROJECT_INTRO_ID = 'project-intro';
const TRUNCATED_PREFIX = '[respuesta cortada] ';

function buildProjectIntroMessage(repoMap: string, projectMemory: string | undefined): ChatMessage {
  const parts = [repoMap.trim()];
  if (projectMemory !== undefined && projectMemory.trim().length > 0) {
    parts.push(`# SAURIO.md\n${projectMemory.trim()}`);
  }
  return { id: PROJECT_INTRO_ID, role: 'user', content: parts.join('\n\n') };
}

/** Separa los mensajes `ephemeral: true` (van siempre al final, nunca se persisten — doc 07 §4.2). */
function splitEphemeral(history: ChatMessage[]): { rest: ChatMessage[]; ephemeral: ChatMessage[] } {
  const rest: ChatMessage[] = [];
  const ephemeral: ChatMessage[] = [];
  for (const message of history) {
    if (message.ephemeral === true) ephemeral.push(message);
    else rest.push(message);
  }
  return { rest, ephemeral };
}

/** Doc 07 §4.5: un mensaje `truncated` que sigue viajando en `history` (no es el reintento
 *  inmediato del mismo turno — ese caso nunca llega a `history`, ver RunController.streamChat) se
 *  antepone con la marca fija, sin mutar el mensaje persistido original. */
function applyTruncatedMark(message: ChatMessage): ChatMessage {
  if (!message.truncated) return message;
  if (message.content.startsWith(TRUNCATED_PREFIX)) return message;
  return { ...message, content: `${TRUNCATED_PREFIX}${message.content}` };
}

function estimateHistoryTokens(counter: TokenCounter, messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + counter.estimate(m.content, 'prose'), 0);
}

export class DefaultContextBuilder implements ContextBuilder {
  constructor(
    private readonly tokenCounter: TokenCounter,
    private readonly compactor?: Compactor,
  ) {}

  willCompact(input: Pick<ContextBuilderInputBase, 'agent' | 'history' | 'turnsSinceCompaction' | 'allowCompaction'>): boolean {
    if (!this.compactor || input.allowCompaction === false) return false;
    const { rest } = splitEphemeral(input.history);
    const budget = computeBudget(input.agent.contextPolicy);
    const usedTokens = estimateHistoryTokens(this.tokenCounter, rest);
    return this.compactor.shouldCompact(usedTokens, budget, input.turnsSinceCompaction ?? 0, input.agent.contextPolicy);
  }

  async build(input: ContextBuilderInputBase): Promise<{
    messages: ChatMessage[]; report: ContextBudgetReport; compaction?: CompactionResult;
  }> {
    const { agent, mode, history, repoMap, projectMemory, toolsText } = input;
    const budget = computeBudget(agent.contextPolicy);

    // Doc 16 §4 ítem 6 ("plan mode: instrucción explícita de task_update + finish"): el modo ya
    // filtra qué tools ve el modelo (doc 06 §1), pero eso no le dice qué HACER con ellas; sin esta
    // instrucción el modelo de 7-8B suele llamar `finish` directo con el plan en el resumen de texto
    // en vez de dejarlo como checklist estructurado en `tasks` (doc 05 §2.9 paso 35). Se agrega como
    // sufijo del system message (nunca cambia dentro del run, doc 07 §4.2 prefijo estable) en vez de
    // como mensaje efímero, porque debe estar presente desde el primer turno del modo plan.
    const modeSuffix = mode === 'plan'
      ? '\n\nEstás en modo PLAN: antes de llamar a `finish`, llamá a `task_update` con el checklist completo de pasos del plan (uno por tarea, estado inicial "pending"). Recién después llamá a `finish` con el resumen. No edites ni ejecutes nada.'
      : '';
    const systemMessage: ChatMessage = { id: SYSTEM_MESSAGE_ID, role: 'system', content: `${agent.systemPrompt}${modeSuffix}` };
    const fewShot: ChatMessage[] = []; // ver nota de alcance histórica: sin fuente real de few-shot en el MVP
    const projectIntro = buildProjectIntroMessage(repoMap, projectMemory);
    const { rest: restHistory, ephemeral } = splitEphemeral(history);

    // Compactación (doc 07 §7.1/§7.2): se evalúa antes de armar el prompt final. `willCompact` usa
    // la misma heurística; se recalcula acá por si el llamador no la invocó antes (build() debe
    // seguir siendo correcto por sí solo, `willCompact` es una optimización de UX del estado, no un
    // requisito para que build() compacte).
    let compaction: CompactionResult | undefined;
    let effectiveHistory = restHistory;
    if (this.compactor && input.allowCompaction !== false) {
      const usedTokens = estimateHistoryTokens(this.tokenCounter, restHistory);
      const shouldCompact = this.compactor.shouldCompact(
        usedTokens, budget, input.turnsSinceCompaction ?? 0, agent.contextPolicy,
      );
      if (shouldCompact) {
        compaction = await this.compactor.compact(restHistory, agent.contextPolicy, agent.model);
        effectiveHistory = compaction.historyAfter;
      }
    }

    // Doc 07 §4.5: marca "[respuesta cortada]" sobre mensajes truncated que sobreviven a este punto
    // (un run:continue los reincorpora desde `messages.listByChat`; el reintento inmediato del mismo
    // turno nunca los agrega a `history` — ver RunController.streamChat).
    effectiveHistory = effectiveHistory.map(applyTruncatedMark);

    const assemble = (): ChatMessage[] => [systemMessage, ...fewShot, projectIntro, ...effectiveHistory, ...ephemeral];

    const totalBudget = Math.max(0, budget.numCtx - budget.reserveForResponse);
    const toolsTokens = toolsText ? this.tokenCounter.estimate(toolsText, 'json') : 0;

    // Última red de seguridad (doc 07 §1: "nunca se manda más que numCtx − reserveForResponse"):
    // si incluso después de compactar sigue sin entrar, se van podando los mensajes más viejos del
    // historial (nunca el system, el repo map ni el efímero).
    const fixedTokens =
      this.tokenCounter.estimate(systemMessage.content, 'prose')
      + fewShot.reduce((sum, m) => sum + this.tokenCounter.estimate(m.content, 'prose'), 0)
      + this.tokenCounter.estimate(projectIntro.content, 'code')
      + toolsTokens
      + ephemeral.reduce((sum, m) => sum + this.tokenCounter.estimate(m.content, 'prose'), 0);

    let historyTokens = estimateHistoryTokens(this.tokenCounter, effectiveHistory);
    while (fixedTokens + historyTokens > totalBudget && effectiveHistory.length > 0) {
      effectiveHistory = effectiveHistory.slice(1);
      historyTokens = estimateHistoryTokens(this.tokenCounter, effectiveHistory);
    }

    const totalUsed = fixedTokens + historyTokens;
    const report: ContextBudgetReport = {
      numCtx: budget.numCtx,
      reserveForResponse: budget.reserveForResponse,
      used: {
        system: this.tokenCounter.estimate(systemMessage.content, 'prose'),
        tools: toolsTokens,
        repoMap: this.tokenCounter.estimate(repoMap, 'code'),
        memory: projectMemory !== undefined ? this.tokenCounter.estimate(projectMemory, 'prose') : 0,
        history: historyTokens,
      },
      totalUsed,
      fits: totalUsed <= totalBudget,
    };

    return { messages: assemble(), report, compaction };
  }
}

export function createContextBuilder(tokenCounter: TokenCounter, compactor?: Compactor): ContextBuilder {
  return new DefaultContextBuilder(tokenCounter, compactor);
}
