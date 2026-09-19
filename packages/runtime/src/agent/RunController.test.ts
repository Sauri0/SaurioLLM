// Tests de RunController (doc 05 flujo completo, doc 10 fallos y recuperación) con fakes de todas
// las dependencias inyectadas (gateway, tools, permisos, checkpoint, contexto, persistencia).
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatAgentMemoryForContext, RunController, type RunControllerDeps } from './RunController.js';
import type { ChatChunk, ChatRequest, ModelGateway } from '../gateway/types.js';
import type { AgentCreateInput, AgentMemory, AgentOwnerKind, AgentProfile, ChatMessage, RunEvent } from '@saurio/shared';
import { DelegationResultSchema } from '@saurio/shared';
import type { PermissionDecision, PermissionEngine } from '../permissions/types.js';
import type { ContextBuilder } from '../context/types.js';
import type { ToolDefinition, ToolProtocol } from '../tools/types.js';
import type { AgentConfigResolver, AgentProfilePort } from './ports.js';
import {
  makeFakeClock, makeFakeIds, makeFakeEventStore, makeFakeRunRepository, makeFakeChatRepository,
  makeFakeMessageRepository, makeFakeToolCallRepository, makeFakeCheckpointRepository,
  makeFakeTaskRepository, makeFakeContextBuilder, makeFakeCheckpointService, makeScriptedGateway,
  makeFakeToolRegistry, makeNativeToolProtocol, makeAllowAllPermissionEngine,
  makeAskThenRecordPermissionEngine, makeRecordingPermissionEngine, makeFinishTool, makeEditFileTool, makeListFilesTool,
  makeTestAgentConfig, makeFakeAgentConfigResolver, makeTestChat, waitUntil,
} from './testSupport.js';
import { DefaultTaskManager } from '../tasks/TaskManager.js';
import { createContextBuilder, createTokenEstimator } from '../context/index.js';
import { contextPolicyForNumCtx } from './defaults.js';
import { WorkspaceFsImpl } from '../tools/WorkspaceFs.js';
import { createTextToolProtocol } from '../tools/protocols/text.js';
import { ModelGatewayImpl } from '../gateway/ModelGateway.js';
import type { Provider } from '../gateway/Provider.js';

function baseDeps(overrides: Partial<RunControllerDeps> = {}): { deps: RunControllerDeps; runs: ReturnType<typeof makeFakeRunRepository> } {
  const clock = makeFakeClock();
  const ids = makeFakeIds();
  const events = makeFakeEventStore();
  const runs = makeFakeRunRepository();
  const chats = makeFakeChatRepository([makeTestChat()]);
  const messages = makeFakeMessageRepository();
  const toolCalls = makeFakeToolCallRepository();
  const checkpointRepo = makeFakeCheckpointRepository();
  const agent = makeTestAgentConfig();

  const deps: RunControllerDeps = {
    gateway: makeScriptedGateway([]),
    tools: makeFakeToolRegistry([makeFinishTool(), makeEditFileTool(), makeListFilesTool()]),
    toolProtocols: { native: makeNativeToolProtocol(), text: makeNativeToolProtocol() },
    permissions: makeAllowAllPermissionEngine(),
    checkpoints: makeFakeCheckpointService(clock, ids),
    context: makeFakeContextBuilder(),
    taskManager: new DefaultTaskManager({ tasks: makeFakeTaskRepository(), events, clock }),
    events, runs, chats, messages, toolCalls, checkpointRepo,
    agents: makeFakeAgentConfigResolver(agent),
    clock, ids,
    delay: async () => {}, // sin backoff real en tests
    projectRoot: '/workspace',
    projectId: 'project_1',
    ...overrides,
  };
  return { deps, runs };
}

async function waitTerminal(runs: ReturnType<typeof makeFakeRunRepository>, runId: string) {
  const terminal = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
  await waitUntil(async () => terminal.has((await runs.get(runId))?.state ?? ''));
}

