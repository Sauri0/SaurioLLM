// Estado de demo para la herramienta de verificación visual (SAURIO_SMOKE_SHOT + SAURIO_SMOKE_STATE,
// ver apps/desktop/src/main/index.ts). apps/desktop/src/renderer/src/demo/demoState.ts.
//
// Objetivo: poder capturar pantallas de la UI con contenido representativo (proyecto abierto, chat
// con mensajes, una tarjeta de tool, una tarjeta de permiso, un checkpoint, tareas) sin depender de
// Ollama ni del runtime real. Solo se activa cuando la URL trae `?demoState=<json>` (que main arma a
// partir de la variable de entorno SAURIO_SMOKE_STATE); en cualquier otro caso este módulo no hace
// nada y el comportamiento de la app es exactamente el de siempre.
//
// No cambia ningún contrato IPC ni lógica de runtime: solo hace `set()`/`setState()` directo sobre
// los stores de zustand del renderer, igual que si esos datos hubieran llegado por IPC.
import type { Chat, ChatMessage, Checkpoint, PermissionRequest, Project, Task, ToolCallRecord } from '@saurio/shared';
import { useChatStore } from '../stores/chatStore.js';
import { useRunStore } from '../stores/runStore.js';
import { useModelsStore } from '../stores/modelsStore.js';

export const DEMO_PROJECT_ID = 'demo-project';
export const DEMO_CHAT_ID = 'demo-chat';
const DEMO_RUN_ID = 'demo-run';

export function getDemoStateParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('demoState');
  } catch {
    return null;
  }
}

/** `true` en cuanto la URL trae `?demoState=...`, sin importar si el JSON es válido — alcanza con
 *  la presencia del parámetro para decidir "modo demo" (evita efectos que dependen de IPC/Ollama). */
export function isDemoMode(): boolean {
  return getDemoStateParam() !== null;
}

export function demoProject(): Project {
  const now = Date.now();
  return {
    id: DEMO_PROJECT_ID,
    path: 'N:\\SaurioLLM',
    name: 'SaurioLLM',
    createdAt: now - 86_400_000,
    lastOpenedAt: now,
  };
}

function demoMessages(): ChatMessage[] {
  return [
    {
      id: 'm-user-1',
      role: 'user',
      content: 'Agregá un endpoint para listar los checkpoints de un chat y escribí un test.',
    },
    {
      id: 'm-assistant-1',
      role: 'assistant',
      thinking: 'El checkpoint ya se persiste por tool call; falta exponerlo por chat_id ordenado por fecha.',
      content:
        'Listo. Agregué `checkpoint:list` (doc 04 §9) y un test que cubre el orden cronológico y ' +
        'el caso sin checkpoints:\n\n```ts\nexport function listCheckpoints(chatId: string) {\n  return db.selectFrom(\'checkpoints\').where(\'chat_id\', \'=\', chatId).execute();\n}\n```\n\nFalta un último paso: crear el test.',
    },
  ];
}

function demoToolCalls(): ToolCallRecord[] {
  return [
    {
      id: 'tc-1',
      runId: DEMO_RUN_ID,
      messageId: 'm-assistant-1',
      iteration: 0,
      toolName: 'read_file',
      args: { path: 'packages/runtime/src/checkpoint/CheckpointService.ts' },
      argsHash: 'demo-hash-1',
      category: 'read',
      risk: 'low',
      transport: 'native',
      status: 'done',
      startedAt: Date.now() - 12_000,
      finishedAt: Date.now() - 11_600,
      resultPreview: 'export class CheckpointService {\n  async create(runId: string, toolCallId: string) { … }\n}',
    },
    {
      id: 'tc-2',
      runId: DEMO_RUN_ID,
      messageId: 'm-assistant-1',
      iteration: 1,
      toolName: 'search_files',
      args: { query: 'listCheckpoints', glob: 'packages/runtime/**/*.test.ts' },
      argsHash: 'demo-hash-2',
      category: 'read',
      risk: 'low',
      transport: 'native',
      status: 'done',
      startedAt: Date.now() - 8_000,
      finishedAt: Date.now() - 7_600,
      resultPreview: 'Sin coincidencias — no hay un test de listCheckpoints todavía.',
    },
  ];
}

