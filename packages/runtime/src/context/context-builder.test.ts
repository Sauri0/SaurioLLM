// Tests de ContextBuilder con mensajes sintéticos (doc de la tarea: "presupuesto respetado, prefijo
// estable entre turnos") — packages/runtime/src/context/context-builder.test.ts.
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@saurio/shared';
import { createTokenEstimator } from './token-estimator.js';
import { createContextBuilder } from './context-builder.js';
import { createCompactor } from './compactor.js';
import type { Summarizer, CompactionSummary } from './summarizer.js';
import { makeAgentConfig, makeContextPolicy, makeSyntheticHistory } from './test-fixtures.js';

const FIXED_SUMMARY: CompactionSummary = {
  objetivo: 'probar compactación real desde ContextBuilder', archivos_tocados: [], decisiones: [],
  descubrimientos: [], pendientes: [], ultimo_error: null,
};

function makeFakeSummarizer(): Summarizer {
  return { summarize: async () => FIXED_SUMMARY };
}

describe('context/ContextBuilder', () => {
  it('respeta el presupuesto: tokens <= numCtx - reserveForResponse', async () => {
    const policy = makeContextPolicy({ numCtx: 4_096, reserveForResponse: 512, repoMapTokens: 300 });
    const agent = makeAgentConfig({ contextPolicy: policy });
    const tokenCounter = createTokenEstimator(agent.model);
    const builder = createContextBuilder(tokenCounter);

    // Historial deliberadamente grande para forzar la poda defensiva de ContextBuilder.
    const history = makeSyntheticHistory(200);
    const { report } = await builder.build({
      agent, mode: 'agent', history, repoMap: 'src/index.ts:\n│ export const main\n', projectMemory: 'usamos pnpm',
    });

    expect(report.totalUsed).toBeLessThanOrEqual(policy.numCtx - policy.reserveForResponse);
    expect(report.fits).toBe(true);
  });

  it('arma el prefijo en el orden documentado: system -> repo map+memoria -> historial -> efímero', async () => {
    const agent = makeAgentConfig();
    const tokenCounter = createTokenEstimator(agent.model);
    const builder = createContextBuilder(tokenCounter);
    const history = [
      { id: 'user-1', role: 'user' as const, content: 'hola' },
      { id: 'assistant-1', role: 'assistant' as const, content: 'hola, ¿en qué ayudo?' },
      { id: 'ephemeral-1', role: 'user' as const, content: 'recordatorio final', ephemeral: true },
    ];

    const { messages } = await builder.build({
      agent, mode: 'agent', history, repoMap: 'src/a.ts:\n│ export const a\n', projectMemory: 'nota',
    });

    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.id).toBe('project-intro');
    expect(messages[1]?.content).toContain('src/a.ts');
    expect(messages[1]?.content).toContain('SAURIO.md');
    expect(messages.at(-1)?.ephemeral).toBe(true);
  });

  it('mantiene el prefijo estable entre dos turnos consecutivos cuando no cambia el system/repo map', async () => {
    const agent = makeAgentConfig();
    const tokenCounter = createTokenEstimator(agent.model);
    const builder = createContextBuilder(tokenCounter);
    const repoMap = 'src/a.ts:\n│ export const a\n';
    const projectMemory = 'nota fija';

    const historyTurn1 = [{ id: 'user-1', role: 'user' as const, content: 'primer mensaje' }];
    const { messages: turn1 } = await builder.build({
      agent, mode: 'agent', history: historyTurn1, repoMap, projectMemory,
    });

    const historyTurn2 = [
      ...historyTurn1,
      { id: 'assistant-1', role: 'assistant' as const, content: 'respuesta' },
      { id: 'user-2', role: 'user' as const, content: 'segundo mensaje' },
    ];
    const { messages: turn2 } = await builder.build({
      agent, mode: 'agent', history: historyTurn2, repoMap, projectMemory,
    });

    // El prefijo (system + repo map/memoria) debe ser byte a byte idéntico entre turnos (doc 07 §4.2).
    expect(turn2[0]).toEqual(turn1[0]);
    expect(turn2[1]).toEqual(turn1[1]);
    // Y el historial previo del turno 1 debe aparecer, sin modificar, dentro del turno 2 (append-only).
    expect(turn2[2]).toEqual(turn1[2]);
  });

  it('used.tools refleja toolsText en vez de quedar hardcodeado en 0 (doc 16 §4 ítem 5)', async () => {
    const agent = makeAgentConfig();
    const tokenCounter = createTokenEstimator(agent.model);
    const builder = createContextBuilder(tokenCounter);
    const toolsText = JSON.stringify([{ type: 'function', function: { name: 'read_file', description: 'x', parameters: {} } }]);

    const { report } = await builder.build({
      agent, mode: 'agent', history: [], repoMap: 'src/a.ts:\n│ export const a\n', toolsText,
    });

    expect(report.used.tools).toBeGreaterThan(0);
  });

  it('modo plan agrega la instrucción de task_update + finish al system prompt (doc 16 §4 ítem 6)', async () => {
    const agent = makeAgentConfig();
    const tokenCounter = createTokenEstimator(agent.model);
    const builder = createContextBuilder(tokenCounter);

    const { messages: planMessages } = await builder.build({ agent, mode: 'plan', history: [], repoMap: '' });
    const { messages: agentMessages } = await builder.build({ agent, mode: 'agent', history: [], repoMap: '' });

    expect(planMessages[0]?.content).toContain('task_update');
    expect(planMessages[0]?.content).toContain('finish');
    expect(agentMessages[0]?.content).not.toContain('modo PLAN');
  });

  it('antepone "[respuesta cortada]" a un mensaje truncated que sigue en el historial (doc 07 §4.5)', async () => {
    const agent = makeAgentConfig();
    const tokenCounter = createTokenEstimator(agent.model);
    const builder = createContextBuilder(tokenCounter);
    const history: ChatMessage[] = [
      { id: 'user-1', role: 'user', content: 'segui con la tarea' },
      { id: 'assistant-cut', role: 'assistant', content: 'estaba por term', truncated: true },
    ];

    const { messages } = await builder.build({ agent, mode: 'agent', history, repoMap: '' });
    const cutMessage = messages.find((m) => m.id === 'assistant-cut');

    expect(cutMessage?.content.startsWith('[respuesta cortada]')).toBe(true);
  });

  it('willCompact()/build() compactan con un Compactor real, persisten historyAfter y devuelven `compaction`', async () => {
    const agent = makeAgentConfig({ contextPolicy: makeContextPolicy({ keepLastTurns: 1, compactEveryTurns: 1 }) });
    const tokenCounter = createTokenEstimator(agent.model);
    const compactor = createCompactor(tokenCounter, makeFakeSummarizer());
    const builder = createContextBuilder(tokenCounter, compactor);
    const history = makeSyntheticHistory(5); // 15 mensajes, bastante para dejar candidatos

    const willCompact = builder.willCompact({ agent, history, turnsSinceCompaction: 1 });
    expect(willCompact).toBe(true);

    const { messages, compaction } = await builder.build({ agent, mode: 'agent', history, repoMap: '', turnsSinceCompaction: 1 });

    expect(compaction).toBeDefined();
    expect(compaction?.summaryMessage?.content).toContain('probar compactación real');
    expect(compaction?.historyAfter.length).toBeLessThan(history.length);
    // El resumen debe aparecer en el prompt ensamblado, en la posición fija tras el repo map (doc 07 §7.4).
    expect(messages.some((m) => m.id === compaction?.summaryMessage?.id)).toBe(true);
  });

  it('willCompact()/build() con allowCompaction: false nunca disparan (doc 07 §7.1, reintento de formato)', async () => {
    const agent = makeAgentConfig({ contextPolicy: makeContextPolicy({ keepLastTurns: 1, compactEveryTurns: 1 }) });
    const tokenCounter = createTokenEstimator(agent.model);
    const compactor = createCompactor(tokenCounter, makeFakeSummarizer());
    const builder = createContextBuilder(tokenCounter, compactor);
    const history = makeSyntheticHistory(5);

    expect(builder.willCompact({ agent, history, turnsSinceCompaction: 1, allowCompaction: false })).toBe(false);
    const { compaction } = await builder.build({ agent, mode: 'agent', history, repoMap: '', turnsSinceCompaction: 1, allowCompaction: false });
    expect(compaction).toBeUndefined();
  });
});