describe('RunController — memorias de agente autorizadas', () => {
  it('serializa procedencia y confianza como datos delimitados', () => {
    const memory: AgentMemory = {
      id: 'memory_1', agentId: 'agent_1', projectId: 'project_1', content: 'La API usa UTC.',
      sourceKind: 'inferred', confidence: 'hypothesis', originRef: 'docs/api.md', createdAt: 1, updatedAt: 1,
    };
    expect(formatAgentMemoryForContext([memory])).toContain('hipótesis; inferida; alcance: proyecto actual; origen: docs/api.md');
    expect(formatAgentMemoryForContext([memory])).toContain('--- inicio memoria');
    expect(formatAgentMemoryForContext([])).toBeUndefined();
  });

  it('consulta el puerto sólo cuando el agente permite memoria y entrega el bloque a ContextBuilder', async () => {
    let receivedMemory: string | undefined;
    const context = makeFakeContextBuilder();
    const originalBuild = context.build;
    context.build = async (input) => {
      receivedMemory = input.agentMemory;
      return originalBuild(input);
    };
    const listForRun = async (agentId: string, projectId: string): Promise<AgentMemory[]> => {
      expect(agentId).toBe('agent_1');
      expect(projectId).toBe('project_1');
      return [{
        id: 'memory_1', agentId, projectId, content: 'Preferís pruebas focales.',
        sourceKind: 'user_stated', confidence: 'confirmed', createdAt: 1, updatedAt: 1,
      }];
    };
    const agent = makeTestAgentConfig({ memory: { readProjectMemory: true, writeProjectMemory: false } });
    const { deps, runs } = baseDeps({
      context,
      agents: makeFakeAgentConfigResolver(agent),
      agentMemories: { listForRun },
      gateway: makeScriptedGateway([[
        { type: 'content', text: 'Listo.' },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ]]),
    });
    const { runId } = await new RunController(deps).start('chat_1', 'Hola', 'agent');
    await waitTerminal(runs, runId);
    expect(receivedMemory).toContain('Preferís pruebas focales.');
    expect(receivedMemory).toContain('confirmada; dicho por la persona usuaria');
  });

  it('no consulta memorias cuando el perfil las deshabilita', async () => {
    let calls = 0;
    const { deps, runs } = baseDeps({
      agentMemories: { listForRun: async () => { calls += 1; return []; } },
      gateway: makeScriptedGateway([[
        { type: 'content', text: 'Listo.' },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ]]),
    });
    const { runId } = await new RunController(deps).start('chat_1', 'Hola', 'agent');
    await waitTerminal(runs, runId);
    expect(calls).toBe(0);
  });

  it('persiste una inspección segura del contexto real, incluidas raíz, SAURIO.md, mapa, memoria y adjuntos', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saurio-context-inspection-'));
    writeFileSync(join(projectRoot, 'SAURIO.md'), 'REGLA SENSIBLE DEL PROYECTO', 'utf8');
    const agent = makeTestAgentConfig({
      systemPrompt: 'PROMPT PRIVADO DEL AGENTE',
      memory: { readProjectMemory: true, writeProjectMemory: false },
    });
    const memoryContent = 'MEMORIA PRIVADA RECUPERADA';
    try {
      const messages = makeFakeMessageRepository();
      const events = makeFakeEventStore();
      const appendEvent = events.append.bind(events);
      events.append = (event) => {
        const persisted = appendEvent(event);
        if (persisted.type === 'message.done') {
          const chatMessages = messages.byChat.get(persisted.chatId) ?? [];
          chatMessages.push(persisted.message);
          messages.byChat.set(persisted.chatId, chatMessages);
        }
        return persisted;
      };
      const { deps, runs } = baseDeps({
        events,
        messages,
        projectRoot,
        workspaceFs: new WorkspaceFsImpl(projectRoot),
        agents: makeFakeAgentConfigResolver(agent),
        context: createContextBuilder(createTokenEstimator(agent.model)),
        repoMap: {
          build: async (root) => {
            expect(root).toBe(projectRoot);
            return { text: 'src/index.ts', tokens: 4 };
          },
          invalidate: () => {},
        },
        agentMemories: {
          listForRun: async () => [{
            id: 'memory_inspection', agentId: agent.id, projectId: 'project_1', content: memoryContent,
            sourceKind: 'user_stated', confidence: 'confirmed', createdAt: 1, updatedAt: 1,
          }],
        },
        modelContextProbe: { getContextMax: async () => 8_192 },
        gateway: makeScriptedGateway([[
          { type: 'tool_call', call: { id: 'finish_inspection', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
          { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
        ]]),
      });

      const { runId } = await new RunController(deps).start('chat_1', 'revisá', 'agent', [{
        kind: 'file', name: 'notas.txt', mime: 'text/plain',
        dataBase64: Buffer.from('contenido privado del adjunto').toString('base64'),
      }]);
      await waitTerminal(runs, runId);

      const event = (deps.events as ReturnType<typeof makeFakeEventStore>).all.find((candidate) => candidate.type === 'context.built');
      expect(event?.type).toBe('context.built');
      if (!event || event.type !== 'context.built') throw new Error('faltó context.built');
      expect(event.budget.inspection).toMatchObject({
        projectRoot,
        tokenUsageQuality: 'estimated',
        limitSource: 'reported',
        attachmentsKnown: true,
        attachments: [{ name: 'notas.txt', kind: 'file', status: 'included', truncated: false }],
      });
      expect(event.budget.inspection?.sources.find((source) => source.kind === 'project_instructions')).toMatchObject({
        status: 'included', provenance: 'SAURIO.md', itemCount: 1,
      });
      expect(event.budget.inspection?.sources.find((source) => source.kind === 'repo_map')).toMatchObject({
        status: 'included', provenance: 'project_index', itemCount: 1,
      });
      expect(event.budget.inspection?.sources.find((source) => source.kind === 'agent_memory')).toMatchObject({
        status: 'included', provenance: `agent_memory:${agent.id}`, itemCount: 1,
      });
      const serialized = JSON.stringify(event.budget.inspection);
      expect(serialized).not.toContain('PROMPT PRIVADO');
      expect(serialized).not.toContain('REGLA SENSIBLE');
      expect(serialized).not.toContain(memoryContent);
      expect(serialized).not.toContain('contenido privado');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rechaza un SAURIO.md que sea symlink fuera de la raíz y no entrega su contenido al modelo', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saurio-context-root-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'saurio-context-outside-'));
    const outsideInstructions = join(outsideRoot, 'instrucciones.md');
    const secret = 'NO FILTRAR ESTA INSTRUCCIÓN EXTERNA';
    writeFileSync(outsideInstructions, secret, 'utf8');
    symlinkSync(outsideInstructions, join(projectRoot, 'SAURIO.md'), 'file');
    try {
      const agent = makeTestAgentConfig();
      const gateway = makeScriptedGateway([[
        { type: 'tool_call', call: { id: 'finish_external_instructions', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ]]);
      const { deps, runs } = baseDeps({
        projectRoot,
        workspaceFs: new WorkspaceFsImpl(projectRoot),
        agents: makeFakeAgentConfigResolver(agent),
        context: createContextBuilder(createTokenEstimator(agent.model)),
        gateway,
      });

      const { runId } = await new RunController(deps).start('chat_1', 'hola', 'agent');
      await waitTerminal(runs, runId);

      expect(JSON.stringify(gateway.requests[0]?.messages)).not.toContain(secret);
      const event = (deps.events as ReturnType<typeof makeFakeEventStore>).all.find((candidate) => candidate.type === 'context.built');
      expect(event?.type).toBe('context.built');
      if (!event || event.type !== 'context.built') throw new Error('faltó context.built');
      expect(event.budget.inspection?.sources.find((source) => source.kind === 'project_instructions')).toMatchObject({
        status: 'unavailable', reason: 'build_failed', provenance: 'SAURIO.md',
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

/** Tool de test que siempre devuelve el mismo texto de error, sin importar los args — para ejercitar
 *  la pista de "error idéntico repetido" (doc 16 §4, RunController.runHandler) sin depender de que
 *  `LoopDetector.recordToolCall` (args-based) intervenga primero. */
function makeAlwaysFailingTool(errorText: string): ToolDefinition {
  return {
    name: 'flaky_tool', description: 'siempre falla con el mismo error', inputSchema: {}, category: 'read',
    mutating: false, idempotent: true, allowedInModes: ['plan', 'ask', 'edit', 'agent'],
    source: { kind: 'builtin' },
    handler: async () => ({ content: [{ type: 'text', text: errorText }], isError: true }),
  };
}

function makeReadFileTool(): ToolDefinition {
  return {
    name: 'read_file', description: 'lee un archivo del proyecto',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    category: 'read', mutating: false, idempotent: true,
    allowedInModes: ['plan', 'ask', 'edit', 'agent'], source: { kind: 'builtin' },
    handler: async () => ({ content: [{ type: 'text', text: 'export const doble = (n: number) => n;' }], isError: false }),
  };
}

describe('RunController — corrección conservadora de TextToolProtocol', () => {
  it('reintenta una sola vez con un mensaje system honesto y después acepta el segundo no-tool', async () => {
    const refusal = 'Para arreglar el bug de la función `doble` en `src/coder.ts`, necesito leer el contenido de ese archivo.';
    const scripts: ChatChunk[][] = [
      [{ type: 'content', text: refusal }, { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } }],
      [{ type: 'content', text: refusal }, { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } }],
    ];
    const gateway = makeScriptedGateway(scripts);
    const agent = makeTestAgentConfig({
      toolTransport: 'text',
      allowedTools: ['read_file', 'finish'],
    });
    const { deps, runs } = baseDeps({
      gateway,
      agents: makeFakeAgentConfigResolver(agent),
      tools: makeFakeToolRegistry([makeReadFileTool(), makeFinishTool()]),
      toolProtocols: { native: makeNativeToolProtocol(), text: createTextToolProtocol() },
    });
    const controller = new RunController(deps);
    await deps.messages.append('chat_1', {
      id: 'current_user', role: 'user',
      content: 'Arreglá el bug de la función doble en src/coder.ts: tiene que devolver n * 2.',
    });
    const { runId } = await controller.start(
      'chat_1',
      'Arreglá el bug de la función doble en src/coder.ts: tiene que devolver n * 2.',
      'agent',
    );
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.state).toBe('completed');
    expect(gateway.calls).toBe(2);
    const correction = gateway.requests[1]?.messages.find((message) => (
      message.role === 'system' && message.content.includes('Corrección interna del runtime')
    ));
    expect(correction?.content).toContain('no concede permisos');
    expect(correction?.content).toContain('read_file');
  });

  it('no reintenta una conversación normal aunque use transporte text', async () => {
    const gateway = makeScriptedGateway([[
      { type: 'content', text: '¡Hola! ¿En qué te ayudo?' },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ]]);
    const agent = makeTestAgentConfig({ toolTransport: 'text', allowedTools: ['read_file', 'finish'] });
    const { deps, runs } = baseDeps({
      gateway,
      agents: makeFakeAgentConfigResolver(agent),
      tools: makeFakeToolRegistry([makeReadFileTool(), makeFinishTool()]),
      toolProtocols: { native: makeNativeToolProtocol(), text: createTextToolProtocol() },
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'Hola', 'agent');
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.state).toBe('completed');
    expect(gateway.calls).toBe(1);
  });
});

// Punto 1d del encargo (feedback real v0.2.1): línea de estado simple (run.activity).
describe('RunController — run.activity', () => {
  it('emite thinking, la fase de la tool y answering en un turno con una tool y luego texto final', async () => {
    const applied: unknown[] = [];
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'edit_file', args: { path: 'src/a.ts' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'content', text: 'listo' },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      tools: makeFakeToolRegistry([makeFinishTool(), makeEditFileTool((args) => applied.push(args)), makeListFilesTool()]),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'cambiá src/a.ts y contame', 'agent');
    await waitTerminal(runs, runId);

    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    const activity = events.filter((e) => e.type === 'run.activity');
    expect(activity.map((e) => (e as { phase: string }).phase)).toEqual(
      expect.arrayContaining(['thinking', 'editing', 'answering']),
    );
  });
});

describe('RunController — run feliz con edit_file', () => {
  it('edit_file permitido directo -> checkpoint begin/commit -> finish -> completed', async () => {
    const applied: unknown[] = [];
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'edit_file', args: { path: 'src/a.ts', old: 'a', new: 'b' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'call_2', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      tools: makeFakeToolRegistry([makeFinishTool(), makeEditFileTool((args) => applied.push(args)), makeListFilesTool()]),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'cambiá src/a.ts', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.state).toBe('completed');
    expect(applied).toHaveLength(1);
    expect(deps.checkpointRepo).toBeDefined();

    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    expect(events.some((e) => e.type === 'checkpoint.created')).toBe(true);
    expect(events.some((e) => e.type === 'tool.status' && e.status === 'done')).toBe(true);
  });
});

describe('RunController — expected_pre_hash (doc 16 §4 ítem 16, doc 10 §3/§5.2)', () => {
  it('con deps.readHashes provisto, escribe tool_calls.expected_pre_hash al registrar una tool mutante de archivo', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'edit_file', args: { path: 'src/a.ts' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'call_2', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      readHashes: { lastHash: (_runId, relPath) => (relPath === 'src/a.ts' ? 'sha-del-ultimo-read_file' : undefined) },
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'cambiá src/a.ts', 'agent');
    await waitTerminal(runs, runId);

    const record = await deps.toolCalls.get('call_1');
    expect(record?.expectedPreHash).toBe('sha-del-ultimo-read_file');
  });

  it('sin deps.readHashes, expected_pre_hash queda sin definir (comportamiento previo a esta tarea)', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'edit_file', args: { path: 'src/a.ts' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'call_2', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({ gateway: makeScriptedGateway(scripts) });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'cambiá src/a.ts', 'agent');
    await waitTerminal(runs, runId);

    const record = await deps.toolCalls.get('call_1');
    expect(record?.expectedPreHash).toBeUndefined();
  });
});

describe('RunController — batching de message.delta (doc 16 §4 ítem 9)', () => {
  it('agrupa varios chunks "content" del mismo turno en menos eventos message.delta, con el mismo contenido total y el mismo orden', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'content', text: 'Ho' },
        { type: 'content', text: 'la ' },
        { type: 'content', text: 'mundo' },
        { type: 'tool_call', call: { id: 'call_1', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({ gateway: makeScriptedGateway(scripts) });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'saludá', 'agent');
    await waitTerminal(runs, runId);

    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    const deltas = events.filter((e): e is Extract<RunEvent, { type: 'message.delta' }> => e.type === 'message.delta' && e.field === 'content');
    // 3 chunks "content" llegaron en el mismo turno, sin tiempo real entre ellos (script sincrónico):
    // el batcher los junta en un solo evento en vez de emitir uno por chunk (doc: "menos eventos").
    expect(deltas.length).toBeLessThan(3);
    expect(deltas.map((e) => e.text).join('')).toBe('Hola mundo');

    const doneMsg = events.find((e): e is Extract<RunEvent, { type: 'message.done' }> => e.type === 'message.done' && e.message.role === 'assistant');
    expect(doneMsg?.message.content).toBe('Hola mundo'); // mismo contenido, batching no lo altera
    // Punto 4 del encargo (doc 16 §10.4/§10.9, migración 0003): el mensaje del asistente persiste el
    // modelo que efectivamente lo generó, no solo el modelo vigente del chat.
    expect(doneMsg?.message.modelRef).toEqual({ providerId: 'ollama_local', name: 'qwen3:8b', locality: 'local' });

    // Orden: todo el streaming (message.delta) del turno del asistente queda persistido ANTES que el
    // cierre de ESE turno (el primer `message.done` de la lista es el del mensaje del usuario, de
    // `start()` — no es el que importa acá).
    const deltaIdx = events.findIndex((e) => e.type === 'message.delta');
    const assistantDoneIdx = events.findIndex((e) => e.type === 'message.done' && e.message.role === 'assistant');
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeLessThan(assistantDoneIdx);
  });

  it('con messageDeltaBatchMs: 0, sigue emitiendo un evento por chunk (comportamiento equivalente al previo)', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'content', text: 'a' },
        { type: 'content', text: 'b' },
        { type: 'tool_call', call: { id: 'call_1', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    // intervalMs=0 igual pasa por el batcher (no hay bypass), pero al ser síncrono el `flush()`
    // explícito en 'done' junta lo que haya en el buffer en ese instante — la ventana en sí no
    // cambia el punto real de esta prueba (doc: "sin romper... el mismo contenido"), así que se
    // valida el caso general con un intervalo válido en vez de depender de temporizadores en 0.
    const { deps, runs } = baseDeps({ gateway: makeScriptedGateway(scripts), messageDeltaBatchMs: 0 });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'saludá', 'agent');
    await waitTerminal(runs, runId);

    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    const deltas = events.filter((e): e is Extract<RunEvent, { type: 'message.delta' }> => e.type === 'message.delta' && e.field === 'content');
    expect(deltas.map((e) => e.text).join('')).toBe('ab');
  });
});

describe('RunController — pista tras el segundo error idéntico de una tool (doc 16 §4, robustez con modelos chicos)', () => {
  it('agrega una pista concreta al ToolResult desde la 2ª vez que la misma tool falla con el mismo texto (no antes)', async () => {
    const errorText = 'no se pudo aplicar el cambio: match ambiguo';
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'flaky_tool', args: { attempt: 1 }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'call_2', name: 'flaky_tool', args: { attempt: 2 }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'call_3', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      tools: makeFakeToolRegistry([makeFinishTool(), makeAlwaysFailingTool(errorText), makeListFilesTool()]),
      agents: makeFakeAgentConfigResolver(makeTestAgentConfig({ allowedTools: ['finish', 'flaky_tool'] })),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'probá algo que falla', 'agent');
    await waitTerminal(runs, runId);

    const first = await deps.toolCalls.get('call_1');
    const second = await deps.toolCalls.get('call_2');
    expect(first?.resultPreview).toBe(errorText); // 1ª vez: sin pista, solo el error crudo
    expect(second?.resultPreview).toContain(errorText); // 2ª vez: el error real sigue presente...
    expect(second?.resultPreview).toContain('pista'); // ...más la pista concreta
    expect(second?.resultPreview).toContain('flaky_tool');
  });

  it('un texto de error distinto no dispara la pista (no es "la misma tool falló" sin más)', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'flaky_tool', args: { attempt: 1 }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'call_2', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      tools: makeFakeToolRegistry([makeFinishTool(), makeAlwaysFailingTool('error único'), makeListFilesTool()]),
      agents: makeFakeAgentConfigResolver(makeTestAgentConfig({ allowedTools: ['finish', 'flaky_tool'] })),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'probá algo que falla una vez', 'agent');
    await waitTerminal(runs, runId);

    const first = await deps.toolCalls.get('call_1');
    expect(first?.resultPreview).toBe('error único');
    expect(first?.resultPreview).not.toContain('pista');
  });
});

describe('RunController — permiso ask y respuesta', () => {
  it('ejecuta dos herramientas con permisos sucesivos y completa tras aprobar ambas', async () => {
    const applied: unknown[] = [];
    const scripts: ChatChunk[][] = ['first', 'second'].map((id) => [
      { type: 'tool_call', call: { id, name: 'edit_file', args: { path: `${id}.ts` }, transport: 'native' } },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ]);
    scripts.push([{ type: 'content', text: 'Listo' }, { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } }]);
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts), permissions: makeAskThenRecordPermissionEngine(),
      tools: makeFakeToolRegistry([makeEditFileTool((args) => applied.push(args))]),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'Editá ambos archivos', 'agent');
    for (const id of ['first', 'second']) {
      await waitUntil(async () => (await deps.toolCalls.get(id))?.status === 'awaiting_permission');
      await controller.answerPermission(id, { toolCallId: id, answer: 'allow_once' });
    }
    await waitTerminal(runs, runId);
    expect(applied).toEqual([{ path: 'first.ts' }, { path: 'second.ts' }]);
    expect((await runs.get(runId))?.state).toBe('completed');
  });
  it('edit_file en ask espera answerPermission y continúa tras allow_once', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'edit_file', args: { path: 'src/a.ts' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'call_2', name: 'finish', args: {}, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      permissions: makeAskThenRecordPermissionEngine(),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'cambiá src/a.ts', 'agent');

    await waitUntil(async () => (await runs.get(runId))?.state === 'awaiting_permission');
    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    expect(events.some((e) => e.type === 'tool.permission')).toBe(true);

    await controller.answerPermission('call_1', { toolCallId: 'call_1', answer: 'allow_once' });
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.state).toBe('completed');
    expect(events.some((e) => e.type === 'tool.decision' && 'answer' in e.decision && e.decision.answer === 'allow_once')).toBe(true);
  });

  it('deny en la respuesta de permiso no ejecuta la tool y el run sigue', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'edit_file', args: { path: 'src/a.ts' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'call_2', name: 'finish', args: {}, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const applied: unknown[] = [];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      permissions: makeAskThenRecordPermissionEngine(),
      tools: makeFakeToolRegistry([makeFinishTool(), makeEditFileTool((a) => applied.push(a)), makeListFilesTool()]),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'cambiá src/a.ts', 'agent');
    await waitUntil(async () => (await runs.get(runId))?.state === 'awaiting_permission');

    await controller.answerPermission('call_1', { toolCallId: 'call_1', answer: 'deny', reason: 'no ahora' });
    await waitTerminal(runs, runId);

    expect(applied).toHaveLength(0);
    expect((await runs.get(runId))?.state).toBe('completed');
    expect((await deps.toolCalls.get('call_1'))?.status).toBe('denied');
  });
});

