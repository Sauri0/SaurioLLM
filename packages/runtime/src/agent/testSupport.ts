// Fakes compartidos para los tests de packages/runtime/src/agent/*.test.ts. No es un archivo de test
// en sí (vitest.config.ts solo incluye `src/**/*.test.ts`); agrupa implementaciones mínimas en memoria
// de cada interfaz que RunController inyecta (doc 04), para no repetirlas en cada *.test.ts.
import type {
  Chat, ChatMessage, ToolCall, ToolResult, PermissionDecision, Task, Checkpoint,
} from '@saurio/shared';
import type { ChatChunk, ModelGateway } from '../gateway/types.js';
import type { ToolDefinition, ToolProtocol, ToolRegistry } from '../tools/types.js';
import type { PermissionEngine } from '../permissions/types.js';
import type { CheckpointService, RevertPlan, RevertResult } from '../checkpoint/types.js';
import type { ContextBuilder } from '../context/types.js';
import type {
  EventStore, ChatRepository, MessageRepository, ToolCallRepository, CheckpointRepository, TaskRepository,
} from '../persistence/types.js';
import type { RunEvent, DistributiveOmit } from '@saurio/shared';
import type { AgentConfig, ToolCallRecord } from './types.js';
import type { RunRepository, RunRecord, AgentConfigResolver, Clock, IdGenerator } from './ports.js';
import type { TaskManager } from '../tasks/types.js';
import { DefaultTaskManager } from '../tasks/TaskManager.js';

// ── Clock / IdGenerator ──────────────────────────────────────────────────

export function makeFakeClock(startMs = 1_700_000_000_000): Clock {
  let t = startMs;
  return { now: () => (t += 1) };
}

export function makeFakeIds(prefix = 'id'): IdGenerator {
  let n = 0;
  return { next: () => `${prefix}_${(n += 1)}` };
}

// ── EventStore ────────────────────────────────────────────────────────────

export function makeFakeEventStore(): EventStore & { all: RunEvent[] } {
  const all: RunEvent[] = [];
  const seqByRun = new Map<string, number>();
  return {
    all,
    append(event: DistributiveOmit<RunEvent, 'seq'>): RunEvent {
      const seq = (seqByRun.get(event.runId) ?? 0) + 1;
      seqByRun.set(event.runId, seq);
      const full = { ...event, seq } as RunEvent;
      all.push(full);
      return full;
    },
    since(runId: string, seq: number): RunEvent[] {
      return all.filter((e) => e.runId === runId && e.seq > seq);
    },
    lastSeq(runId: string): number {
      return seqByRun.get(runId) ?? 0;
    },
  };
}

// ── Repositorios ─────────────────────────────────────────────────────────

export function makeFakeRunRepository(): RunRepository & { all: Map<string, RunRecord> } {
  const all = new Map<string, RunRecord>();
  return {
    all,
    async create(run) { all.set(run.id, run); return run; },
    async get(id) { return all.get(id); },
    async update(id, patch) {
      const current = all.get(id);
      if (!current) throw new Error(`RunRecord inexistente: ${id}`);
      const updated = { ...current, ...patch };
      all.set(id, updated);
      return updated;
    },
    async listActive() {
      const terminal = new Set(['completed', 'cancelled', 'failed', 'interrupted']);
      return [...all.values()].filter((r) => !terminal.has(r.state));
    },
  };
}

export function makeFakeChatRepository(chats: Chat[]): ChatRepository {
  const byId = new Map(chats.map((c) => [c.id, c]));
  return {
    async create(chat) { byId.set(chat.id, chat); return chat; },
    async get(id) { return byId.get(id); },
    async listByProject(projectId) { return [...byId.values()].filter((c) => c.projectId === projectId); },
    async update(id, patch) {
      const current = byId.get(id);
      if (!current) throw new Error('chat inexistente');
      const updated = { ...current, ...patch };
      byId.set(id, updated);
      return updated;
    },
  };
}