function demoCheckpoint(): Checkpoint {
  return {
    id: 'cp-1',
    runId: DEMO_RUN_ID,
    chatId: DEMO_CHAT_ID,
    toolCallId: 'tc-3',
    kind: 'tool',
    files: [
      { relPath: 'packages/runtime/src/checkpoint/CheckpointService.ts', change: 'modified' },
      { relPath: 'packages/runtime/src/checkpoint/CheckpointService.test.ts', change: 'created' },
    ],
    stats: { files: 2, added: 48, removed: 6 },
    status: 'active',
  };
}

function demoTasks(): Task[] {
  return [
    { id: 't-1', chatId: DEMO_CHAT_ID, ord: 0, title: 'Leer CheckpointService actual', status: 'done' },
    { id: 't-2', chatId: DEMO_CHAT_ID, ord: 1, title: 'Agregar checkpoint:list + tipos', status: 'done' },
    { id: 't-3', chatId: DEMO_CHAT_ID, ord: 2, title: 'Escribir test de orden cronológico', status: 'in_progress' },
    { id: 't-4', chatId: DEMO_CHAT_ID, ord: 3, title: 'Actualizar doc 04 §9 con el canal nuevo', status: 'pending' },
  ];
}

function demoPermissionRequest(): PermissionRequest {
  return {
    toolCallId: 'tc-3',
    toolName: 'write_file',
    category: 'write',
    risk: 'medium',
    summary: 'Escribir packages/runtime/src/checkpoint/CheckpointService.test.ts',
    triggeredBy: 'Paso 3 del plan: "Escribir test de orden cronológico"',
    preview: {
      diff:
        '+ import { describe, it } from \'vitest\';\n' +
        '+ describe(\'listCheckpoints\', () => {\n' +
        '+   it(\'ordena por fecha\', async () => { … });\n' +
        '+ });',
    },
    rememberOptions: [
      { scope: 'project', suggestedPattern: 'write_file:packages/runtime/**' },
      { scope: 'global', suggestedPattern: 'write_file:**/*.test.ts' },
    ],
  };
}

// ── Rediseño del chat: escenario de un run LARGO y realista (varias tool calls, thinking, salida
// de terminal con ANSI, un checkpoint con 2 archivos y una respuesta final con markdown) — sirve
// para capturar el bloque "Actividad" plegado/desplegado con contenido real, no el mínimo de 2
// tool calls del escenario default. Se activa con `{"longRun": true}` en SAURIO_SMOKE_STATE. ──
const LONG_RUN_ID = 'demo-run-long';

function longRunMessages(): ChatMessage[] {
  return [
    {
      id: 'lr-user-1',
      role: 'user',
      content: 'El cliente de Ollama no distingue un timeout de una desconexión real. Arreglalo y agregá tests.',
    },
    {
      id: 'lr-assistant-1',
      role: 'assistant',
      thinking:
        'OllamaClient.request envuelve todos los errores de fetch en OllamaHttpError sin conservar la causa — ' +
        'hay que revisar AbortError por separado antes de mapear al error genérico.',
      content: '',
    },
    {
      id: 'lr-assistant-2',
      role: 'assistant',
      thinking: 'Los tests existentes mockean fetch pero ninguno cubre AbortController. Falta ese caso.',
      content:
        'Encontré la causa: `OllamaClient.request` mapeaba cualquier excepción de `fetch` (timeout, red caída, ' +
        'abort manual) al mismo `OllamaHttpError` genérico, así que el runtime nunca podía distinguirlas para ' +
        'decidir si reintentar. Separé el caso `AbortError` (se re-lanza tal cual, sin envolver) y agregué un ' +
        'código `network_unreachable` para el resto:\n\n' +
        '```ts\ncatch (err) {\n  if (isAbortError(err)) throw err;\n  throw new OllamaHttpError(\'network_unreachable\', err);\n}\n```\n\n' +
        'Corrí la suite de `client.test.ts` (quedó en verde, ver actividad) y agregué 2 casos nuevos: timeout ' +
        'real con `AbortController` y desconexión (`ECONNREFUSED` simulado). También quedó un checkpoint con ' +
        'los 2 archivos tocados — podés revisarlo o deshacerlo desde la tarjeta de abajo.',
    },
  ];
}