describe('RunController — proyecto y plan de texto', () => {
  it('rechaza chats y runs de otro proyecto antes de generar o crear un run nuevo', async () => {
    const chatA = makeTestChat({ id: 'chat_a', projectId: 'project_a' });
    const chatB = makeTestChat({ id: 'chat_b', projectId: 'project_b' });
    const chats = makeFakeChatRepository([chatA, chatB]);
    const gateway = makeScriptedGateway([]);
    const { deps, runs } = baseDeps({ chats, gateway, projectId: 'project_b', projectRoot: '/project-b' });
    const controllerB = new RunController(deps);

    await expect(controllerB.start(chatA.id, 'tocá un archivo', 'agent'))
      .rejects.toThrow(/chat_a pertenece al proyecto project_a/);
    await runs.create({
      id: 'run_a', chatId: chatA.id, agentId: 'agent_1', mode: 'agent', state: 'completed',
      iteration: 1, lastEventSeq: 0, createdAt: 0,
    });
    await expect(controllerB.continueRun('run_a'))
      .rejects.toThrow(/chat_a pertenece al proyecto project_a/);

    expect(gateway.calls).toBe(0);
    expect((await runs.listActive()).map((run) => run.id)).toEqual([]);
  });

  it('filtra y rechaza permisos pendientes de otro proyecto, incluido answerPermission', async () => {
    const chatA = makeTestChat({ id: 'chat_a', projectId: 'project_a' });
    const chatB = makeTestChat({ id: 'chat_b', projectId: 'project_b' });
    const chats = makeFakeChatRepository([chatA, chatB]);
    const { deps, runs } = baseDeps({ chats, projectId: 'project_b', projectRoot: '/project-b' });
    await runs.create({
      id: 'run_a', chatId: chatA.id, agentId: 'agent_1', mode: 'agent', state: 'awaiting_permission',
      iteration: 0, lastEventSeq: 0, createdAt: 0,
    });
    await deps.toolCalls.upsert({
      id: 'call_a', runId: 'run_a', iteration: 0, toolName: 'edit_file', args: { path: 'same-name.ts' },
      argsHash: 'hash', category: 'write', risk: 'medium', transport: 'native', status: 'awaiting_permission',
    });
    const controllerB = new RunController(deps);

    await expect(controllerB.pendingPermissionRequests()).resolves.toEqual([]);
    await expect(controllerB.resumeAfterRestart('run_a'))
      .rejects.toThrow(/chat_a pertenece al proyecto project_a/);
    await expect(controllerB.answerPermission('call_a', { toolCallId: 'call_a', answer: 'allow_once' }))
      .rejects.toThrow(/chat_a pertenece al proyecto project_a/);
    expect((await deps.toolCalls.get('call_a'))?.status).toBe('awaiting_permission');

    const controllerA = new RunController({ ...deps, projectId: 'project_a', projectRoot: '/project-a' });
    await expect(controllerA.pendingPermissionRequests()).resolves.toHaveLength(1);
  });

  it('usa la raíz del proyecto en el prompt al iniciar y continuar sin mutar el agente global', async () => {
    const agent = { ...makeTestAgentConfig({ role: 'lead' }), workingDir: 'C:\\Users\\example\\AppData\\SaurioLLM' };
    const collaborator = makeTestAgentConfig({ id: 'agent_tester', name: 'Tester Persistente', role: 'custom' });
    const gateway = makeScriptedGateway([0, 1].map(() => [
      { type: 'content', text: 'Hola' }, { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ]));
    const { deps, runs } = baseDeps({
      agents: makeFakeAgentConfigResolver(agent), gateway, projectRoot: 'N:\\Proyecto abierto',
      context: createContextBuilder(createTokenEstimator(agent.model)),
      chatCollaborators: { listEnabled: async () => [collaborator] },
    });
    const controller = new RunController(deps);
    const first = await controller.start('chat_1', '¿Dónde trabajás?', 'agent');
    await waitTerminal(runs, first.runId);
    const next = await controller.continueRun(first.runId);
    await waitTerminal(runs, next.runId);
    for (const request of gateway.requests) {
      const system = request.messages.find((message) => message.role === 'system')!.content;
      expect(system).toContain('Carpeta de trabajo: N:\\Proyecto abierto');
      expect(system).not.toContain(agent.workingDir);
      expect(system).toContain('Tester Persistente');
      expect(system).toContain('agent_tester');
    }
    expect(agent.workingDir).toBe('C:\\Users\\example\\AppData\\SaurioLLM');
    expect(gateway.requests).toHaveLength(2);
  });

  it('recarga la allowlist al reanudar un permiso después de reiniciar', async () => {
    const lead = makeTestAgentConfig({ role: 'lead' });
    const calls: string[] = [];
    const { deps, runs } = baseDeps({
      agents: makeFakeAgentConfigResolver(lead),
      chatCollaborators: { listEnabled: async (chatId) => { calls.push(chatId); return []; } },
    });
    await runs.create({ id: 'run_resume_team', chatId: 'chat_1', agentId: lead.id, mode: 'agent', state: 'awaiting_permission', iteration: 0, lastEventSeq: 0, createdAt: 0 });
    await deps.toolCalls.upsert({ id: 'call_resume_team', runId: 'run_resume_team', iteration: 0, toolName: 'edit_file', args: { path: 'a.ts' }, argsHash: 'h', category: 'write', risk: 'medium', transport: 'native', status: 'awaiting_permission' });
    const controller = new RunController(deps);
    await expect(controller.resumeAfterRestart('run_resume_team')).resolves.toBe(true);
    expect(calls).toEqual(['chat_1']);
    await controller.cancel('run_resume_team');
  });

  it('persiste el checklist de un plan textual sin segunda respuesta ni tools', async () => {
    const gateway = makeScriptedGateway([[
      { type: 'content', text: '1. Leer math.ts\n2. Corregir suma\n3. Ejecutar las pruebas' },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ]]);
    const { deps, runs } = baseDeps({ gateway });
    const { runId } = await new RunController(deps).start('chat_1', 'Armá un plan', 'plan');
    await waitTerminal(runs, runId);
    expect((await deps.taskManager.list('chat_1')).map((task) => task.title))
      .toEqual(['Leer math.ts', 'Corregir suma', 'Ejecutar las pruebas']);
    expect(gateway.calls).toBe(1);
    expect((await runs.get(runId))?.state).toBe('completed');
  });

  it('pide una sola corrección si modo plan termina en prosa y persiste la lista explícita del segundo intento', async () => {
    const gateway = makeScriptedGateway([
      [
        { type: 'content', text: 'El bug está en math.ts y hace una resta en vez de sumar.' },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'content', text: '1. Leer math.ts\n2. Corregir suma\n3. Ejecutar las pruebas' },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ]);
    const { deps, runs } = baseDeps({
      gateway, context: createContextBuilder(createTokenEstimator(makeTestAgentConfig().model)),
    });
    const { runId } = await new RunController(deps).start('chat_1', 'Explorá el bug', 'plan');
    await waitTerminal(runs, runId);

    expect((await deps.taskManager.list('chat_1')).map((task) => task.title))
      .toEqual(['Leer math.ts', 'Corregir suma', 'Ejecutar las pruebas']);
    expect(gateway.calls).toBe(2);
    expect(gateway.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'user', content: expect.stringContaining('Corrección interna del runtime'),
    });
    expect(gateway.requests[1]?.messages.some((message) => (
      message.role === 'user' && message.content.includes('Corrección interna del runtime: la respuesta anterior no incluyó un plan explícito')
    ))).toBe(true);
    expect((await runs.get(runId))?.state).toBe('completed');
  });

  it.each(['prosa', 'vacía'])('falla sin inventar tasks ni agregar reintentos si la corrección del plan queda %s', async (kind) => {
    const prose = 'El bug está en math.ts y hace una resta en vez de sumar.';
    const gateway = makeScriptedGateway([0, 1].map((index) => [
      { type: 'content' as const, text: index === 1 && kind === 'vacía' ? '' : prose },
      { type: 'done' as const, doneReason: 'stop', metrics: { quality: 'measured' as const } },
    ]));
    const { deps, runs } = baseDeps({ gateway });
    const { runId } = await new RunController(deps).start('chat_1', 'Explorá el bug', 'plan');
    await waitTerminal(runs, runId);

    expect(await deps.taskManager.list('chat_1')).toEqual([]);
    expect(gateway.calls).toBe(2);
    expect((await runs.get(runId))?.state).toBe('failed');
    expect(deps.events.since(runId, 0)).toContainEqual(expect.objectContaining({
      type: 'run.error', error: expect.objectContaining({ message: expect.stringContaining('no produjo un plan') }),
    }));
  });

  it('corrige una vez finish sin tasks y acepta las tasks estructuradas del segundo intento', async () => {
    const finish = {
      ...makeFinishTool(),
      handler: async (args: unknown) => ({
        content: [{ type: 'text' as const, text: 'ok' }], isError: false,
        structured: args,
      }),
    } satisfies ToolDefinition;
    const gateway = makeScriptedGateway([
      [
        { type: 'tool_call', call: { id: 'finish_sin_tasks', name: 'finish', args: { summary: 'El bug está en math.ts.' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'finish_con_tasks', name: 'finish', args: {
          summary: 'Plan listo', tasks: [
            { title: 'Corregir suma', status: 'pending' },
            { title: 'Ejecutar las pruebas', status: 'pending' },
          ],
        }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ]);
    const { deps, runs } = baseDeps({ gateway, tools: makeFakeToolRegistry([finish, makeListFilesTool()]) });
    const { runId } = await new RunController(deps).start('chat_1', 'Explorá el bug', 'plan');
    await waitTerminal(runs, runId);

    expect((await deps.taskManager.list('chat_1')).map((task) => task.title))
      .toEqual(['Corregir suma', 'Ejecutar las pruebas']);
    expect(gateway.calls).toBe(2);
    expect((await runs.get(runId))?.state).toBe('completed');
  });

  it('no aplica la corrección de plan en modo ask ni después de un reintento de formato', async () => {
    const prose = 'El bug está en math.ts y hace una resta en vez de sumar.';
    const askGateway = makeScriptedGateway([[
      { type: 'content', text: prose },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ]]);
    const ask = baseDeps({ gateway: askGateway });
    const askRun = await new RunController(ask.deps).start('chat_1', '¿Dónde está el bug?', 'ask');
    await waitTerminal(ask.runs, askRun.runId);
    expect(askGateway.calls).toBe(1);

    const nativeProtocol = makeNativeToolProtocol();
    const retryProtocol: ToolProtocol = {
      ...nativeProtocol,
      parse: (message, tools) => message.content === 'formato inválido'
        ? { toolCalls: [], text: '', parseErrors: ['bloque de tool call incompleto'] }
        : nativeProtocol.parse(message, tools),
    };
    const retryGateway = makeScriptedGateway([
      [
        { type: 'content', text: 'formato inválido' },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'content', text: prose },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ]);
    const retry = baseDeps({
      gateway: retryGateway,
      toolProtocols: { native: retryProtocol, text: createTextToolProtocol() },
    });
    const retryRun = await new RunController(retry.deps).start('chat_1', 'Explorá el bug', 'plan');
    await waitTerminal(retry.runs, retryRun.runId);
    expect(retryGateway.calls).toBe(2);
    expect(await retry.deps.taskManager.list('chat_1')).toEqual([]);
  });
});

describe('RunController — regenerar una respuesta', () => {
  const originModel = { providerId: 'openai-compatible', name: 'modelo-historico', locality: 'cloud' as const };
  const effectiveConfig = {
    model: originModel, numCtx: 16_384, think: false, tools: ['finish'] as string[],
    transport: 'native' as const, promptHash: 'hash_historico', adjustments: [],
    contextLimitSource: 'reported' as const,
  };

  function snapshotContext(): ContextBuilder {
    const base = makeFakeContextBuilder();
    return {
      willCompact: (input) => base.willCompact(input),
      build: async (input) => {
        const built = await base.build(input);
        return { ...built, messages: built.messages.map((message) => ({ ...message })) };
      },
    };
  }

  async function seedOrigin(
    deps: RunControllerDeps,
    runs: ReturnType<typeof makeFakeRunRepository>,
    state: 'completed' | 'generating' = 'completed',
  ): Promise<ChatMessage[]> {
    await runs.create({
      id: 'run_origin', chatId: 'chat_1', agentId: 'agent_1', mode: 'agent', state,
      iteration: 1, lastEventSeq: 0, effectiveConfig, createdAt: 1,
    });
    const history: ChatMessage[] = [
      { id: 'user_older', originRunId: 'run_older', role: 'user', content: 'contexto anterior' },
      { id: 'assistant_older', originRunId: 'run_older', role: 'assistant', content: 'respuesta anterior' },
      { id: 'user_origin', originRunId: 'run_origin', role: 'user', content: 'pedido exacto' },
      { id: 'assistant_origin', originRunId: 'run_origin', role: 'assistant', content: 'respuesta a conservar' },
      { id: 'tool_origin', originRunId: 'run_origin', role: 'tool', content: 'salida a conservar', toolCallId: 'call_origin' },
    ];
    for (const message of history) await deps.messages.append('chat_1', message);
    deps.events.append({
      runId: 'run_origin', chatId: 'chat_1', ts: deps.clock.now(), type: 'message.done',
      message: history[2]!, metrics: { quality: 'unavailable' },
    });
    deps.events.append({
      runId: 'run_origin', chatId: 'chat_1', ts: deps.clock.now(), type: 'message.done',
      message: history[3]!, metrics: { quality: 'measured' },
    });
    return history;
  }

  it('rechaza un origen de otro proyecto antes de crear o generar', async () => {
    const chats = makeFakeChatRepository([makeTestChat({ id: 'chat_1', projectId: 'project_a' })]);
    const gateway = makeScriptedGateway([]);
    const { deps, runs } = baseDeps({ chats, gateway, projectId: 'project_b', projectRoot: '/project-b' });
    await seedOrigin(deps, runs);

    await expect(new RunController(deps).regenerate('run_origin'))
      .rejects.toThrow(/chat_1 pertenece al proyecto project_a/);
    expect(gateway.calls).toBe(0);
    expect(runs.all.size).toBe(1);
  });

  it('rechaza un origen activo y bloquea dos regeneraciones simultáneas del mismo chat', async () => {
    const { deps, runs } = baseDeps();
    await seedOrigin(deps, runs, 'generating');
    const controller = new RunController(deps);
    await expect(controller.regenerate('run_origin')).rejects.toThrow(/todavía está activo/);

    await runs.update('run_origin', { state: 'completed' });
    const settled = await Promise.allSettled([
      controller.regenerate('run_origin'),
      controller.regenerate('run_origin'),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(String(rejected?.reason)).toMatch(/ya está iniciando otra ejecución|ya tiene un run activo/);
  });

  it('conserva el historial persistido pero el prompt termina en el user origen y usa su modelo efectivo', async () => {
    const gateway = makeScriptedGateway([[
      { type: 'content', text: 'respuesta regenerada' },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ]]);
    const { deps, runs } = baseDeps({ gateway, context: snapshotContext() });
    const originalHistory = await seedOrigin(deps, runs);
    const before = await deps.messages.listByChat('chat_1');

    const { runId } = await new RunController(deps).regenerate('run_origin');
    await waitTerminal(runs, runId);

    expect(await deps.messages.listByChat('chat_1')).toEqual(before);
    expect(before).toEqual(originalHistory);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.model).toBe(originModel.name);
    expect((await runs.get(runId))?.effectiveConfig?.model).toEqual(originModel);
    expect((await runs.get(runId))?.effectiveConfig?.regenerationSourceMessageId).toBe('user_origin');
    expect(gateway.requests[0]?.messages.filter((message) => !message.ephemeral).map((message) => message.id))
      .toEqual(['user_older', 'assistant_older', 'user_origin']);
    expect(gateway.requests[0]?.messages.find((message) => message.id === 'user_origin')).toMatchObject({
      id: 'user_origin', role: 'user', content: 'pedido exacto', originRunId: 'run_origin',
    });
  });

  it('puede volver a regenerar la respuesta regenerada usando la correlación persistida', async () => {
    const gateway = makeScriptedGateway([0, 1].map((index) => [
      { type: 'content' as const, text: `alternativa ${index + 1}` },
      { type: 'done' as const, doneReason: 'stop', metrics: { quality: 'measured' as const } },
    ]));
    const { deps, runs } = baseDeps({ gateway, context: snapshotContext() });
    await seedOrigin(deps, runs);
    const controller = new RunController(deps);

    const first = await controller.regenerate('run_origin');
    await waitTerminal(runs, first.runId);
    const second = await controller.regenerate(first.runId);
    await waitTerminal(runs, second.runId);

    expect(gateway.requests).toHaveLength(2);
    for (const request of gateway.requests) {
      expect(request.messages.filter((message) => !message.ephemeral).map((message) => message.id))
        .toEqual(['user_older', 'assistant_older', 'user_origin']);
    }
    expect((await runs.get(second.runId))?.effectiveConfig?.regenerationSourceMessageId).toBe('user_origin');
  });

  it('falla antes de crear el run cuando el pedido o una imagen adjunta no son restaurables', async () => {
    const { deps, runs } = baseDeps();
    await runs.create({
      id: 'run_missing', chatId: 'chat_1', agentId: 'agent_1', mode: 'agent', state: 'completed',
      iteration: 1, lastEventSeq: 0, effectiveConfig, createdAt: 1,
    });
    const controller = new RunController(deps);
    await expect(controller.regenerate('run_missing')).rejects.toThrow(/terminó antes de persistir una respuesta/);

    await deps.messages.append('chat_1', { id: 'user_broken', originRunId: 'run_missing', role: 'user', content: 'mirá', images: [''] });
    await deps.messages.append('chat_1', { id: 'assistant_broken', originRunId: 'run_missing', role: 'assistant', content: 'veo' });
    deps.events.append({
      runId: 'run_missing', chatId: 'chat_1', ts: deps.clock.now(), type: 'message.done',
      message: { id: 'user_broken', originRunId: 'run_missing', role: 'user', content: 'mirá', images: [''] },
      metrics: { quality: 'unavailable' },
    });
    deps.events.append({
      runId: 'run_missing', chatId: 'chat_1', ts: deps.clock.now(), type: 'message.done',
      message: { id: 'assistant_broken', originRunId: 'run_missing', role: 'assistant', content: 'veo' },
      metrics: { quality: 'measured' },
    });
    await expect(controller.regenerate('run_missing')).rejects.toThrow(/imagen adjunta.*no tiene datos restaurables/);
    expect(runs.all.size).toBe(1);
  });
});

describe('RunController — origen de selección de modelo', () => {
  const recommended = { providerId: 'ollama', name: 'qwen-role-fit:8b', locality: 'local' as const };
  const legacyCloud = { providerId: 'cloud-one', name: 'cloud-model', locality: 'cloud' as const };

  it('sólo omite el override para chats marcados auto; legacy y explícito conservan su elección', async () => {
    const autoAgent = makeTestAgentConfig({ modelMode: 'auto', model: legacyCloud });
    const explicitSame = recommended;
    const chats = makeFakeChatRepository([
      makeTestChat({ id: 'chat_auto', modelRef: undefined, modelSelection: 'auto' }),
      makeTestChat({ id: 'chat_explicit', modelRef: explicitSame, modelSelection: 'explicit' }),
      makeTestChat({ id: 'chat_legacy', modelRef: legacyCloud, modelSelection: undefined }),
    ]);
    const seen: Array<unknown> = [];
    const resolveModelRef: NonNullable<RunControllerDeps['resolveModelRef']> = async (_agent, chatModelRef) => {
      seen.push(chatModelRef);
      return chatModelRef ?? recommended;
    };
    const gateway = makeScriptedGateway([0, 1, 2].map(() => [
      { type: 'content', text: 'listo' },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ]));
    const { deps, runs } = baseDeps({
      agents: makeFakeAgentConfigResolver(autoAgent), chats, resolveModelRef, gateway,
      context: createContextBuilder(createTokenEstimator(recommended)),
    });
    const controller = new RunController(deps);

    for (const chatId of ['chat_auto', 'chat_explicit', 'chat_legacy']) {
      const { runId } = await controller.start(chatId, 'hola', 'ask');
      await waitTerminal(runs, runId);
    }

    expect(seen).toEqual([undefined, explicitSame, legacyCloud]);
  });

  it('persiste y emite la razón entregada por el mismo resolver que elige el modelo', async () => {
    const resolution = {
      source: 'automatic_recommendation' as const, contextMax: 32768,
      fitClass: 'tight' as const, fitQuality: 'estimated' as const,
    };
    const gateway = makeScriptedGateway([[
      { type: 'content', text: 'listo' },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ]]);
    const { deps, runs } = baseDeps({
      resolveModelRef: async () => ({ ref: recommended, resolution }), gateway,
      context: createContextBuilder(createTokenEstimator(recommended)),
    });
    const { runId } = await new RunController(deps).start('chat_1', 'hola', 'ask');
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.effectiveConfig?.model).toEqual(recommended);
    expect((await runs.get(runId))?.effectiveConfig?.modelResolution).toEqual(resolution);
    const built = (deps.events as ReturnType<typeof makeFakeEventStore>).all
      .find((event) => event.runId === runId && event.type === 'context.built');
    expect(built?.type).toBe('context.built');
    if (!built || built.type !== 'context.built') throw new Error('faltó context.built');
    expect(built.modelResolution).toEqual(resolution);
  });

  it('al continuar conserva la razón del run anterior e identifica la herencia', async () => {
    const resolution = { source: 'chat_override' as const };
    const gateway = makeScriptedGateway([0, 1].map(() => [
      { type: 'content', text: 'listo' },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ]));
    const { deps, runs } = baseDeps({
      resolveModelRef: async () => ({ ref: recommended, resolution }), gateway,
      context: createContextBuilder(createTokenEstimator(recommended)),
    });
    const controller = new RunController(deps);
    const first = await controller.start('chat_1', 'hola', 'ask');
    await waitTerminal(runs, first.runId);
    const next = await controller.continueRun(first.runId);
    await waitTerminal(runs, next.runId);

    expect((await runs.get(next.runId))?.effectiveConfig?.modelResolution).toEqual({
      source: 'chat_override', inheritedFromRunId: first.runId,
    });
  });
});

describe('RunController — cancelación', () => {
  it('cancel() durante awaiting_permission cierra el run en cancelled', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'edit_file', args: { path: 'src/a.ts' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({ gateway: makeScriptedGateway(scripts), permissions: makeAskThenRecordPermissionEngine() });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'cambiá src/a.ts', 'agent');
    await waitUntil(async () => (await runs.get(runId))?.state === 'awaiting_permission');

    await controller.cancel(runId);
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.state).toBe('cancelled');
    expect((await deps.toolCalls.get('call_1'))?.status).toBe('cancelled');
  });
});

describe('RunController — cierre inesperado simulado + recover', () => {
  it('un run vivo en este proceso no interfiere con recover() de una fila sembrada aparte', async () => {
    // El escenario "cierre inesperado" real (proceso muere entero) se cubre en recover.test.ts,
    // sembrando los fakes de persistencia directamente. Acá solo se confirma que `RunController.recover()`
    // delega en la misma función y devuelve su resultado tal cual.
    const { deps, runs } = baseDeps();
    await runs.create({
      id: 'run_orphan', chatId: 'chat_1', agentId: 'agent_1', mode: 'agent',
      state: 'executing_tool', iteration: 0, lastEventSeq: 1, createdAt: deps.clock.now(),
    });
    await deps.toolCalls.upsert({
      id: 'tc_orphan', runId: 'run_orphan', iteration: 0, toolName: 'edit_file', args: {},
      argsHash: 'hx', category: 'write', risk: 'medium', transport: 'native', status: 'running',
    });

    const controller = new RunController(deps);
    const result = await controller.recover();

    expect(result.orphaned.map((c) => c.id)).toEqual(['tc_orphan']);
    expect((await runs.get('run_orphan'))?.state).toBe('interrupted');
  });
});

describe('RunController — loop detectado', () => {
  it('la misma tool con los mismos argumentos repetida termina en failed(loop)', async () => {
    const repeatedCall = (id: string): ChatChunk[] => [
      { type: 'tool_call', call: { id, name: 'list_files', args: { path: '.' }, transport: 'native' } },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ];
    const scripts: ChatChunk[][] = Array.from({ length: 8 }, (_, i) => repeatedCall(`call_${i}`));
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      agents: makeFakeAgentConfigResolver(makeTestAgentConfig({ maxIterations: 20 })),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'listá archivos muchas veces', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.state).toBe('failed');
    expect(run?.error?.code).toBe('loop');
  });
});

describe('RunController — max_iterations', () => {
  it('agota agent.maxIterations sin llamar finish -> failed(max_iterations)', async () => {
    const readCall = (id: string): ChatChunk[] => [
      { type: 'tool_call', call: { id, name: 'list_files', args: { path: `/${id}` }, transport: 'native' } },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ];
    const scripts: ChatChunk[][] = Array.from({ length: 10 }, (_, i) => readCall(`call_${i}`));
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      agents: makeFakeAgentConfigResolver(makeTestAgentConfig({ maxIterations: 3 })),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'segui buscando', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.state).toBe('failed');
    expect(run?.error?.code).toBe('max_iterations');
    expect(run?.iteration).toBe(3);
  });
});