export function makeFakeMessageRepository(): MessageRepository & { byChat: Map<string, ChatMessage[]> } {
  const byChat = new Map<string, ChatMessage[]>();
  return {
    byChat,
    async append(chatId, message) {
      const list = byChat.get(chatId) ?? [];
      list.push(message);
      byChat.set(chatId, list);
      return message;
    },
    async listByChat(chatId) { return [...(byChat.get(chatId) ?? [])]; },
    // Fake sin estado de `compacted_by` (columna solo de persistencia real, doc 03 §4.3): los tests
    // de RunController no verifican esa marca sobre el fake, solo que el método exista (contrato).
    async markCompacted() {},
  };
}

export function makeFakeToolCallRepository(): ToolCallRepository & { all: Map<string, ToolCallRecord> } {
  const all = new Map<string, ToolCallRecord>();
  return {
    all,
    async upsert(record) { all.set(record.id, record); return record; },
    async get(id) { return all.get(id); },
    async listByRun(runId) { return [...all.values()].filter((r) => r.runId === runId); },
    async listOpenAtStartup() {
      const open = new Set(['pending', 'awaiting_permission', 'approved', 'running']);
      return [...all.values()].filter((r) => open.has(r.status));
    },
  };
}

export function makeFakeCheckpointRepository(): CheckpointRepository & { all: Map<string, Checkpoint> } {
  const all = new Map<string, Checkpoint>();
  return {
    all,
    async create(checkpoint) { all.set(checkpoint.id, checkpoint); return checkpoint; },
    async get(id) { return all.get(id); },
    async listByChat(chatId) { return [...all.values()].filter((c) => c.chatId === chatId); },
    async updateStatus(id, status) {
      const cp = all.get(id);
      if (cp) all.set(id, { ...cp, status });
    },
  };
}

export function makeFakeTaskRepository(): TaskRepository {
  const byChat = new Map<string, Task[]>();
  return {
    async upsertMany(chatId, tasks) { byChat.set(chatId, tasks); return tasks; },
    async listByChat(chatId) { return byChat.get(chatId) ?? []; },
  };
}

export function makeFakeTaskManager(events: EventStore, clock: Clock): TaskManager {
  return new DefaultTaskManager({ tasks: makeFakeTaskRepository(), events, clock });
}

// ── Gateway ──────────────────────────────────────────────────────────────

/** Cola de "turnos" del modelo: cada `start()` de un test empuja los `ChatChunk[]` que el próximo
 *  `chat()` debe emitir. Si la cola se vacía, devuelve un turno que llama a `finish`. */
export function makeScriptedGateway(scripts: ChatChunk[][]): ModelGateway & { calls: number } {
  let i = 0;
  const gw: ModelGateway & { calls: number } = {
    calls: 0,
    chat(_ref, _req, _ctx): AsyncIterable<ChatChunk> {
      gw.calls += 1;
      const script = scripts[i] ?? defaultFinishScript();
      i += 1;
      return (async function* () { for (const chunk of script) yield chunk; })();
    },
    providers: () => [],
    resolve: () => { throw new Error('no implementado en fake'); },
    async ensureLoaded() {},
    status: () => ({ slots: [], queue: [] }),
  };
  return gw;
}

function defaultFinishScript(): ChatChunk[] {
  return [
    { type: 'tool_call', call: { id: 'call_finish', name: 'finish', args: { summary: 'listo' }, transport: 'native' } },
    { type: 'done', doneReason: 'stop', metrics: { quality: 'measured' } },
  ];
}

// ── Tools ────────────────────────────────────────────────────────────────

export function makeFinishTool(): ToolDefinition {
  return {
    name: 'finish', description: 'finaliza el run', inputSchema: {}, category: 'read',
    mutating: false, idempotent: true, allowedInModes: ['plan', 'ask', 'edit', 'agent'],
    source: { kind: 'builtin' },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  };
}