function longRunToolCalls(): ToolCallRecord[] {
  const base = Date.now() - 60_000;
  return [
    {
      id: 'lr-tc-1', runId: LONG_RUN_ID, messageId: 'lr-assistant-1', iteration: 0,
      toolName: 'read_file', args: { path: 'packages/runtime/src/gateway/providers/ollama/client.ts' },
      argsHash: 'demo-lr-1', category: 'read', risk: 'low', transport: 'native', status: 'done',
      startedAt: base, finishedAt: base + 400,
      resultPreview: 'export class OllamaClient {\n  private async request(...) { ... }\n}',
    },
    {
      id: 'lr-tc-2', runId: LONG_RUN_ID, messageId: 'lr-assistant-1', iteration: 1,
      toolName: 'search_files', args: { query: 'AbortError', glob: 'packages/runtime/src/gateway/**' },
      argsHash: 'demo-lr-2', category: 'read', risk: 'low', transport: 'native', status: 'done',
      startedAt: base + 500, finishedAt: base + 900,
      resultPreview: 'Sin coincidencias — AbortError nunca se maneja distinto del resto.',
    },
    {
      id: 'lr-tc-3', runId: LONG_RUN_ID, messageId: 'lr-assistant-2', iteration: 2,
      toolName: 'edit_file', args: { path: 'packages/runtime/src/gateway/providers/ollama/client.ts' },
      argsHash: 'demo-lr-3', category: 'write', risk: 'medium', transport: 'native', status: 'done',
      startedAt: base + 1_000, finishedAt: base + 1_500,
      resultPreview: '2 bloques reemplazados.',
    },
    {
      id: 'lr-tc-4', runId: LONG_RUN_ID, messageId: 'lr-assistant-2', iteration: 3,
      toolName: 'write_file', args: { path: 'packages/runtime/src/gateway/providers/ollama/client.test.ts' },
      argsHash: 'demo-lr-4', category: 'write', risk: 'medium', transport: 'native', status: 'done',
      startedAt: base + 1_600, finishedAt: base + 1_900,
      resultPreview: 'Archivo creado (+38 líneas).',
    },
    {
      id: 'lr-tc-5', runId: LONG_RUN_ID, messageId: 'lr-assistant-2', iteration: 4,
      toolName: 'run_command', args: { command: 'npx vitest run client.test.ts' },
      argsHash: 'demo-lr-5', category: 'terminal', risk: 'medium', transport: 'native', status: 'done',
      startedAt: base + 2_000, finishedAt: base + 4_800,
      // Salida con códigos ANSI reales (verde PASS, negrita del resumen) — para verificar que
      // ToolCallCard los limpia (stripAnsi) en vez de mostrar "[32m" literal en pantalla.
      resultPreview:
        '[32m✓[0m client.test.ts (7 tests) 312ms\n' +
        '[1m[32mTest Files[0m  1 passed (1)\n' +
        '[1m     Tests[0m  7 passed (7)',
    },
  ];
}

function longRunCheckpoint(): Checkpoint {
  return {
    id: 'lr-cp-1', runId: LONG_RUN_ID, chatId: DEMO_CHAT_ID, toolCallId: 'lr-tc-3', kind: 'tool',
    files: [
      { relPath: 'packages/runtime/src/gateway/providers/ollama/client.ts', change: 'modified' },
      { relPath: 'packages/runtime/src/gateway/providers/ollama/client.test.ts', change: 'created' },
    ],
    stats: { files: 2, added: 52, removed: 4 },
    status: 'active',
  };
}