describe('RunController — context_overflow', () => {
  it('ContextBuilder.report.fits === false -> failed(context_overflow) sin llamar al gateway', async () => {
    const { deps, runs } = baseDeps({
      context: makeFakeContextBuilder({ fits: false }),
      gateway: makeScriptedGateway([]),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'un mensaje enorme', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.state).toBe('failed');
    expect(run?.error?.code).toBe('context_overflow');
    expect((deps.gateway as ReturnType<typeof makeScriptedGateway>).calls).toBe(0);
  });
});

// ── Hallazgo #5: mensaje de usuario visible sin esperar al assistant ──────

describe('RunController — mensaje de usuario', () => {
  it('start() emite message.done (role user) antes de que el assistant responda', async () => {
    const { deps, runs } = baseDeps({ gateway: makeScriptedGateway([]) });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'hola, arreglá el bug', 'agent');

    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    const userEvent = events.find((e) => e.type === 'message.done' && e.runId === runId && e.message.role === 'user');
    expect(userEvent).toBeDefined();
    if (userEvent?.type === 'message.done') {
      expect(userEvent.message.content).toBe('hola, arreglá el bug');
    }
    await waitTerminal(runs, runId);
  });
});

// ── Hallazgo #1/#4: toolCallId real (y touchedPaths) en la evaluación de permisos ──

describe('RunController — permission.evaluate recibe toolCallId real', () => {
  it('la solicitud tool.permission trae el toolCallId de la tool call, nunca vacío', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'edit_file', args: { path: 'src/a.ts' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'call_2', name: 'finish', args: {}, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    let capturedToolCallId: string | undefined;
    let capturedTouchedPaths: Set<string> | undefined;
    const permissions: PermissionEngine = {
      evaluate: (call): PermissionDecision => {
        capturedToolCallId = (call as { toolCallId?: string }).toolCallId;
        capturedTouchedPaths = (call as { touchedPaths?: Set<string> }).touchedPaths;
        return {
          decision: 'ask',
          request: {
            toolCallId: (call as { toolCallId?: string }).toolCallId ?? '',
            toolName: call.toolName, category: call.category, risk: call.risk,
            summary: call.summary, triggeredBy: 'test', rememberOptions: [],
          },
        };
      },
      isProtectedPath: () => false, isCriticalCommand: () => false, isBlockedByDefault: () => false,
    };
    const { deps, runs } = baseDeps({ gateway: makeScriptedGateway(scripts), permissions });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'cambiá src/a.ts', 'agent');
    await waitUntil(async () => (await runs.get(runId))?.state === 'awaiting_permission');

    expect(capturedToolCallId).toBe('call_1');
    expect(capturedTouchedPaths).toBeInstanceOf(Set);

    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    const permEvent = events.find((e) => e.type === 'tool.permission');
    expect(permEvent && permEvent.type === 'tool.permission' ? permEvent.request.toolCallId : undefined).toBe('call_1');

    await controller.answerPermission('call_1', { toolCallId: 'call_1', answer: 'allow_once' });
    await waitTerminal(runs, runId);
    expect((await runs.get(runId))?.state).toBe('completed');
  });

  it('answerPermission con toolCallId vacío rechaza explícitamente en vez de dejar el run colgado', async () => {
    const { deps } = baseDeps();
    const controller = new RunController(deps);
    await expect(controller.answerPermission('', { toolCallId: '', answer: 'allow_once' })).rejects.toThrow(/vacío/);
  });
});

