// Compactor: niveles 0 (defensivo, en ingestión), 1 (stubs de tool results) y 2 (resumen estructurado)
// — packages/runtime/src/context/compactor.ts.
// Define: doc 07-context-manager.md §7 (algoritmo, disparador, Plan B) y doc 04 §8 (interfaz `Compactor`,
// en ./types.ts, no se modifica). MVP: niveles 1+2 en una sola pasada (nunca nivel 1 solo salvo el Plan B
// de §7.3 cuando el resumen falla); nivel 0 (truncado de resultados de tool) ocurre normalmente en el
// momento en que la tool genera su resultado (packages/runtime/src/tools, fuera de esta tarea) — acá se
// expone `truncateOnIngestion` como red de seguridad defensiva descripta en el encargo de la tarea, por
// si un mensaje entra al historial sin haber pasado por ese recorte.
import type { ChatMessage, ModelRef } from '@saurio/shared';
import type { ContextPolicy } from '../agent/types.js';
import type { Compactor, CompactionResult, ContextBudget } from './types.js';
import type { TokenCounter } from './types.js';
import type { Summarizer } from './summarizer.js';

const DEFAULT_INGESTION_CHAR_LIMIT = 30_000; // doc 07 §6: piso de persistencia a tool-outputs/<id>.txt

/** Nivel 0 defensivo (doc de la tarea, "Compactor: nivel 0"): recorta el `content` de un mensaje
 *  recién ingresado si por algún motivo llegó sin pasar por el truncado de la tool (doc 07 §6). No
 *  reemplaza el truncado real de cada tool — es un piso de seguridad, documentado como tal. */
export function truncateOnIngestion(
  message: ChatMessage,
  maxChars = DEFAULT_INGESTION_CHAR_LIMIT,
): ChatMessage {
  if (message.content.length <= maxChars) return message;
  const head = message.content.slice(0, maxChars);
  return {
    ...message,
    content: `${head}\n[… contenido recortado en ingestión, ${message.content.length} caracteres originales …]`,
  };
}

function isToolBearing(message: ChatMessage): boolean {
  return message.role === 'tool' || message.toolCallId !== undefined;
}

/** "editado src/a.ts: +12 −3" cuando se puede inferir del `toolName`; genérico en el resto de los
 *  casos (doc 07 §6, última fila de la tabla, y §7.2 "reducir_a_stub"). */
function reduceToStub(message: ChatMessage): ChatMessage {
  const label = message.toolName ?? 'tool';
  return {
    ...message,
    content: `[resultado de ${label} reducido en compactación de nivel 1]`,
    toolCalls: undefined,
    images: undefined,
    thinking: undefined,
  };
}

function estimateTotalTokens(counter: TokenCounter, messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + counter.estimate(m.content, 'prose'), 0);
}

export class DefaultCompactor implements Compactor {
  constructor(
    private readonly tokenCounter: TokenCounter,
    private readonly summarizer: Summarizer,
  ) {}

  shouldCompact(
    usedTokens: number,
    budget: ContextBudget,
    turnsSinceLast: number,
    policy: ContextPolicy,
  ): boolean {
    const historyBudget = budget.perBlock.history;
    const byRatio = historyBudget > 0 && usedTokens > policy.compactAtRatio * historyBudget;
    const byTurnCount = turnsSinceLast >= policy.compactEveryTurns;
    return byRatio || byTurnCount;
  }

  async compact(history: ChatMessage[], policy: ContextPolicy, model: ModelRef): Promise<CompactionResult> {
    const keepLastTurns = Math.max(0, policy.keepLastTurns);
    const splitIndex = Math.max(0, history.length - keepLastTurns);
    const candidates = history.slice(0, splitIndex);
    const tokensBefore = estimateTotalTokens(this.tokenCounter, history);

    if (candidates.length === 0) {
      // Nada que compactar todavía (historial más corto que `keepLastTurns`): no-op de nivel 1.
      return { level: 1, replacedMessageIds: [], tokensBefore, tokensAfter: tokensBefore, historyAfter: history };
    }

    // Nivel 1: reduce a stub cualquier mensaje de tool result viejo (doc 07 §7.2, primer bloque).
    const level1Candidates = candidates.map((m) => (isToolBearing(m) ? reduceToStub(m) : m));

    // Nivel 2: resumen estructurado con el mismo modelo del run (doc 07 §7.2/§7.3).
    try {
      const summary = await this.summarizer.summarize({ candidates: level1Candidates, model });
      const summaryMessage: ChatMessage = {
        id: `compaction-summary-${Date.now()}`,
        role: 'user',
        content: JSON.stringify(summary),
      };
      const reciente = history.slice(splitIndex);
      const tokensAfter = estimateTotalTokens(this.tokenCounter, [summaryMessage, ...reciente]);
      return {
        level: 2,
        summaryMessage,
        replacedMessageIds: candidates.map((m) => m.id),
        tokensBefore,
        tokensAfter,
        historyAfter: [summaryMessage, ...reciente],
      };
    } catch {
      // Plan B (doc 07 §7.3): el `format` falló repetidamente -> se degrada a nivel 1 puro, sin
      // resumen. El historial igual se reduce (los tool results viejos quedan en stub).
      const reciente = history.slice(splitIndex);
      const tokensAfter = estimateTotalTokens(this.tokenCounter, [...level1Candidates, ...reciente]);
      return {
        level: 1,
        replacedMessageIds: candidates.map((m) => m.id),
        tokensBefore,
        tokensAfter,
        historyAfter: [...level1Candidates, ...reciente],
      };
    }
  }
}

export function createCompactor(tokenCounter: TokenCounter, summarizer: Summarizer): Compactor {
  return new DefaultCompactor(tokenCounter, summarizer);
}