function demoChat(): Chat {
  const now = Date.now();
  return {
    id: DEMO_CHAT_ID,
    projectId: DEMO_PROJECT_ID,
    agentId: 'agent_builtin_lead',
    title: 'Checkpoints por chat',
    mode: 'agent',
    modelRef: { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' },
    createdAt: now - 3_600_000,
    updatedAt: now - 30_000,
    archived: false,
  };
}

export interface DemoStateOptions {
  /** `true`: no siembra la tarjeta de permiso pendiente (ni la tool call que la dispara). Sirve
   *  para capturar una pantalla del chat con tool calls + checkpoint + tareas visibles sin que el
   *  scroll automático al fondo (ChatMessageList) los empuje fuera de la vista por la tarjeta de
   *  permiso, que siempre es el último elemento de la conversación. */
  omitPermission?: boolean;
  /** Pestaña inicial del panel derecho (`layout/RightPanel.tsx`) — solo para la herramienta de
   *  verificación visual: `SAURIO_SMOKE_SHOT` no tiene forma de "hacer clic" en una pestaña antes
   *  de capturar, así que esto deja elegirla desde `SAURIO_SMOKE_STATE` sin agregar ningún control
   *  nuevo a la UI real (fuera de modo demo, `getDemoRightPanelTab()` siempre devuelve `undefined`). */
  rightPanelTab?: string;
  /** Tarea "carga de modelo/oom_load": siembra el run del chat como `failed`/`oom_load` (en vez de
   *  `awaiting_permission`) para poder capturar `OomLoadCard` sin depender de una GPU real sin
   *  memoria. Implica `omitPermission` (no tiene sentido mostrar las dos tarjetas terminales a la
   *  vez — la de permiso es de un run en curso, la de oom_load es de uno ya fallado). */
  oomError?: boolean;
  /** Rediseño del chat: reemplaza el escenario default por un run LARGO ya terminado (varias tool
   *  calls de distintas categorías, thinking en dos mensajes, salida de terminal con ANSI, un
   *  checkpoint de 2 archivos) — para capturar el bloque "Actividad" plegado (resumen con conteos)
   *  y desplegado (detalle cronológico) con contenido representativo de un run real, no el mínimo
   *  de 2 tool calls del escenario default. */
  longRun?: boolean;
  /** Rediseño del chat: el run largo de `longRun` pero TODAVÍA CORRIENDO (una tool call en estado
   *  `running`, sin mensaje final) — para capturar la línea viva del bloque "Actividad" con spinner
   *  y el aviso de "modelo chico para modo Agente". */
  liveRun?: boolean;
}

function parseDemoStateOptions(raw: string | null): DemoStateOptions {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const opts = parsed as Record<string, unknown>;
    return {
      omitPermission: opts['omitPermission'] === true,
      rightPanelTab: typeof opts['rightPanelTab'] === 'string' ? opts['rightPanelTab'] : undefined,
      oomError: opts['oomError'] === true,
      longRun: opts['longRun'] === true,
      liveRun: opts['liveRun'] === true,
    };
  } catch {
    return {};
  }
}

/** Ver `DemoStateOptions.rightPanelTab`. */
export function getDemoRightPanelTab(): string | undefined {
  return parseDemoStateOptions(getDemoStateParam()).rightPanelTab;
}

/** Siembra un proyecto + chat con mensajes, una tool call hecha, una tarjeta de permiso pendiente,
 *  un checkpoint y tareas — la combinación que pide la herramienta de verificación visual. Se llama
 *  una sola vez, antes de `wireIpcEvents()`, para que no compita con eventos reales en vivo. */
/** Escenario `longRun`/`liveRun` (ver `DemoStateOptions`) — separado de `seedDemoState` para no
 *  enredar el escenario default (permiso pendiente) con este, que tiene su propio run/chat de
 *  mensajes más largo. `live`: deja la última tool call (el comando) en `running`, sin mensaje
 *  final ni checkpoint todavía (el run "está corriendo"); si no, el run queda `completed` con todo
 *  resuelto (checkpoint incluido). */