// ── Hallazgo #2: cancelar mientras se construye el contexto (todavía en 'queued') ──

describe('RunController — cancel durante construcción de contexto', () => {
  it('cancel() mientras context.build está en vuelo termina en cancelled, no en un run colgado/failed', async () => {
    let releaseBuild: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseBuild = resolve; });
    const context: ContextBuilder = {
      willCompact() { return false; },
      async build({ history }) {
        await gate; // se libera desde el test, después de llamar a cancel()
        return {
          messages: history,
          report: {
            numCtx: 8192, reserveForResponse: 1500,
            used: { system: 100, tools: 200, repoMap: 0, memory: 0, history: 0 },
            totalUsed: 300, fits: true,
          },
        };
      },
    };
    const { deps, runs } = baseDeps({ context, gateway: makeScriptedGateway([]) });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'cancelame mientras armás el contexto', 'agent');

    await waitUntil(async () => (await runs.get(runId))?.state === 'queued');
    await controller.cancel(runId);
    releaseBuild?.();

    await waitTerminal(runs, runId);
    expect((await runs.get(runId))?.state).toBe('cancelled');

    // No debería haber quedado un run.error espurio por un intento fallido de transición
    // queued/cancelling -> generating (ver nota en runLoop sobre chequear cancelRequested).
    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all.filter((e) => e.runId === runId);
    expect(events.some((e) => e.type === 'run.error')).toBe(false);
  });
});

// ── Hallazgo #3 (parcial, agent/): timeout de handler ──────────────────────

describe('RunController — timeout de tool handler', () => {
  it('un handler que nunca resuelve termina la tool call como failed por timeout, sin colgar el run', async () => {
    const hangingTool: ToolDefinition = {
      name: 'hang_forever', description: 'nunca resuelve', inputSchema: {}, category: 'terminal',
      mutating: true, idempotent: false, allowedInModes: ['agent'],
      source: { kind: 'builtin' },
      handler: () => new Promise(() => {}), // nunca resuelve ni rechaza
    };
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'hang_forever', args: {}, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'call_2', name: 'finish', args: {}, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      tools: makeFakeToolRegistry([makeFinishTool(), hangingTool, makeListFilesTool()]),
      agents: makeFakeAgentConfigResolver(makeTestAgentConfig({ allowedTools: ['finish', 'hang_forever'] })),
      defaultToolTimeoutMs: 20,
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'colgate', 'agent');
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.state).toBe('completed');
    const record = await deps.toolCalls.get('call_1');
    expect(record?.status).toBe('failed');
    expect(record?.resultPreview).toMatch(/timeout/);
  });
});

// ── Hallazgo #6: stop tokens del transporte texto llegan al ChatRequest ────

describe('RunController — stop tokens del ToolProtocol', () => {
  it('protocol.renderTools().stop se propaga a request.options.stop', async () => {
    const capturedRequests: ChatRequest[] = [];
    const gateway: ModelGateway = {
      chat(_ref, req) {
        capturedRequests.push(req);
        const script: ChatChunk[] = [
          { type: 'tool_call', call: { id: 'call_1', name: 'finish', args: {}, transport: 'text' } },
          { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
        ];
        return (async function* () { for (const c of script) yield c; })();
      },
      providers: () => [],
      resolve: () => { throw new Error('no implementado en fake'); },
      async ensureLoaded() {},
      status: () => ({ slots: [], queue: [] }),
    };
    const textProtocol = {
      renderTools: () => ({ systemSuffix: 'usá <tool_call>', stop: ['</tool_call>'] }),
      parse: (message: ChatMessage) => ({
        toolCalls: message.toolCalls ?? [], text: message.content, parseErrors: [],
      }),
      renderResult: makeNativeToolProtocol().renderResult,
    };
    const { deps, runs } = baseDeps({
      gateway,
      toolProtocols: { native: makeNativeToolProtocol(), text: textProtocol },
      agents: makeFakeAgentConfigResolver(makeTestAgentConfig({ toolTransport: 'text' })),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'respondé en texto', 'agent');
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.state).toBe('completed');
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]?.options.stop).toEqual(['</tool_call>']);
  });
});

// ── PRIORIDAD CERO punto 2: "Ollama caído" no puede colgar el run en 'generating' para siempre ──