export function makeEditFileTool(onApply?: (args: unknown) => void): ToolDefinition {
  return {
    name: 'edit_file', description: 'edita un archivo', inputSchema: {}, category: 'write',
    mutating: true, idempotent: false, allowedInModes: ['edit', 'agent'],
    source: { kind: 'builtin' },
    classify: () => ({ category: 'write', risk: 'medium', summary: 'edit_file', paths: ['src/a.ts'] }),
    handler: async (args) => { onApply?.(args); return { content: [{ type: 'text', text: 'editado' }], isError: false }; },
  };
}

export function makeListFilesTool(): ToolDefinition {
  return {
    name: 'list_files', description: 'lista archivos', inputSchema: {}, category: 'read',
    mutating: false, idempotent: true, allowedInModes: ['plan', 'ask', 'edit', 'agent'],
    source: { kind: 'builtin' },
    handler: async () => ({ content: [{ type: 'text', text: 'a.ts\nb.ts' }], isError: false }),
  };
}

export function makeFakeToolRegistry(defs: ToolDefinition[]): ToolRegistry {
  const byName = new Map(defs.map((d) => [d.name, d]));
  return {
    register: (def) => { byName.set(def.name, def); },
    unregister: (name) => { byName.delete(name); },
    list: (filter) => {
      let out = [...byName.values()];
      if (filter?.names) out = out.filter((d) => filter.names!.includes(d.name));
      if (filter?.mode) out = out.filter((d) => d.allowedInModes.includes(filter.mode!));
      return out;
    },
    get: (name) => byName.get(name),
    onChanged: () => () => {},
  };
}

/** Transporte nativo trivial: los tool calls ya vienen en `message.toolCalls` (acumulados desde los
 *  chunks `tool_call`); no hay nada que escanear en el texto. */
export function makeNativeToolProtocol(): ToolProtocol {
  return {
    renderTools: (tools) => ({
      apiTools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    }),
    parse: (message: ChatMessage) => ({ toolCalls: message.toolCalls ?? [], text: message.content, parseErrors: [] }),
    renderResult: (call: ToolCall, result: ToolResult) => ({
      id: `tr_${call.id}`, role: 'tool', content: textOf(result), toolCallId: call.id, toolName: call.name,
    }),
  };
}

function textOf(result: ToolResult): string {
  const part = result.content.find((c) => c.type === 'text');
  return part && part.type === 'text' ? part.text : '';
}

// ── Permisos ─────────────────────────────────────────────────────────────

export function makeAllowAllPermissionEngine(): PermissionEngine {
  return {
    evaluate: (call) => ({ decision: 'allow', decidedBy: 'mode', reason: `${call.category} permitido en este test` }),
    isProtectedPath: () => false,
    isCriticalCommand: () => false,
    isBlockedByDefault: () => false,
  };
}

/** Hallazgo #1/#4: antes este fake devolvía `toolCallId: 'pending'` fijo, sin mirar lo que le pasa el
 *  caller — eso hacía que un test no pudiera detectar una regresión donde RunController deja de
 *  pasar `toolCallId` en la evaluación (el bug real: `decision.request.toolCallId` terminaba en '').
 *  Ahora refleja `call.toolCallId` (el campo es opcional en el contrato de `PermissionEngine.evaluate`,
 *  así que se lee con un cast puntual) y cae a 'pending' solo si de verdad no vino nada. */
export function makeAskThenRecordPermissionEngine(): PermissionEngine {
  return {
    evaluate: (call): PermissionDecision => {
      const toolCallId = (call as { toolCallId?: string }).toolCallId ?? 'pending';
      return {
        decision: 'ask',
        request: {
          toolCallId, toolName: call.toolName, category: call.category, risk: call.risk,
          summary: call.summary, triggeredBy: 'preset balanced', rememberOptions: [],
        },
      };
    },
    isProtectedPath: () => false,
    isCriticalCommand: () => false,
    isBlockedByDefault: () => false,
  };
}

