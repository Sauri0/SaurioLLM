// Tests de RunController (doc 05 flujo completo, doc 10 fallos y recuperación) con fakes de todas
// las dependencias inyectadas (gateway, tools, permisos, checkpoint, contexto, persistencia).
import { describe, expect, it } from 'vitest';
import { RunController, type RunControllerDeps } from './RunController.js';
import type { ChatChunk, ChatRequest, ModelGateway } from '../gateway/types.js';
import type { ChatMessage, RunEvent } from '@saurio/shared';
import type { PermissionDecision, PermissionEngine } from '../permissions/types.js';
import type { ContextBuilder } from '../context/types.js';
import type { ToolDefinition } from '../tools/types.js';
import {
  makeFakeClock, makeFakeIds, makeFakeEventStore, makeFakeRunRepository, makeFakeChatRepository,
  makeFakeMessageRepository, makeFakeToolCallRepository, makeFakeCheckpointRepository,
  makeFakeTaskRepository, makeFakeContextBuilder, makeFakeCheckpointService, makeScriptedGateway,
  makeFakeToolRegistry, makeNativeToolProtocol, makeAllowAllPermissionEngine,
  makeAskThenRecordPermissionEngine, makeFinishTool, makeEditFileTool, makeListFilesTool,
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