describe('RunController — provider caído (connection_refused) falla rápido en vez de reintentar sin límite', () => {
  it('tras MAX_CONNECTION_RETRIES+1 errores connection_refused seguidos, el run termina failed/provider_down', async () => {
    // Antes del fix, `retryOrFail` reintentaba este código para siempre (cada `chat()` de la cola
    // de abajo devuelve el mismo error) y el test nunca llegaba a un estado terminal — quedaría
    // colgado esperando `waitTerminal` hasta el timeout de vitest. Con el fix, falla a la cuarta.
    const errorScript: ChatChunk[] = [{ type: 'error', code: 'connection_refused', message: 'fetch failed: ECONNREFUSED' }];
    const gateway = makeScriptedGateway([errorScript, errorScript, errorScript, errorScript, errorScript]);
    const { deps, runs } = baseDeps({ gateway });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'hola', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.state).toBe('failed');
    expect(run?.error?.code).toBe('provider_down');
    // 1 intento inicial + 3 reintentos (MAX_CONNECTION_RETRIES) = 4 llamadas a gateway.chat, nunca 5.
    expect(gateway.calls).toBe(4);
  });

  it('un connection_refused aislado se recupera si el siguiente intento sí conecta (no queda una racha arrastrada)', async () => {
    const scripts: ChatChunk[][] = [
      [{ type: 'error', code: 'connection_refused', message: 'fetch failed: ECONNREFUSED' }],
      [
        { type: 'tool_call', call: { id: 'call_finish', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({ gateway: makeScriptedGateway(scripts) });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'hola', 'agent');
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.state).toBe('completed');
  });
});

describe('RunController — provider ocupado (server_busy) tiene reintentos acotados', () => {
  const busyScript: ChatChunk[] = [{ type: 'error', code: 'server_busy', message: 'HTTP 429: rate limit' }];
  const connectionScript: ChatChunk[] = [{ type: 'error', code: 'connection_refused', message: 'ECONNREFUSED' }];
  const listScript: ChatChunk[] = [
    { type: 'tool_call', call: { id: 'call_list_after_busy', name: 'list_files', args: {}, transport: 'native' } },
    { type: 'done', doneReason: 'tool_calls', metrics: { quality: 'measured' } },
  ];
  const finishScript: ChatChunk[] = [
    { type: 'tool_call', call: { id: 'call_finish_after_busy', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
    { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
  ];

  it('falla con server_busy visible después de tres reintentos y no hace una quinta llamada', async () => {
    const gateway = makeScriptedGateway([busyScript, busyScript, busyScript, busyScript, busyScript]);
    const { deps, runs } = baseDeps({ gateway });
    const { runId } = await new RunController(deps).start('chat_1', 'hola', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.state).toBe('failed');
    expect(run?.error).toMatchObject({ code: 'server_busy' });
    expect(run?.error?.message).toContain('tras 3 reintentos');
    expect(gateway.calls).toBe(4);
    const runError = (deps.events as ReturnType<typeof makeFakeEventStore>).all.find((event) => event.type === 'run.error');
    expect(runError).toMatchObject({ type: 'run.error', error: { code: 'server_busy' }, recoverable: false });
  });

  it('mantiene contadores separados y reinicia la racha busy al recibir una respuesta real', async () => {
    const gateway = makeScriptedGateway([
      connectionScript, connectionScript, connectionScript,
      busyScript, busyScript, busyScript,
      listScript,
      busyScript, busyScript, busyScript,
      finishScript,
    ]);
    const { deps, runs } = baseDeps({ gateway });
    const { runId } = await new RunController(deps).start('chat_1', 'listá y terminá', 'agent');
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.state).toBe('completed');
    expect(gateway.calls).toBe(11);
  });

  it('cancelar durante el backoff busy conserva cancelled sin reintentar ni emitir run.error', async () => {
    let notifyDelayStarted!: () => void;
    let releaseDelay!: () => void;
    const delayStarted = new Promise<void>((resolve) => { notifyDelayStarted = resolve; });
    const delayGate = new Promise<void>((resolve) => { releaseDelay = resolve; });
    const gateway = makeScriptedGateway([busyScript, busyScript]);
    const { deps, runs } = baseDeps({
      gateway,
      delay: async () => { notifyDelayStarted(); await delayGate; },
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'hola', 'agent');
    await delayStarted;

    await controller.cancel(runId);
    expect((await runs.get(runId))?.state).toBe('cancelling');
    releaseDelay();
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.state).toBe('cancelled');
    expect(gateway.calls).toBe(1);
    expect((deps.events as ReturnType<typeof makeFakeEventStore>).all.some((event) => event.type === 'run.error')).toBe(false);
  });
});

describe('RunController — allowlist efectiva de tools', () => {
  it('rechaza un write_file nativo no habilitado antes de permisos o ejecución', async () => {
    let permissionEvaluations = 0;
    let applied = false;
    const permissions = makeAllowAllPermissionEngine();
    const originalEvaluate = permissions.evaluate.bind(permissions);
    permissions.evaluate = (...args) => { permissionEvaluations += 1; return originalEvaluate(...args); };
    const forbiddenWriteTool: ToolDefinition = {
      name: 'write_file', description: 'escribe un archivo', inputSchema: {}, category: 'write',
      mutating: true, idempotent: false, allowedInModes: ['edit', 'agent'], source: { kind: 'builtin' },
      classify: () => ({ category: 'write', risk: 'medium', summary: 'write_file', paths: ['src/a.ts'] }),
      handler: async () => { applied = true; return { content: [{ type: 'text', text: 'escrito' }], isError: false }; },
    };
    const gateway = makeScriptedGateway([[
      { type: 'tool_call', call: { id: 'call_forbidden_write', name: 'write_file', args: { path: 'src/a.ts' }, transport: 'native' } },
      { type: 'done', doneReason: 'tool_calls', metrics: { quality: 'measured' } },
    ]]);
    const agent = makeTestAgentConfig({ role: 'reviewer', allowedTools: ['read_file', 'finish'] });
    const { deps, runs } = baseDeps({
      gateway,
      agents: makeFakeAgentConfigResolver(agent),
      permissions,
      tools: makeFakeToolRegistry([makeReadFileTool(), makeFinishTool(), forbiddenWriteTool]),
    });
    const { runId } = await new RunController(deps).start('chat_1', 'revisá sin escribir', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.state).toBe('failed');
    expect(run?.error).toMatchObject({ code: 'format' });
    expect(run?.error?.message).toContain('"write_file"');
    expect(run?.error?.message).toContain('No se solicitó permiso ni se ejecutó');
    expect(permissionEvaluations).toBe(0);
    expect(applied).toBe(false);
    expect((deps.events as ReturnType<typeof makeFakeEventStore>).all.some((event) => event.type === 'tool.permission')).toBe(false);
    expect((await deps.toolCalls.listByRun(runId))).toEqual([]);
  });

  it('rechaza delegate inventado también por transporte text sin crear un worker', async () => {
    const gateway = makeScriptedGateway([[
      { type: 'content', text: '<tool_call>{"name":"delegate","arguments":{"task":"escribir","expectedDeliverable":"cambio"}}</tool_call>' },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ]]);
    const agent = makeTestAgentConfig({ role: 'reviewer', toolTransport: 'text', allowedTools: ['read_file', 'finish'] });
    const { deps, runs } = baseDeps({
      gateway,
      agents: makeFakeAgentConfigResolver(agent),
      tools: makeFakeToolRegistry([makeReadFileTool(), makeFinishTool(), makeDelegateToolStub()]),
      toolProtocols: { native: makeNativeToolProtocol(), text: createTextToolProtocol() },
    });
    const { runId } = await new RunController(deps).start('chat_1', 'revisá', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.state).toBe('failed');
    expect(run?.error?.message).toContain('"delegate"');
    expect((deps.events as ReturnType<typeof makeFakeEventStore>).all.some((event) => event.type === 'run.delegated')).toBe(false);
    expect((deps.events as ReturnType<typeof makeFakeEventStore>).all.some((event) => event.type === 'tool.permission')).toBe(false);
    expect((await deps.toolCalls.listByRun(runId))).toEqual([]);
  });

  it('conserva read_file y finish cuando sí están en la allowlist efectiva', async () => {
    const gateway = makeScriptedGateway([
      [
        { type: 'tool_call', call: { id: 'call_allowed_read', name: 'read_file', args: { path: 'src/a.ts' }, transport: 'native' } },
        { type: 'done', doneReason: 'tool_calls', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'call_allowed_finish', name: 'finish', args: { summary: 'revisión lista' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ]);
    const agent = makeTestAgentConfig({ role: 'reviewer', allowedTools: ['read_file', 'finish'] });
    const { deps, runs } = baseDeps({
      gateway,
      agents: makeFakeAgentConfigResolver(agent),
      tools: makeFakeToolRegistry([makeReadFileTool(), makeFinishTool(), makeEditFileTool()]),
    });
    const { runId } = await new RunController(deps).start('chat_1', 'revisá', 'agent');
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.state).toBe('completed');
    expect(gateway.calls).toBe(2);
    expect((await deps.toolCalls.get('call_allowed_read'))?.status).toBe('done');
  });
});

describe('RunController — oom_load reintenta bajando numGpu antes de fallar (tarea "carga de modelo")', () => {
  const oomScript: ChatChunk[] = [{
    type: 'error', code: 'oom_load',
    message: 'llama-server reported out-of-memory during startup: GGML_ASSERT(buffer) failed alloc_tensor_range: failed to allocate Vulkan0 buffer of size 1072462848',
  }];
  const finishScript: ChatChunk[] = [
    { type: 'tool_call', call: { id: 'call_finish', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
    { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
  ];

  it('con block_count conocido, reintenta 75% -> 50% -> CPU (0) y registra un run.adjustment por paso', async () => {
    const gateway = makeScriptedGateway([oomScript, oomScript, oomScript, finishScript]);
    const modelLayerCountProbe = { getBlockCount: async () => 32 };
    const { deps, runs } = baseDeps({ gateway, modelLayerCountProbe });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'hola', 'agent');
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.state).toBe('completed');
    expect(gateway.calls).toBe(4);
    // 75% de 32 = 24, 50% de 32 = 16, último paso forzado a 0 (CPU).
    expect(gateway.requests.map((r) => r.options.numGpu)).toEqual([undefined, 24, 16, 0]);
  });

  it('sin modelLayerCountProbe, va directo a un único intento con numGpu 0 antes de rendirse', async () => {
    const gateway = makeScriptedGateway([oomScript, oomScript]);
    const { deps, runs } = baseDeps({ gateway });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'hola', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.state).toBe('failed');
    expect(run?.error?.code).toBe('oom_load');
    expect(gateway.calls).toBe(2);
    expect(gateway.requests.map((r) => r.options.numGpu)).toEqual([undefined, 0]);
  });

  it('si ni siquiera con 0 (CPU) entra, el run termina failed/oom_load tras agotar la escalera', async () => {
    const gateway = makeScriptedGateway([oomScript, oomScript, oomScript, oomScript]);
    const modelLayerCountProbe = { getBlockCount: async () => 32 };
    const { deps, runs } = baseDeps({ gateway, modelLayerCountProbe });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'hola', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.state).toBe('failed');
    expect(run?.error?.code).toBe('oom_load');
    expect(gateway.calls).toBe(4); // 1 intento inicial + 3 pasos de la escalera, nunca un 5º
  });

  it('un run/chat nuevo vuelve a numGpu automático ("reversible": el ajuste no se pega para siempre)', async () => {
    const gatewayA = makeScriptedGateway([oomScript, finishScript]);
    const modelLayerCountProbe = { getBlockCount: async () => 32 };
    const { deps: depsA, runs: runsA } = baseDeps({ gateway: gatewayA, modelLayerCountProbe });
    const controllerA = new RunController(depsA);
    const { runId: runIdA } = await controllerA.start('chat_1', 'hola', 'agent');
    await waitTerminal(runsA, runIdA);
    expect(gatewayA.requests.map((r) => r.options.numGpu)).toEqual([undefined, 24]);

    const gatewayB = makeScriptedGateway([finishScript]);
    const { deps: depsB, runs: runsB } = baseDeps({ gateway: gatewayB, modelLayerCountProbe });
    const controllerB = new RunController(depsB);
    const { runId: runIdB } = await controllerB.start('chat_1', 'hola', 'agent');
    await waitTerminal(runsB, runIdB);
    // Nuevo run (nueva instancia de RunController + LiveRun): sin herencia del ajuste anterior.
    expect(gatewayB.requests.map((r) => r.options.numGpu)).toEqual([undefined]);
  });

  it('tras reiniciar en un permiso conserva numGpu y continúa la escalera OOM sin repetir 75%', async () => {
    const permissionScript: ChatChunk[] = [
      { type: 'tool_call', call: { id: 'call_permission', name: 'list_files', args: { path: '.' }, transport: 'native' } },
      { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
    ];
    const gatewayA = makeScriptedGateway([oomScript, permissionScript]);
    const modelLayerCountProbe = { getBlockCount: async () => 32 };
    const { deps, runs } = baseDeps({
      gateway: gatewayA,
      modelLayerCountProbe,
      permissions: makeAskThenRecordPermissionEngine(),
    });
    const controllerA = new RunController(deps);
    const { runId } = await controllerA.start('chat_1', 'listá archivos', 'agent');
    await waitUntil(async () => (await runs.get(runId))?.state === 'awaiting_permission');

    expect(gatewayA.requests.map((request) => request.options.numGpu)).toEqual([undefined, 24]);
    expect((await runs.get(runId))?.effectiveConfig?.adjustments.filter((adjustment) => adjustment.param === 'numGpu')).toHaveLength(1);

    const gatewayB = makeScriptedGateway([oomScript, finishScript]);
    const controllerB = new RunController({ ...deps, gateway: gatewayB });
    await controllerB.answerPermission('call_permission', {
      toolCallId: 'call_permission', answer: 'allow_once',
    });
    await waitTerminal(runs, runId);

    expect((await runs.get(runId))?.state).toBe('completed');
    // El primer request rehidratado conserva 24; ante otro OOM sigue por 50% (=16), no vuelve a 24.
    expect(gatewayB.requests.map((request) => request.options.numGpu)).toEqual([24, 16]);
  });
});

// ── delegate (doc 19 §2, E3a "Delegación desde el chat") ─────────────────────

/** Stub de la tool `delegate` para el `ToolRegistry` del test: RunController la intercepta ANTES de
 *  llamar a `def.handler` (mismo patrón que `finish`), así que este handler nunca debería ejecutarse
 *  en ninguno de los tests de abajo — solo hace falta que la tool esté REGISTRADA (doc 19 §2.5). */
function makeDelegateToolStub(): ToolDefinition {
  return {
    name: 'delegate', description: 'delega', inputSchema: {}, category: 'delegate',
    mutating: false, idempotent: false, allowedInModes: ['plan', 'edit', 'agent'],
    source: { kind: 'delegate' },
    handler: async () => { throw new Error('no debería llamarse: RunController intercepta delegate'); },
  };
}

function makeMultiAgentConfigResolver(byId: Record<string, ReturnType<typeof makeTestAgentConfig>>): AgentConfigResolver {
  return {
    async resolve(agentId: string) {
      const found = byId[agentId];
      if (!found) throw new Error(`no existe el agente "${agentId}"`);
      return found;
    },
  };
}

function makeFakeAgentProfilePort(): AgentProfilePort & { created: { input: AgentCreateInput; ownerKind?: AgentOwnerKind }[] } {
  const created: { input: AgentCreateInput; ownerKind?: AgentOwnerKind }[] = [];
  return {
    created,
    async createProfile(input: AgentCreateInput, ownerKind?: AgentOwnerKind): Promise<AgentProfile> {
      created.push({ input, ownerKind });
      return {
        id: `worker_${created.length}`, ownerKind: ownerKind ?? 'personal', name: input.name,
        role: input.role ?? 'custom', modelMode: input.modelMode ?? 'fixed', model: input.model,
        systemPrompt: 'sos un worker temporal', allowedTools: [], permissionPreset: input.permissionPreset ?? 'balanced',
        createdAt: 0,
      };
    },
  };
}

const doneChunk: ChatChunk = { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } };

describe('RunController — delegate (doc 19 §2.5, E3a)', () => {
  it('T10: padre e hijo completan con un Scheduler real de un solo slot, sin retenerlo durante la espera', async () => {
    const scripts: ChatChunk[][] = [
      [{ type: 'tool_call', call: { id: 'call_delegate_slot', name: 'delegate', args: { targetAgentId: 'agent_reviewer', task: 'revisar', expectedDeliverable: 'informe' }, transport: 'native' } }, doneChunk],
      [{ type: 'tool_call', call: { id: 'call_finish_child_slot', name: 'finish', args: { summary: 'hijo listo' }, transport: 'native' } }, doneChunk],
      [{ type: 'tool_call', call: { id: 'call_finish_parent_slot', name: 'finish', args: { summary: 'padre listo' }, transport: 'native' } }, doneChunk],
    ];
    let scriptIndex = 0;
    let activeStreams = 0;
    let maxActiveStreams = 0;
    const provider: Provider = {
      id: 'ollama_local', kind: 'openai-compat', locality: 'local',
      health: async () => ({ ok: true }),
      listModels: async () => [],
      describeModel: async () => { throw new Error('no usado'); },
      chat(_request, _signal) {
        const script = scripts[scriptIndex++] ?? [doneChunk];
        return (async function* () {
          activeStreams += 1;
          maxActiveStreams = Math.max(maxActiveStreams, activeStreams);
          try {
            for (const chunk of script) {
              await new Promise<void>((resolve) => setImmediate(resolve));
              yield chunk;
            }
          } finally {
            activeStreams -= 1;
          }
        })();
      },
    };
    const gateway = new ModelGatewayImpl([provider], { slots: 1, groupByModel: true });
    const { deps, runs } = baseDeps({
      gateway,
      delay: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); },
      tools: makeFakeToolRegistry([makeFinishTool(), makeDelegateToolStub()]),
      agents: makeMultiAgentConfigResolver({
        agent_1: makeTestAgentConfig({ role: 'lead', allowedTools: ['finish', 'delegate'] }),
        agent_reviewer: makeTestAgentConfig({ id: 'agent_reviewer', role: 'reviewer', allowedTools: ['finish'] }),
      }),
    });
    const { runId } = await new RunController(deps).start('chat_1', 'delegá y cerrá', 'agent');
    await waitTerminal(runs, runId);

    const delegated = (deps.events as ReturnType<typeof makeFakeEventStore>).all
      .find((event): event is Extract<RunEvent, { type: 'run.delegated' }> => event.type === 'run.delegated');
    expect((await runs.get(runId))?.state).toBe('completed');
    expect((await runs.get(delegated?.childRunId ?? ''))?.state).toBe('completed');
    expect(scriptIndex).toBe(3);
    expect(maxActiveStreams).toBe(1);
    expect(gateway.status().queue).toEqual([]);
  });

  it('cancelChild valida proyecto y parentesco, y detener un hijo no cancela padre ni hermano', async () => {
    const parentChat = makeTestChat({ id: 'chat_parent' });
    const childChat = makeTestChat({ id: 'chat_child', originRunId: 'run_parent' });
    const siblingChat = makeTestChat({ id: 'chat_sibling', originRunId: 'run_parent' });
    const foreignChat = makeTestChat({ id: 'chat_foreign', projectId: 'project_foreign', originRunId: 'run_parent' });
    const chats = makeFakeChatRepository([parentChat, childChat, siblingChat, foreignChat]);
    const blockingGateway: ModelGateway = {
      chat(_ref, _request, context) {
        return (async function* () {
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          });
          yield doneChunk;
        })();
      },
      providers: () => [],
      resolve: () => { throw new Error('no usado'); },
      ensureLoaded: async () => {},
      status: () => ({ slots: [], queue: [] }),
    };
    const { deps, runs } = baseDeps({ chats, gateway: blockingGateway });
    await runs.create({
      id: 'run_parent', chatId: parentChat.id, agentId: 'agent_1', mode: 'agent', state: 'generating',
      iteration: 1, lastEventSeq: 0, createdAt: 0, delegationDepth: 0,
    });
    const controller = new RunController(deps);
    const { runId: childRunId } = await controller.start(childChat.id, 'hijo', 'agent');
    const { runId: siblingRunId } = await controller.start(siblingChat.id, 'hermano', 'agent');
    await controller.cancelChild('run_parent', childRunId);
    await waitTerminal(runs, childRunId);

    expect((await runs.get(childRunId))?.state).toBe('cancelled');
    expect((await runs.get('run_parent'))?.state).toBe('generating');
    expect((await runs.get(siblingRunId))?.state).not.toBe('cancelled');

    await runs.create({
      id: 'run_unrelated', chatId: parentChat.id, agentId: 'agent_1', mode: 'agent', state: 'generating',
      iteration: 0, lastEventSeq: 0, createdAt: 0,
    });
    await expect(controller.cancelChild('run_unrelated', siblingRunId)).rejects.toThrow(/no es hijo/);

    await runs.create({
      id: 'run_foreign_child', chatId: foreignChat.id, parentRunId: 'run_parent', agentId: 'agent_1', mode: 'agent', state: 'generating',
      iteration: 0, lastEventSeq: 0, createdAt: 0,
    });
    await expect(controller.cancelChild('run_parent', 'run_foreign_child')).rejects.toThrow(/project_foreign/);

    await controller.cancelChild('run_parent', siblingRunId);
    await waitTerminal(runs, siblingRunId);
  });

  it('Director sólo delega a colaboradores habilitados y recibe su roster en el prompt', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_blocked', name: 'delegate', args: { targetAgentId: 'agent_intruder', task: 'revisar', expectedDeliverable: 'informe' }, transport: 'native' } },
        doneChunk,
      ],
      [
        { type: 'tool_call', call: { id: 'call_finish_parent', name: 'finish', args: { summary: 'No delegué fuera del equipo.' }, transport: 'native' } },
        doneChunk,
      ],
    ];
    const gateway = makeScriptedGateway(scripts);
    const reviewer = makeTestAgentConfig({ id: 'agent_reviewer', name: 'Revisor Ada', role: 'reviewer', allowedTools: ['finish'] });
    const { deps, runs } = baseDeps({
      gateway,
      context: createContextBuilder(createTokenEstimator(reviewer.model)),
      tools: makeFakeToolRegistry([makeFinishTool(), makeDelegateToolStub()]),
      agents: makeMultiAgentConfigResolver({
        agent_1: makeTestAgentConfig({ role: 'lead', allowedTools: ['finish', 'delegate'] }),
        agent_reviewer: reviewer,
        agent_intruder: makeTestAgentConfig({ id: 'agent_intruder', name: 'Intruso' }),
      }),
      chatCollaborators: { listEnabled: async () => [reviewer] },
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'delegá la revisión', 'agent');
    await waitTerminal(runs, runId);

    expect(gateway.requests[0]?.messages.some((message) =>
      message.content.includes('Revisor Ada') && message.content.includes('agent_reviewer'))).toBe(true);
    const blocked = [...(deps.toolCalls as ReturnType<typeof makeFakeToolCallRepository>).all.values()]
      .find((call) => call.id === 'call_blocked');
    expect(blocked?.resultIsError).toBe(true);
    expect(blocked?.resultPreview).toContain('no está habilitado');
    expect((deps.events as ReturnType<typeof makeFakeEventStore>).all.some((event) => event.type === 'run.delegated')).toBe(false);
  });

  it('aplica budget.maxIterations al run hijo sin ampliar el límite del perfil', async () => {
    const scripts: ChatChunk[][] = [
      [{ type: 'tool_call', call: { id: 'call_delegate_budget', name: 'delegate', args: { targetAgentId: 'agent_reviewer', task: 'revisar', expectedDeliverable: 'informe', budget: { maxIterations: 1 } }, transport: 'native' } }, doneChunk],
      [{ type: 'tool_call', call: { id: 'call_child_read', name: 'list_files', args: {}, transport: 'native' } }, doneChunk],
      [{ type: 'tool_call', call: { id: 'call_finish_parent', name: 'finish', args: { summary: 'El hijo agotó su presupuesto.' }, transport: 'native' } }, doneChunk],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      tools: makeFakeToolRegistry([makeFinishTool(), makeDelegateToolStub(), makeListFilesTool()]),
      agents: makeMultiAgentConfigResolver({
        agent_1: makeTestAgentConfig({ allowedTools: ['finish', 'delegate'] }),
        agent_reviewer: makeTestAgentConfig({ id: 'agent_reviewer', allowedTools: ['finish', 'list_files'], maxIterations: 9 }),
      }),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'delegá con presupuesto corto', 'agent');
    await waitTerminal(runs, runId);
    const event = (deps.events as ReturnType<typeof makeFakeEventStore>).all.find((item) => item.type === 'run.delegated');
    expect(event?.type).toBe('run.delegated');
    if (!event || event.type !== 'run.delegated') throw new Error('faltó run.delegated');
    expect((await runs.get(event.childRunId))?.error?.code).toBe('max_iterations');
  });

  it('T06: delega a un agente existente — crea el run/chat hijo con parent_run_id/delegation_depth y el padre recibe el DelegationResult', async () => {
    const scripts: ChatChunk[][] = [
      // Turno 1 del PADRE: llama a delegate.
      [
        { type: 'tool_call', call: { id: 'call_delegate', name: 'delegate', args: { targetAgentId: 'agent_reviewer', task: 'revisar el módulo X', expectedDeliverable: 'resumen de hallazgos' }, transport: 'native' } },
        doneChunk,
      ],
      // Turno único del HIJO (disparado dentro del procesamiento del turno 1 del padre): cierra con
      // finish cuyo summary es el JSON de DelegationResultSchema.
      [
        { type: 'tool_call', call: { id: 'call_finish_child', name: 'finish', args: { summary: JSON.stringify({ status: 'completed', summary: 'módulo X revisado, sin hallazgos' }) }, transport: 'native' } },
        doneChunk,
      ],
      // Turno 2 del PADRE: ya con el resultado de la delegación en su historial, termina.
      [
        { type: 'tool_call', call: { id: 'call_finish_parent', name: 'finish', args: { summary: 'listo, delegado' }, transport: 'native' } },
        doneChunk,
      ],
    ];
    const gateway = makeScriptedGateway(scripts);
    const { deps, runs } = baseDeps({
      gateway,
      tools: makeFakeToolRegistry([makeFinishTool(), makeDelegateToolStub()]),
      agents: makeMultiAgentConfigResolver({
        agent_1: makeTestAgentConfig({ allowedTools: ['finish', 'delegate'] }),
        agent_reviewer: makeTestAgentConfig({ id: 'agent_reviewer', name: 'Revisor', allowedTools: ['finish'] }),
      }),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'delegale la revisión del módulo X a mi agente revisor', 'agent');
    await waitTerminal(runs, runId);

    const parentRun = await runs.get(runId);
    expect(parentRun?.state).toBe('completed');
    expect(parentRun?.delegationDepth ?? 0).toBe(0);

    const toolCallsAll = [...(deps.toolCalls as ReturnType<typeof makeFakeToolCallRepository>).all.values()];
    const delegateCall = toolCallsAll.find((c) => c.toolName === 'delegate');
    expect(delegateCall?.category).toBe('delegate');
    expect(delegateCall?.status).toBe('done');
    expect(delegateCall?.resultIsError).toBe(false);

    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    const delegatedEvent = events.find((e): e is Extract<RunEvent, { type: 'run.delegated' }> => e.type === 'run.delegated');
    expect(delegatedEvent).toBeDefined();
    expect(delegatedEvent?.targetAgentId).toBe('agent_reviewer');
    expect(delegatedEvent?.parentRunId).toBe(runId);
    expect(delegatedEvent?.toolCallId).toBe('call_delegate');

    const childRun = await runs.get(delegatedEvent!.childRunId);
    expect(childRun?.parentRunId).toBe(runId);
    expect(childRun?.delegationDepth).toBe(1);
    expect(childRun?.state).toBe('completed');

    const childChat = await deps.chats.get(delegatedEvent!.childChatId);
    expect(childChat?.originRunId).toBe(runId);
    expect(childChat?.agentId).toBe('agent_reviewer');
  });

  it('T07: sin targetAgentId crea un worker efímero (owner_kind worker) vía agentProfiles, nunca uno "personal"', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_delegate', name: 'delegate', args: { role: 'explorer', task: 'explorar el repo', expectedDeliverable: 'mapa de módulos' }, transport: 'native' } },
        doneChunk,
      ],
      [
        { type: 'tool_call', call: { id: 'call_finish_child', name: 'finish', args: { summary: 'listo' } , transport: 'native' } },
        doneChunk,
      ],
      [
        { type: 'tool_call', call: { id: 'call_finish_parent', name: 'finish', args: { summary: 'listo, delegado a un worker' }, transport: 'native' } },
        doneChunk,
      ],
    ];
    const agentProfiles = makeFakeAgentProfilePort();
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      tools: makeFakeToolRegistry([makeFinishTool(), makeDelegateToolStub()]),
      agents: makeFakeAgentConfigResolver(makeTestAgentConfig({ allowedTools: ['finish', 'delegate'] })),
      agentProfiles,
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'exploración rápida, no me importa quién', 'agent');
    await waitTerminal(runs, runId);

    expect(agentProfiles.created).toHaveLength(1);
    expect(agentProfiles.created[0]?.ownerKind).toBe('worker');
    expect(agentProfiles.created[0]?.input.role).toBe('explorer');

    const parentRun = await runs.get(runId);
    expect(parentRun?.state).toBe('completed');
  });

  it('sin targetAgentId y sin agentProfiles inyectado, falla la delegación con un ToolResult de error (no rompe el run)', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_delegate', name: 'delegate', args: { task: 't', expectedDeliverable: 'd' }, transport: 'native' } },
        doneChunk,
      ],
      [
        { type: 'tool_call', call: { id: 'call_finish', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        doneChunk,
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      tools: makeFakeToolRegistry([makeFinishTool(), makeDelegateToolStub()]),
      agents: makeFakeAgentConfigResolver(makeTestAgentConfig({ allowedTools: ['finish', 'delegate'] })),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'delegá sin decir a quién', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.state).toBe('completed'); // el error de delegate no rompe el run padre
    const delegateCall = [...(deps.toolCalls as ReturnType<typeof makeFakeToolCallRepository>).all.values()]
      .find((c) => c.toolName === 'delegate');
    expect(delegateCall?.resultIsError).toBe(true);
    expect(delegateCall?.resultPreview).toMatch(/agentProfiles/);
  });

  it('profundidad máxima 1: un run que ya es hijo de una delegación no puede delegar de nuevo', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_delegate', name: 'delegate', args: { task: 't', expectedDeliverable: 'd' }, transport: 'native' } },
        doneChunk,
      ],
      [
        { type: 'tool_call', call: { id: 'call_finish', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        doneChunk,
      ],
    ];
    const childChat = makeTestChat({ id: 'chat_child', originRunId: 'parent_run_x' });
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      tools: makeFakeToolRegistry([makeFinishTool(), makeDelegateToolStub()]),
      agents: makeFakeAgentConfigResolver(makeTestAgentConfig({ allowedTools: ['finish', 'delegate'] })),
      chats: makeFakeChatRepository([makeTestChat(), childChat]),
    });
    // Run padre pre-sembrado (profundidad 0) para que `start()` pueda derivar delegationDepth = 1
    // del chat hijo (chats.origin_run_id -> parent_run_x).
    await deps.runs.create({
      id: 'parent_run_x', chatId: 'chat_1', agentId: 'agent_1', mode: 'agent', state: 'completed',
      iteration: 1, lastEventSeq: 1, createdAt: 0, delegationDepth: 0,
    });

    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_child', 'seguí la tarea delegada', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.delegationDepth).toBe(1);
    expect(run?.state).toBe('completed');

    const delegateCall = [...(deps.toolCalls as ReturnType<typeof makeFakeToolCallRepository>).all.values()]
      .find((c) => c.toolName === 'delegate');
    expect(delegateCall?.resultIsError).toBe(true);
    expect(delegateCall?.resultPreview).toMatch(/profundidad máxima/);

    // Ningún chat nuevo se creó (solo los dos ya sembrados: el original + el "hijo" de prueba).
    const chatsInProject = await deps.chats.listByProject('project_1');
    expect(chatsInProject).toHaveLength(2);
  });

  it('máximo 3 delegaciones por run: la 4ta se rechaza sin crear un run/chat nuevo', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_delegate_4', name: 'delegate', args: { task: 't4', expectedDeliverable: 'd4' }, transport: 'native' } },
        doneChunk,
      ],
      [
        { type: 'tool_call', call: { id: 'call_finish', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        doneChunk,
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      tools: makeFakeToolRegistry([makeFinishTool(), makeDelegateToolStub()]),
      agents: makeFakeAgentConfigResolver(makeTestAgentConfig({ allowedTools: ['finish', 'delegate'] })),
    });
    // Primer id que asigna start() es el runId (ver RunController.start(): `ids.next()` antes que
    // cualquier otro consumidor) — con `makeFakeIds()` fresco eso es siempre 'id_1'.
    const runId = 'id_1';
    for (let i = 0; i < 3; i += 1) {
      await deps.toolCalls.upsert({
        id: `prior_delegate_${i}`, runId, iteration: 0, toolName: 'delegate', args: {},
        argsHash: `hash_${i}`, category: 'delegate', risk: 'low', transport: 'native', status: 'done',
      });
    }

    const controller = new RunController(deps);
    const started = await controller.start('chat_1', 'delegá una cuarta vez', 'agent');
    expect(started.runId).toBe(runId);
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.state).toBe('completed');

    const delegateCall = [...(deps.toolCalls as ReturnType<typeof makeFakeToolCallRepository>).all.values()]
      .find((c) => c.id === 'call_delegate_4');
    expect(delegateCall?.resultIsError).toBe(true);
    expect(delegateCall?.resultPreview).toMatch(/límite de delegaciones/);

    const chatsInProject = await deps.chats.listByProject('project_1');
    expect(chatsInProject).toHaveLength(1); // ningún chat hijo nuevo
  });

  it('targetAgentId inexistente se rechaza sin inventar un destino (el modelo no puede alucinar un id)', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_delegate', name: 'delegate', args: { targetAgentId: 'agent_no_existe', task: 't', expectedDeliverable: 'd' }, transport: 'native' } },
        doneChunk,
      ],
      [
        { type: 'tool_call', call: { id: 'call_finish', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        doneChunk,
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      tools: makeFakeToolRegistry([makeFinishTool(), makeDelegateToolStub()]),
      agents: makeMultiAgentConfigResolver({
        agent_1: makeTestAgentConfig({ allowedTools: ['finish', 'delegate'] }),
      }),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'delegale a un agente que no existe', 'agent');
    await waitTerminal(runs, runId);

    const delegateCall = [...(deps.toolCalls as ReturnType<typeof makeFakeToolCallRepository>).all.values()]
      .find((c) => c.toolName === 'delegate');
    expect(delegateCall?.resultIsError).toBe(true);
    expect(delegateCall?.resultPreview).toMatch(/no existe el agente/);
    const chatsInProject = await deps.chats.listByProject('project_1');
    expect(chatsInProject).toHaveLength(1);
  });
});