// ── Checkpoint ───────────────────────────────────────────────────────────

export function makeFakeCheckpointService(clock: Clock, ids: IdGenerator): CheckpointService {
  return {
    async begin(_runId, _toolCallId, _paths) {
      return {
        checkpointId: ids.next(),
        before: async () => {},
        after: async () => {},
      };
    },
    async commit(handle) {
      const checkpoint: Checkpoint = {
        id: handle.checkpointId, runId: 'unused', chatId: 'unused', toolCallId: undefined,
        kind: 'tool', files: [], stats: { files: 1, added: 1, removed: 0 }, status: 'active',
      };
      return checkpoint;
    },
    async diff() { return { unified: '', added: 0, removed: 0 }; },
    async planRevert(): Promise<RevertPlan> { return { restorable: [], conflicts: [], uncoveredEffects: [] }; },
    async revert(): Promise<RevertResult> { return { restored: [], skipped: [], revertCheckpointId: ids.next() }; },
  };
}

// ── Context ──────────────────────────────────────────────────────────────

export function makeFakeContextBuilder(opts: { fits?: boolean } = {}): ContextBuilder {
  return {
    // Fake sin Compactor (doc 16 §4 ítem 5): nunca compacta, así que RunController nunca ve
    // `built.compaction` ni transiciona a 'compacting' contra este fake — coherente con que los
    // tests de RunController que usan este fake no ejercitan compactación (tienen su propio test
    // dedicado si hace falta, ver RunController.test.ts).
    willCompact() { return false; },
    async build({ history }) {
      return {
        messages: history,
        report: {
          numCtx: 8192, reserveForResponse: 1500,
          used: { system: 100, tools: 200, repoMap: 0, memory: 0, history: history.length * 10 },
          totalUsed: 300 + history.length * 10, fits: opts.fits ?? true,
        },
      };
    },
  };
}

// ── AgentConfigResolver + AgentConfig de prueba ─────────────────────────

export function makeTestAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent_1', name: 'Coder', role: 'coder',
    model: { providerId: 'ollama_local', name: 'qwen3:8b', locality: 'local' },
    systemPrompt: 'sos un agente de código', systemPromptHash: 'hash_system_1',
    allowedTools: ['list_files', 'edit_file', 'finish'],
    permissions: { preset: 'balanced', rules: [], terminalAllowlist: [] },
    workingDir: '/workspace',
    contextPolicy: {
      numCtx: 8192, reserveForResponse: 1500, repoMapTokens: 1000, historyBudgetRatio: 0.5,
      maxReadLines: 500, maxSearchResults: 50, maxCommandLines: 200,
      compactAtRatio: 0.8, compactEveryTurns: 5, keepLastTurns: 10, fewShot: false,
    },
    memory: { readProjectMemory: false, writeProjectMemory: false },
    maxIterations: 10, temperature: 0.2, thinking: 'off', toolTransport: 'native', defaultMode: 'agent',
    ...overrides,
  };
}

export function makeFakeAgentConfigResolver(agent: AgentConfig): AgentConfigResolver {
  return { resolve: async () => agent };
}

// ── Espera activa para tests ─────────────────────────────────────────────

/** `RunController.start()` deja el loop corriendo en background (doc 05 §2.1: "start() devuelve
 *  apenas el run queda encolado"); los tests necesitan esperar a que el run llegue a un estado
 *  terminal (o a cualquier condición) sin acoplarse a un mecanismo de notificación que no es parte
 *  del contrato de doc 04 §5. */
export async function waitUntil(predicate: () => boolean | Promise<boolean>, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 5;
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timeout esperando la condición');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function makeTestChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat_1', projectId: 'project_1', agentId: 'agent_1', mode: 'agent',
    createdAt: 0, updatedAt: 0, archived: false,
    ...overrides,
  };
}