function seedLongRunScenario(live: boolean): void {
  const toolCalls = longRunToolCalls();
  const messages = live ? [longRunMessages()[0]!, longRunMessages()[1]!] : longRunMessages();
  const calls = live
    ? toolCalls.map((c, i) => (i === toolCalls.length - 1 ? { ...c, status: 'running' as const, finishedAt: undefined } : c))
    : toolCalls;

  useChatStore.setState((state) => ({
    ...state,
    chatsByProject: { ...state.chatsByProject, [DEMO_PROJECT_ID]: [demoChat()] },
    currentChatId: DEMO_CHAT_ID,
    modeByChat: { ...state.modeByChat, [DEMO_CHAT_ID]: 'agent' },
    draftModelRefByProject: {
      ...state.draftModelRefByProject,
      [DEMO_PROJECT_ID]: { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' },
    },
    historyLoaded: { ...state.historyLoaded, [DEMO_CHAT_ID]: true },
  }));

  useRunStore.setState((state) => ({
    ...state,
    runStates: { ...state.runStates, [LONG_RUN_ID]: live ? 'generating' : 'completed' },
    runChatIds: { ...state.runChatIds, [LONG_RUN_ID]: DEMO_CHAT_ID },
    runStartedAt: { ...state.runStartedAt, [LONG_RUN_ID]: Date.now() - 62_000 },
    messagesByChat: { ...state.messagesByChat, [DEMO_CHAT_ID]: messages },
    metricsByMessage: live ? state.metricsByMessage : {
      ...state.metricsByMessage,
      'lr-assistant-2': {
        promptTokens: 5840, cachedPromptTokens: 3200, evalTokens: 410,
        loadMs: 260, promptEvalMs: 190, evalMs: 6100, totalMs: 6550,
        quality: 'measured',
      },
    },
    toolCalls: { ...state.toolCalls, ...Object.fromEntries(calls.map((c) => [c.id, c])) },
    toolCallOrderByRun: { ...state.toolCallOrderByRun, [LONG_RUN_ID]: calls.map((c) => c.id) },
    checkpointsByChat: live ? state.checkpointsByChat : { ...state.checkpointsByChat, [DEMO_CHAT_ID]: [longRunCheckpoint()] },
    // Ya hubo tool calls resueltas antes del comando en curso (lr-tc-1..4 `done`) — sin un
    // `streaming` sembrado, `ModelLoadingBanner` (hasFirstChunk = algún `streaming.runId` visto)
    // muestra "Cargando modelo…" a la vez que la línea viva ya dice "Ejecutando…", inconsistente.
    // Un `StreamingMessage` vacío alcanza para que `hasFirstChunk` sea `true`, igual que en un run
    // real donde ya llegó contenido de un turno anterior del mismo run.
    streaming: live
      ? { ...state.streaming, 'lr-streaming': { id: 'lr-streaming', chatId: DEMO_CHAT_ID, runId: LONG_RUN_ID, content: '', thinking: '' } }
      : state.streaming,
    // run.activity ya calculado "del lado del runtime" (contrato aditivo) — la línea viva del
    // bloque Actividad lo prioriza sobre cualquier heurística local (ChatMessageList.liveHeaderLabel).
    activityByRun: live
      ? { ...state.activityByRun, [LONG_RUN_ID]: { phase: 'running_command', label: 'Ejecutando: npx vitest run client.test.ts', toolCallId: 'lr-tc-5', ts: Date.now() } }
      : state.activityByRun,
    // Punto 6 del rediseño: aviso de modelo chico — se aprovecha este escenario para capturarlo
    // también (qwen2.5:1.5b es chico para modo Agente).
    smallModelWarningByRun: live
      ? { ...state.smallModelWarningByRun, [LONG_RUN_ID]: { modelRef: { providerId: 'ollama', name: 'qwen2.5:1.5b', locality: 'local' }, parameterSize: '1.5B' } }
      : state.smallModelWarningByRun,
    contextBudgetByChat: {
      ...state.contextBudgetByChat,
      [DEMO_CHAT_ID]: {
        numCtx: 40960, effectiveNumCtx: 8192, reserveForResponse: 512,
        used: { system: 300, tools: 1200, repoMap: 0, memory: 0, history: 2400 }, totalUsed: 3900, fits: true,
      },
    },
  }));

  useModelsStore.setState((state) => ({
    ...state,
    installed: [
      {
        ref: { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' },
        digest: 'sha256:demo', sizeBytes: 5_100_000_000, family: 'qwen3',
        parameterSize: '8B', quantization: 'Q4_K_M',
        capabilities: { tools: true, thinking: true, vision: false, embedding: false },
        contextMax: 8192,
      },
    ],
    loaded: [{ name: 'qwen3:8b', digest: 'sha256:demo', size: 5_100_000_000, sizeVram: 5_100_000_000, contextLength: 8192, expiresAt: new Date(Date.now() + 300_000).toISOString() }],
  }));
}

export function seedDemoState(): void {
  const options = parseDemoStateOptions(getDemoStateParam());
  if (options.longRun || options.liveRun) {
    seedLongRunScenario(Boolean(options.liveRun));
    return;
  }
  useChatStore.setState((state) => ({
    ...state,
    chatsByProject: { ...state.chatsByProject, [DEMO_PROJECT_ID]: [demoChat()] },
    currentChatId: DEMO_CHAT_ID,
    modeByChat: { ...state.modeByChat, [DEMO_CHAT_ID]: 'agent' },
    draftModelRefByProject: {
      ...state.draftModelRefByProject,
      [DEMO_PROJECT_ID]: { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' },
    },
    // ya "cargado": evita que ChatPanel dispare loadHistory() (IPC real) al montar.
    historyLoaded: { ...state.historyLoaded, [DEMO_CHAT_ID]: true },
  }));

  const toolCalls = demoToolCalls();
  const omitPermission = options.omitPermission || options.oomError;
  useRunStore.setState((state) => ({
    ...state,
    runStates: { ...state.runStates, [DEMO_RUN_ID]: options.oomError ? 'failed' : 'awaiting_permission' },
    runChatIds: { ...state.runChatIds, [DEMO_RUN_ID]: DEMO_CHAT_ID },
    messagesByChat: { ...state.messagesByChat, [DEMO_CHAT_ID]: demoMessages() },
    metricsByMessage: {
      ...state.metricsByMessage,
      'm-assistant-1': {
        promptTokens: 3120, cachedPromptTokens: 2048, evalTokens: 186,
        loadMs: 410, promptEvalMs: 380, evalMs: 4120, totalMs: 4910,
        quality: 'measured',
      },
    },
    toolCalls: { ...state.toolCalls, ...Object.fromEntries(toolCalls.map((c) => [c.id, c])) },
    toolCallOrderByRun: { ...state.toolCallOrderByRun, [DEMO_RUN_ID]: toolCalls.map((c) => c.id) },
    checkpointsByChat: { ...state.checkpointsByChat, [DEMO_CHAT_ID]: [demoCheckpoint()] },
    tasksByChat: { ...state.tasksByChat, [DEMO_CHAT_ID]: demoTasks() },
    pendingPermissions: omitPermission
      ? state.pendingPermissions
      : { ...state.pendingPermissions, 'tc-3': demoPermissionRequest() },
    // Tarea "carga de modelo/oom_load": mismo texto real que reportó el usuario con iGPU
    // Intel Arc/Vulkan (ver packages/runtime/src/gateway/providers/ollama/errors.test.ts) — para que
    // la captura de OomLoadCard muestre un mensaje real, no uno inventado para la demo.
    errorsByRun: options.oomError
      ? {
        ...state.errorsByRun,
        [DEMO_RUN_ID]: [{
          code: 'oom_load' as const,
          message: 'llama-server reported out-of-memory during startup: GGML_ASSERT(buffer) failed alloc_tensor_range: failed to allocate Vulkan0 buffer of size 1072462848 (se reintentó bajando las capas en GPU hasta usar solo CPU y el modelo tampoco entró — probá con un modelo más chico)',
        }],
      }
      : state.errorsByRun,
  }));

  // tc-3 (la tool call del permiso pendiente) tiene que existir para que ChatMessageList la matchee
  // contra `activeRunId` (busca `toolCalls[req.toolCallId]?.runId === activeRunId`) — y además entrar
  // en `toolCallOrderByRun` para que la línea viva del bloque "Actividad" la reconozca como el paso
  // en curso (`currentRunToolCalls`, ChatMessageList.tsx) y muestre "Esperando tu permiso: write_file"
  // en vez de caer al genérico "Trabajando…".
  if (!omitPermission) {
    useRunStore.setState((state) => ({
      ...state,
      toolCalls: {
        ...state.toolCalls,
        'tc-3': {
          id: 'tc-3', runId: DEMO_RUN_ID, iteration: 2, toolName: 'write_file',
          args: { path: 'packages/runtime/src/checkpoint/CheckpointService.test.ts' },
          argsHash: 'demo-hash-3', category: 'write', risk: 'medium', transport: 'native',
          status: 'awaiting_permission',
        },
      },
      toolCallOrderByRun: {
        ...state.toolCallOrderByRun,
        [DEMO_RUN_ID]: [...(state.toolCallOrderByRun[DEMO_RUN_ID] ?? []), 'tc-3'],
      },
    }));
  }

  // Badge LOCAL / modelo activo también visibles en el Centro de modelos sin necesitar Ollama.
  useModelsStore.setState((state) => ({
    ...state,
    installed: [
      {
        ref: { providerId: 'ollama', name: 'qwen3:8b', locality: 'local' },
        digest: 'sha256:demo', sizeBytes: 5_100_000_000, family: 'qwen3',
        parameterSize: '8B', quantization: 'Q4_K_M',
        capabilities: { tools: true, thinking: true, vision: false, embedding: false },
        // 8192, no 40960: es el num_ctx real que esta app manda por defecto para qwen3:8b en este
        // equipo (ver ModelsPanel.tsx NUM_CTX_DEFAULT) — 40960 es el máximo teórico del modelo, no
        // el contexto con el que corre acá, y mostrarlo confundía la barra de estado (pasada de
        // diseño #4).
        contextMax: 8192,
      },
    ],
    loaded: [{ name: 'qwen3:8b', digest: 'sha256:demo', size: 5_100_000_000, sizeVram: 5_100_000_000, contextLength: 8192, expiresAt: new Date(Date.now() + 300_000).toISOString() }],
  }));
}