// Feedback real v0.2.1, punto 1a/8: Chat.permissionPreset (chat:setPermissionPreset) tiene que
// pisar el preset del agente para ESTE run.
describe('RunController — preset de permisos por chat', () => {
  it('Chat.permissionPreset viaja hasta PermissionEngine.evaluate() en cada tool call', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'list_files', args: { path: '.' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
      [
        { type: 'tool_call', call: { id: 'call_2', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const recording = makeRecordingPermissionEngine();
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      chats: makeFakeChatRepository([makeTestChat({ permissionPreset: 'full_in_folder' })]),
      permissions: recording,
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'listá archivos', 'agent');
    await waitTerminal(runs, runId);

    expect(recording.seenPresets).toContain('full_in_folder');
  });

  it('Chat.effort "fast" reduce maxIterations/numPredict y apaga thinking', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const baseAgent = makeTestAgentConfig();
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      chats: makeFakeChatRepository([makeTestChat({ effort: 'fast' })]),
      agents: makeFakeAgentConfigResolver(baseAgent),
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'hola', 'agent');
    await waitTerminal(runs, runId);

    const run = await runs.get(runId);
    expect(run?.effectiveConfig?.think).toBe(false);
    expect(run?.effectiveConfig?.numCtx).toBe(baseAgent.contextPolicy.numCtx); // effort no toca numCtx
  });

  it('sin Chat.permissionPreset, usa el preset del agente (comportamiento previo)', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const recording = makeRecordingPermissionEngine();
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      chats: makeFakeChatRepository([makeTestChat()]),
      permissions: recording,
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'hola', 'agent');
    await waitTerminal(runs, runId);

    // `finish` no pasa por evaluate() (RunController.runFinish la intercepta antes) — este caso solo
    // confirma que el run no se rompe sin permissionPreset; el propagado ya lo cubre el test de arriba.
    await expect(runs.get(runId)).resolves.toMatchObject({ state: 'completed' });
  });
});

