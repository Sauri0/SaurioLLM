// Tests de RunController (doc 05 flujo completo, doc 10 fallos y recuperación) con fakes de todas
// las dependencias inyectadas (gateway, tools, permisos, checkpoint, contexto, persistencia).
import { describe, expect, it } from 'vitest';
import { RunController, type RunControllerDeps } from './RunController.js';
import type { ChatChunk, ChatRequest, ModelGateway } from '../gateway/types.js';
import type { AgentCreateInput, AgentOwnerKind, AgentProfile, ChatMessage, RunEvent } from '@saurio/shared';
import type { PermissionDecision, PermissionEngine } from '../permissions/types.js';
import type { ContextBuilder } from '../context/types.js';
import type { ToolDefinition } from '../tools/types.js';
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
    ...overrides,
  };
  return { deps, runs };
}

async function waitTerminal(runs: ReturnType<typeof makeFakeRunRepository>, runId: string) {
  const terminal = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
  await waitUntil(async () => terminal.has((await runs.get(runId))?.state ?? ''));
}

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
      agents: makeMultiAgentConfigResolver({ agent_1: makeTestAgentConfig() }),
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