describe('RunController — policy efectiva del máximo confirmado', () => {
  it('usa 40k para presupuesto, historia y numPredict aunque el agente persistido tenga policy de 8k', async () => {
    const agent = makeTestAgentConfig();
    const gateway = makeScriptedGateway([]);
    const history: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
      id: `history-40k-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(4_000),
    }));
    const { deps, runs } = baseDeps({
      agents: makeFakeAgentConfigResolver(agent),
      gateway,
      context: createContextBuilder(createTokenEstimator(agent.model)),
      numCtxForModel: async () => 40_960,
      modelContextProbe: { getContextMax: async () => 40_960 },
    });
    (deps.messages as ReturnType<typeof makeFakeMessageRepository>).byChat.set('chat_1', history);

    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'seguí', 'agent');
    await waitTerminal(runs, runId);

    const effectivePolicy = contextPolicyForNumCtx(40_960, agent.contextPolicy);
    const request = gateway.requests[0];
    expect(request?.options.numCtx).toBe(40_960);
    expect(request?.options.numPredict).toBe(effectivePolicy.reserveForResponse);
    expect(request?.messages.filter((message) => message.id.startsWith('history-40k-'))).toHaveLength(history.length);

    const event = (deps.events as ReturnType<typeof makeFakeEventStore>).all.find((candidate) => candidate.type === 'context.built');
    expect(event?.type).toBe('context.built');
    if (!event || event.type !== 'context.built') throw new Error('faltó context.built');
    expect(event.budget).toMatchObject({
      numCtx: 40_960,
      effectiveNumCtx: 40_960,
      reserveForResponse: effectivePolicy.reserveForResponse,
      contextLimitSource: 'reported',
      fits: true,
    });
    expect(event.budget.used.history).toBeGreaterThan(8_192);
  });

  it('preserva el entregable real del worker y sólo devuelve artifacts existentes dentro del proyecto', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saurio-delegate-result-'));
    writeFileSync(join(projectRoot, 'ideas.txt'), 'Luna\nMax\nBella\n', 'utf8');
    mkdirSync(join(projectRoot, '.git'));
    writeFileSync(join(projectRoot, '.git', 'config'), '[core]\n', 'utf8');
    symlinkSync(join(projectRoot, '.git'), join(projectRoot, 'safe-link'), 'junction');
    try {
      const scripts: ChatChunk[][] = [
        [
          { type: 'tool_call', call: { id: 'call_delegate', name: 'delegate', args: { targetAgentId: 'agent_reviewer', task: 'proponer nombres', expectedDeliverable: 'tres nombres concretos' }, transport: 'native' } },
          doneChunk,
        ],
        [
          { type: 'content', text: '1. Luna\n2. Max\n3. Bella' },
          {
            type: 'tool_call',
            call: {
              id: 'call_finish_child', name: 'finish', transport: 'native', args: {
                summary: JSON.stringify({
                  status: 'completed', summary: 'Se proporcionaron tres ideas.',
                  artifacts: [
                    { path: 'ideas.txt', description: 'nombres reales' },
                    { path: 'fantasma.txt', description: 'archivo inexistente' },
                    { path: 'safe-link/config', description: 'alias a ruta protegida' },
                  ],
                }),
              },
            },
          },
          doneChunk,
        ],
        [
          { type: 'tool_call', call: { id: 'call_finish_parent', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
          doneChunk,
        ],
      ];
      const gateway = makeScriptedGateway(scripts);
      // SqliteEventStore proyecta `message.done` a MessageRepository en la misma transacción. El
      // fake base sólo guarda eventos; para probar buildDelegationResult se replica esa proyección.
      const messages = makeFakeMessageRepository();
      const events = makeFakeEventStore();
      const appendEvent = events.append.bind(events);
      events.append = (event) => {
        const persisted = appendEvent(event);
        if (persisted.type === 'message.done') {
          const chatMessages = messages.byChat.get(persisted.chatId) ?? [];
          chatMessages.push(persisted.message);
          messages.byChat.set(persisted.chatId, chatMessages);
        }
        return persisted;
      };
      const { deps, runs } = baseDeps({
        gateway,
        events,
        messages,
        projectRoot,
        workspaceFs: new WorkspaceFsImpl(projectRoot),
        // La lectura real de SAURIO.md cede al event loop. El polling de delegación también debe
        // ceder: el delay instantáneo de baseDeps avanzaría 120k ticks del reloj fake antes de que
        // el fs asíncrono del hijo pueda resolver y lo cancelaría artificialmente.
        delay: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); },
        tools: makeFakeToolRegistry([makeFinishTool(), makeDelegateToolStub()]),
        agents: makeMultiAgentConfigResolver({
          agent_1: makeTestAgentConfig({ allowedTools: ['finish', 'delegate'] }),
          agent_reviewer: makeTestAgentConfig({ id: 'agent_reviewer', name: 'Revisor', allowedTools: ['finish'] }),
        }),
      });
      const controller = new RunController(deps);
      const { runId } = await controller.start('chat_1', 'delegá tres nombres', 'agent');
      await waitTerminal(runs, runId);

      const parentRequest = gateway.requests[2];
      const delegateMessage = parentRequest?.messages.find((message) => message.toolName === 'delegate');
      expect(delegateMessage).toBeDefined();
      const result = DelegationResultSchema.parse(JSON.parse(delegateMessage!.content));
      expect(result.summary).toContain('Se proporcionaron tres ideas.');
      expect(result.summary).toContain('Luna');
      expect(result.summary).toContain('Max');
      expect(result.summary).toContain('Bella');
      expect(result.artifacts).toEqual([{ path: 'ideas.txt', description: 'nombres reales' }]);
      expect(result.uncertainties).toContain('artifact excluido porque no se pudo verificar dentro del proyecto: "fantasma.txt"');
      expect(result.uncertainties).toContain('artifact excluido porque no se pudo verificar dentro del proyecto: "safe-link/config"');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('si el máximo confirmado es 4k, poda y reserva contra 4k aunque la policy persistida sea 8k', async () => {
    const agent = makeTestAgentConfig();
    const gateway = makeScriptedGateway([]);
    const history: ChatMessage[] = Array.from({ length: 8 }, (_, index) => ({
      id: `history-4k-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: 'y'.repeat(4_000),
    }));
    const { deps, runs } = baseDeps({
      agents: makeFakeAgentConfigResolver(agent),
      gateway,
      context: createContextBuilder(createTokenEstimator(agent.model)),
      numCtxForModel: async () => 8_192,
      modelContextProbe: { getContextMax: async () => 4_096 },
    });
    (deps.messages as ReturnType<typeof makeFakeMessageRepository>).byChat.set('chat_1', history);

    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'seguí', 'agent');
    await waitTerminal(runs, runId);

    const effectivePolicy = contextPolicyForNumCtx(4_096, agent.contextPolicy);
    const request = gateway.requests[0];
    expect(request?.options.numCtx).toBe(4_096);
    expect(request?.options.numPredict).toBe(effectivePolicy.reserveForResponse);
    expect(request?.messages.filter((message) => message.id.startsWith('history-4k-')).length).toBeLessThan(history.length);

    const event = (deps.events as ReturnType<typeof makeFakeEventStore>).all.find((candidate) => candidate.type === 'context.built');
    expect(event?.type).toBe('context.built');
    if (!event || event.type !== 'context.built') throw new Error('faltó context.built');
    expect(event.budget).toMatchObject({
      numCtx: 4_096,
      effectiveNumCtx: 4_096,
      reserveForResponse: effectivePolicy.reserveForResponse,
      contextLimitSource: 'reported',
      fits: true,
    });
    expect(event.budget.totalUsed).toBeLessThanOrEqual(4_096 - effectivePolicy.reserveForResponse);
  });
});

// Punto 1c/9 del encargo (feedback real v0.2.1): adjuntos de archivo/imagen en run:start.
describe('RunController — adjuntos', () => {
  it('un adjunto de texto se inserta como bloque de contexto acotado en el mensaje del usuario', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({ gateway: makeScriptedGateway(scripts) });
    const controller = new RunController(deps);
    const contenido = Buffer.from('contenido del archivo adjunto').toString('base64');
    const { runId } = await controller.start('chat_1', 'mirá este archivo', 'agent', [
      { kind: 'file', name: 'notas.txt', mime: 'text/plain', dataBase64: contenido },
    ]);
    await waitTerminal(runs, runId);

    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    const userMsg = events.find((e) => e.type === 'message.done' && e.message.role === 'user');
    expect(userMsg && userMsg.type === 'message.done' ? userMsg.message.content : '').toContain('contenido del archivo adjunto');
    expect(userMsg && userMsg.type === 'message.done' ? userMsg.message.content : '').toContain('Adjunto: notas.txt');
  });

  it('un adjunto de imagen sin modelVisionProbe rechaza el run con error accionable', async () => {
    const { deps } = baseDeps({ gateway: makeScriptedGateway([]) });
    const controller = new RunController(deps);
    await expect(
      controller.start('chat_1', 'mirá esta foto', 'agent', [
        { kind: 'image', name: 'foto.png', mime: 'image/png', dataBase64: 'ZmFrZQ==' },
      ]),
    ).rejects.toThrow(/no confirma soporte de imágenes/);
  });

  it('un adjunto de imagen con modelVisionProbe true se acepta y va al campo images', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      modelVisionProbe: { hasVision: async () => true },
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'mirá esta foto', 'agent', [
      { kind: 'image', name: 'foto.png', mime: 'image/png', dataBase64: 'ZmFrZQ==' },
    ]);
    await waitTerminal(runs, runId);

    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    const userMsg = events.find((e) => e.type === 'message.done' && e.message.role === 'user');
    expect(userMsg && userMsg.type === 'message.done' ? userMsg.message.images : undefined).toEqual(['ZmFrZQ==']);
  });
});

// Punto 10 del encargo (feedback real v0.2.1): aviso de "modelo chico" en modo agente.
describe('RunController — aviso de modelo chico (run.smallModelWarning)', () => {
  it('emite el aviso una sola vez en modo agente si el modelo declara < 7B parámetros', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      modelParameterSizeProbe: { getParameterSize: async () => '3.8B' },
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'hola', 'agent');
    await waitTerminal(runs, runId);

    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    const warnings = events.filter((e) => e.type === 'run.smallModelWarning');
    expect(warnings).toHaveLength(1);
  });

  it('no emite nada si el modelo declara >= 7B parámetros', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({
      gateway: makeScriptedGateway(scripts),
      modelParameterSizeProbe: { getParameterSize: async () => '8B' },
    });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'hola', 'agent');
    await waitTerminal(runs, runId);

    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    expect(events.some((e) => e.type === 'run.smallModelWarning')).toBe(false);
  });

  it('sin modelParameterSizeProbe, nunca emite el aviso (comportamiento previo)', async () => {
    const scripts: ChatChunk[][] = [
      [
        { type: 'tool_call', call: { id: 'call_1', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
        { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
      ],
    ];
    const { deps, runs } = baseDeps({ gateway: makeScriptedGateway(scripts) });
    const controller = new RunController(deps);
    const { runId } = await controller.start('chat_1', 'hola', 'agent');
    await waitTerminal(runs, runId);

    const events = (deps.events as ReturnType<typeof makeFakeEventStore>).all;
    expect(events.some((e) => e.type === 'run.smallModelWarning')).toBe(false);
  });
});
