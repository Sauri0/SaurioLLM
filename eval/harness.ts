#!/usr/bin/env tsx
// eval/harness.ts — Harness de validación end-to-end del recorrido #1, SIN Electron.
// Define: doc 02 §4.1 ("test:eval corre eval/harness.ts contra el modelo indicado por variable de
// entorno"), doc 02 §1 (eval/harness.ts "corredor de tareas"). Construye @saurio/runtime exactamente
// igual que apps/desktop/src/main/host/createRuntime.ts (reutiliza esas funciones: es el único lugar
// del monorepo donde se instancian las piezas concretas, doc 02 §1), contra un mini proyecto TS en
// una carpeta temporal y una base SQLite en OTRA carpeta temporal, y corre el recorrido completo
// (listar modelos -> run plan -> run agent -> diff -> revert -> reabrir la base) contra Ollama real
// en 127.0.0.1:11434.
//
// Uso: `pnpm test:eval` (== `tsx eval/harness.ts`). Variables de entorno opcionales:
//   SAURIO_EVAL_MODEL   nombre del modelo a usar (default: qwen3:8b, doc 04 defaults.ts)
//   SAURIO_EVAL_TIMEOUT_MS  presupuesto total del harness en ms (default: 600000 = 10 min)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createGlobalRuntime, initGlobalRuntime, createProjectRuntime, OLLAMA_BASE_URL,
  type GlobalRuntime,
} from '../apps/desktop/src/main/host/createRuntime.js';
import { ensureHostDataDirs, type HostAdapter } from '../apps/desktop/src/main/host/RuntimeHost.js';
import {
  DEFAULT_AGENT_ID, DEFAULT_MODEL_REF, DEFAULT_TOOL_TRANSPORT_OVERRIDES, DEFAULT_PERMISSION_POLICY,
  createDefaultAgentConfig, defaultIdGenerator, systemClock, RunController,
} from '@saurio/runtime/agent/index';
import type { RunControllerDeps } from '@saurio/runtime/agent/RunController';
import type { AgentConfig } from '@saurio/runtime/agent/types';
import type { ModelContextProbe } from '@saurio/runtime/agent/ports';
import {
  createWorkspaceFs, createToolRegistry, createBuiltinTools, createNativeToolProtocol,
  createTextToolProtocol, PathLock, ReadTracker,
} from '@saurio/runtime/tools/index';
import type { ToolContext } from '@saurio/runtime/tools/types';
import { DefaultPermissionEngine } from '@saurio/runtime/permissions/engine';
import { PermissionMemory } from '@saurio/runtime/permissions/memory';
import { FileBlobStore, FsCheckpointService, createGitHeadReader } from '@saurio/runtime/checkpoint/index';
import {
  createContextBuilder, createTokenEstimator, createCompactor, EngineRepoMapClient,
} from '@saurio/runtime/context/index';
import type { Summarizer, CompactionSummary } from '@saurio/runtime/context/summarizer';
import { COMPACTION_SUMMARY_SCHEMA } from '@saurio/runtime/context/summarizer';
import { DefaultTaskManager } from '@saurio/runtime/tasks/TaskManager';
import type { Project, Chat, RunEvent, ModelRef, PermissionAnswer } from '@saurio/shared';
import type { SqliteRow } from '@saurio/runtime/persistence/driver';

interface CompactedMessageRow extends SqliteRow { id: string; compacted_by: string | null }

// ── Presupuesto de tiempo (regla: "timeouts generosos pero acotados, 10 min total") ────────────
const TOTAL_BUDGET_MS = Number(process.env.SAURIO_EVAL_TIMEOUT_MS ?? 600_000);
const harnessStart = Date.now();
function remainingMs(): number {
  return Math.max(0, TOTAL_BUDGET_MS - (Date.now() - harnessStart));
}

const MODEL_NAME = process.env.SAURIO_EVAL_MODEL ?? 'qwen3:8b';

// ── Evidencia / reporte ──────────────────────────────────────────────────────────────────────
interface StepResult { step: string; ok: boolean; evidence: string }
const results: StepResult[] = [];
function report(step: string, ok: boolean, evidence: string): void {
  results.push({ step, ok, evidence });
  const tag = ok ? 'OK  ' : 'FAIL';
  console.log(`[${tag}] ${step}\n      ${evidence.split('\n').join('\n      ')}`);
}
function log(...args: unknown[]): void {
  console.log('[harness]', ...args);
}

// ── Fixture: mini proyecto TS con un bug obvio (suma resta) + SAURIO.md ────────────────────────
function makeFixtureProject(): string {
  const dir = mktemp('saurio-eval-project-');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(
    path.join(dir, 'src', 'math.ts'),
    [
      '// Operaciones aritméticas básicas del mini-proyecto de evaluación.',
      'export function suma(a: number, b: number): number {',
      '  return a - b; // BUG: debería sumar, no restar',
      '}',
      '',
      'export function resta(a: number, b: number): number {',
      '  return a - b;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'src', 'index.ts'),
    [
      "import { suma, resta } from './math.js';",
      "import { saludo } from './util.js';",
      '',
      'console.log(saludo(\'SaurioLLM\'));',
      'console.log(\'suma(2, 3) =\', suma(2, 3));',
      'console.log(\'resta(5, 2) =\', resta(5, 2));',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'src', 'util.ts'),
    [
      'export function saludo(nombre: string): string {',
      '  return `Hola, ${nombre}!`;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'SAURIO.md'),
    [
      '# Proyecto de evaluación',
      '',
      'Mini-proyecto TypeScript usado por `eval/harness.ts` (recorrido #1 de SaurioLLM).',
      '`src/math.ts` expone `suma` y `resta`. `src/index.ts` las usa desde `src/util.ts`.',
      '',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

function mktemp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// Raíz del monorepo, para `appPath` (services/resources.ts espera `apps/desktop/`, dos niveles
// abajo de la raíz, para resolver `resources/model-catalog.json` en modo dev — sin esto,
// `createGlobalRuntime` explota con "path argument must be of type string" fuera de Electron real).
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeHostAdapter(dataDir: string): HostAdapter {
  const paths: HostAdapter['paths'] = {
    userDataDir: dataDir,
    dbPath: path.join(dataDir, 'saurio.db'),
    blobsDir: path.join(dataDir, 'blobs'),
    toolOutputsDir: path.join(dataDir, 'tool-outputs'),
    logsDir: path.join(dataDir, 'logs'),
    cacheDir: path.join(dataDir, 'cache'),
    repoMapCacheDir: path.join(dataDir, 'cache', 'repo-map'),
    appPath: path.join(REPO_ROOT, 'apps', 'desktop'),
    resourcesPath: undefined,
  };
  return {
    paths,
    showOpenDirectoryDialog: async () => ({ canceled: true }),
    notify: () => {},
  };
}

// ── Espera a que un run llegue a un estado terminal, juntando evidencia en el camino ───────────
interface RunWait {
  finalState: string;
  events: RunEvent[];
}

function waitForRunTerminal(
  events: { subscribe(cb: (event: RunEvent) => void): () => void },
  runId: string,
  timeoutMs: number,
): Promise<RunWait> {
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  const collected: RunEvent[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(
        `timeout esperando el run ${runId} (${timeoutMs}ms); últimos eventos: ` +
          collected.slice(-5).map((e) => e.type).join(', '),
      ));
    }, timeoutMs);
    const unsubscribe = events.subscribe((event) => {
      if (event.runId !== runId) return;
      collected.push(event);
      if (event.type === 'run.state' && TERMINAL.has(event.to)) {
        clearTimeout(timer);
        unsubscribe();
        resolve({ finalState: event.to, events: collected });
      }
    });
  });
}

/** Variante tolerante de `waitForRunTerminal`: si el run no llega a un estado terminal dentro del
 *  timeout (p. ej. tras un `deny` el modelo puede tardar varios turnos en decidir llamar `finish`
 *  en vez de reintentar), no aborta el `try` del step entero — devuelve `finalState: 'timeout'` para
 *  que el step evalúe lo que sí puede evaluar (permission_decisions, archivo sin tocar) en vez de
 *  perder toda la evidencia ya juntada por una única llamada que no llegó a cerrar. */
async function waitForRunTerminalTolerant(
  events: { subscribe(cb: (event: RunEvent) => void): () => void },
  runId: string,
  timeoutMs: number,
): Promise<RunWait> {
  try {
    return await waitForRunTerminal(events, runId, timeoutMs);
  } catch {
    return { finalState: 'timeout', events: [] };
  }
}

/** Espera a que un run alcance un `run.state` puntual (o un terminal, lo que ocurra antes) —
 *  usado por los pasos nuevos de "próxima entrega" (doc 17 §5) que necesitan intervenir a mitad de
 *  run (permission ask) en vez de esperar a que termine solo. */
function waitForRunState(
  events: { subscribe(cb: (event: RunEvent) => void): () => void },
  runId: string,
  targetState: string,
  timeoutMs: number,
): Promise<RunWait> {
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  const collected: RunEvent[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(
        `timeout esperando run.state=${targetState} en el run ${runId} (${timeoutMs}ms); últimos eventos: ` +
          collected.slice(-8).map((e) => e.type).join(', '),
      ));
    }, timeoutMs);
    const unsubscribe = events.subscribe((event) => {
      if (event.runId !== runId) return;
      collected.push(event);
      if (event.type === 'run.state' && (event.to === targetState || TERMINAL.has(event.to))) {
        clearTimeout(timer);
        unsubscribe();
        resolve({ finalState: event.to, events: collected });
      }
    });
  });
}

/** Resumen real de compactación de nivel 2 (doc 07 §7.3) contra `ModelGateway.chat` real — no hay
 *  implementación conectada en `packages/runtime/src/context` (`UnavailableSummarizer` es a
 *  propósito el único valor por defecto, doc 07 §7.3 Plan B); acá se cablea una real para poder
 *  ejercitar `context.compacted` de punta a punta (doc 16 §4 ítem 5) sin tocar packages/runtime. */
function makeRealSummarizer(runtime: GlobalRuntime): Summarizer {
  return {
    async summarize({ candidates, model }): Promise<CompactionSummary> {
      const controller = new AbortController();
      let content = '';
      for await (const chunk of runtime.gateway.chat(
        model,
        {
          model: model.name,
          messages: [
            {
              id: 'sys-summarizer', role: 'system',
              content: 'Resumí la conversación en el JSON pedido por el schema. Sé breve y concreto; no agregues texto fuera del JSON.',
            },
            ...candidates.map((c) => ({ id: c.id, role: c.role, content: c.content })),
          ],
          options: { numCtx: 8192, temperature: 0.1, numPredict: 500 },
          format: COMPACTION_SUMMARY_SCHEMA as unknown as object,
          think: false,
        },
        { runId: 'eval-summarizer', signal: controller.signal, authorizedLocality: [model.locality], priority: 'interactive' },
      )) {
        if (chunk.type === 'content') content += chunk.text;
        else if (chunk.type === 'error') throw new Error(`summarizer: ${chunk.message}`);
      }
      return JSON.parse(content) as CompactionSummary;
    },
  };
}

/** Réplica mínima de `createProjectRuntime` (apps/desktop/src/main/host/createRuntime.ts, fuera del
 *  alcance de esta tarea) que además cablea `permissionMemory`/`projectId`/`modelContextProbe`
 *  (opcionales en `RunControllerDeps`, agregados en esta tarea) y admite un `AgentConfig` a medida
 *  por escenario (preset de permisos, modelo, contextPolicy). No se modifica `createRuntime.ts`
 *  porque `apps/desktop` es zona del otro agente; esto vive enteramente en `eval/`. */
async function buildEnhancedRunController(
  runtime: GlobalRuntime,
  hostAdapter: HostAdapter,
  project: Project,
  agentOverrides: Partial<AgentConfig> & { id: string },
): Promise<RunController> {
  const { repositories } = runtime.persistence;
  const projectRoot = project.path;
  const workspaceFs = createWorkspaceFs(projectRoot);

  // Doc 16 §4 ítem 16 / doc 10 §3, §5.2: `readTracker` es el ÚNICO estado que antes decidía "¿cambió
  // el archivo desde que lo leí?" para edit_file/write_file/delete_file, y un reinicio real lo borra
  // (cada llamada a `buildEnhancedRunController` crea uno nuevo, vacío — así se simula memoria
  // perdida en el paso (o) más abajo). `readHashes` (RunControllerDeps, ports.ts) comparte la MISMA
  // instancia para que `RunController` pueda escribir `tool_calls.expected_pre_hash` al registrar la
  // tool call con el último hash que ESTE proceso vio; `expectedPreHash` (BuiltinToolsDeps) lee esa
  // misma columna de vuelta desde `repositories.toolCalls` (SQLite real) en vez de este mismo
  // `ReadTracker` — así el chequeo de conflicto sigue siendo correcto aunque el `ReadTracker` de un
  // proceso reabierto esté vacío.
  const readTracker = new ReadTracker();
  const tools = createToolRegistry();
  const builtins = createBuiltinTools({
    toolOutputsDir: hostAdapter.paths.toolOutputsDir,
    readTracker,
    pathLock: new PathLock(),
    expectedPreHash: { async get(toolCallId) { return (await repositories.toolCalls.get(toolCallId))?.expectedPreHash; } },
  });
  for (const tool of builtins) tools.register(tool);

  const blobStore = new FileBlobStore(hostAdapter.paths.blobsDir, repositories.blobRefs);
  const checkpointService = new FsCheckpointService({
    projectRoot,
    blobStore,
    store: repositories.checkpointStore,
    resolveChatId: async (runId) => {
      const run = await repositories.runs.get(runId);
      if (!run) throw new Error(`saurio-eval: no se puede checkpointear un run inexistente ("${runId}")`);
      return run.chatId;
    },
    // Doc 09 §2.2/§5.3 (RevertPlan.branchChanged/uncoveredEffects, encargo de esta tarea): el
    // proyecto fixture del harness es una carpeta temporal SIN `.git` (mkdtempSync), así que
    // `createGitHeadReader().read()` devuelve `undefined` acá — igual se cablea de punta a punta para
    // que la ausencia de `.git` se ejercite como el caso normal que doc 09 §7.1 describe, no como un
    // camino sin probar. `toolCalls` sí tiene efecto real: alimenta `uncoveredEffects` con los
    // `run_command` reales que corran en el mismo run que un checkpoint revertido.
    gitHead: createGitHeadReader(),
    toolCalls: repositories.toolCalls,
  });

  const repoMap = new EngineRepoMapClient();
  const base = createDefaultAgentConfig(projectRoot);
  const agent: AgentConfig = { ...base, ...agentOverrides, workingDir: projectRoot };
  await repositories.agents.save(agent, false);

  const tokenEstimator = createTokenEstimator(agent.model);
  const compactor = createCompactor(tokenEstimator, makeRealSummarizer(runtime));
  const context = createContextBuilder(tokenEstimator, compactor);

  const permissionMemory = new PermissionMemory(
    repositories.permissionRules, repositories.permissionDecisions,
    () => defaultIdGenerator.next(), systemClock,
  );
  const modelContextProbe: ModelContextProbe = {
    async getContextMax(ref) {
      const desc = await runtime.modelManager.describeModel(ref);
      return desc.contextMax;
    },
  };

  const deps: RunControllerDeps = {
    gateway: runtime.gateway,
    tools,
    toolProtocols: { native: createNativeToolProtocol(), text: createTextToolProtocol() },
    permissions: new DefaultPermissionEngine(),
    checkpoints: checkpointService,
    context,
    taskManager: new DefaultTaskManager({ tasks: repositories.tasks, events: runtime.events, clock: systemClock }),
    events: runtime.events,
    runs: repositories.runs,
    chats: repositories.chats,
    messages: repositories.messages,
    toolCalls: repositories.toolCalls,
    checkpointRepo: repositories.checkpoints,
    agents: repositories.agents,
    // Doc 19 §2.5 (E3a delegación): `AgentRepository` ya implementa `AgentProfilePort.createProfile`
    // — se agrega acá (aditivo, sin efecto en los pasos (a)-(n) que no delegan) para que los pasos
    // nuevos de delegación puedan crear un worker efímero real.
    agentProfiles: repositories.agents,
    workspaceFs,
    clock: systemClock,
    ids: defaultIdGenerator,
    projectRoot,
    repoMap,
    toolTransportOverrides: DEFAULT_TOOL_TRANSPORT_OVERRIDES,
    permissionMemory,
    projectId: project.id,
    modelContextProbe,
    readHashes: readTracker,
  };

  return new RunController(deps);
}

/** `tool_calls` en `awaiting_permission` para un run puntual — evita que cada paso nuevo repita
 *  el mismo `listByRun` + `find`. */
async function findAwaitingPermissionCall(
  runtime: GlobalRuntime, runId: string,
): Promise<{ id: string; toolName: string } | undefined> {
  const calls = await runtime.persistence.repositories.toolCalls.listByRun(runId);
  return calls.find((c) => c.status === 'awaiting_permission');
}

/** Hallazgo real (debug de esta sesión, ver TRASPASO.md): (g.1)/(g.3)/(q) reportaban "final=timeout"
 *  con el archivo sin tocar / la delegación sin cerrar, pero NO por un run colgado — `RunController`
 *  maneja correctamente cualquier cantidad de rondas ask/allow dentro de un mismo run (confirmado con
 *  instrumentación + reproducción real contra Ollama: cuando se contestan TODAS las rondas, el
 *  archivo se edita y el run llega a `completed`; ver también `RunController.test.ts`, "segundo
 *  permiso dentro del mismo run"). La causa real es que estos pasos solo contestaban la PRIMERA
 *  `awaiting_permission`: si el modelo falla el primer intento (ej. `edit_file` sin `read_file` previo
 *  → "el archivo cambió desde que lo leíste") y reintenta con una tool call nueva, esa segunda
 *  también es 'ask' bajo el preset 'strict' — y nadie la contestaba, dejando el run legítimamente
 *  esperando para siempre (igual que en la UI real: un segundo permiso necesita una segunda
 *  respuesta del usuario). `waitForRunState`/`waitForRunTerminalTolerant` (arriba) no sirven para un
 *  loop de rondas porque cada llamada abre una suscripción NUEVA — si el run ya llegó a un estado
 *  terminal entre rondas, esa suscripción tardía nunca ve el evento (ya se emitió) y reporta un
 *  falso "timeout" (reproducido acá mismo durante el debug). Esta función usa una ÚNICA suscripción
 *  para toda la vida del run, así ningún evento se pierde entre rondas. */
function watchRun(runtime: GlobalRuntime, runId: string): {
  collected: RunEvent[];
  waitFor(predicate: (e: RunEvent) => boolean, timeoutMs: number): Promise<RunEvent>;
  unsubscribe(): void;
} {
  const collected: RunEvent[] = [];
  let onEvent: (() => void) | undefined;
  const unsubscribe = runtime.events.subscribe((event) => {
    if (event.runId !== runId) return;
    collected.push(event);
    onEvent?.();
  });
  function waitFor(predicate: (e: RunEvent) => boolean, timeoutMs: number): Promise<RunEvent> {
    const already = collected.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { onEvent = undefined; reject(new Error(`timeout esperando evento en el run ${runId} (${timeoutMs}ms)`)); }, timeoutMs);
      onEvent = () => {
        const hit = collected.find(predicate);
        if (hit) { clearTimeout(timer); onEvent = undefined; resolve(hit); }
      };
    });
  }
  return { collected, waitFor, unsubscribe };
}

const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Contesta TODAS las rondas de `awaiting_permission` que aparezcan en el run (no solo la primera,
 *  ver comentario de `watchRun`) hasta que llegue a un estado terminal o se agote `maxRounds`.
 *  `answer` decide la respuesta para cada ronda (típicamente la misma para todas, `allow_once`). */
async function driveThroughPermissionAsks(
  runtime: GlobalRuntime, controller: RunController, runId: string,
  answer: (toolCallId: string) => PermissionAnswer,
  opts: { maxRounds?: number; perRoundTimeoutMs?: number } = {},
): Promise<{ rounds: number; firstToolCallId: string | undefined; finalState: string }> {
  const maxRounds = opts.maxRounds ?? 5;
  const perRoundTimeoutMs = opts.perRoundTimeoutMs ?? 90_000;
  const watch = watchRun(runtime, runId);
  let rounds = 0;
  let firstToolCallId: string | undefined;
  let finalState = 'timeout';
  try {
    for (let i = 0; i < maxRounds; i += 1) {
      let ev: RunEvent;
      try {
        ev = await watch.waitFor(
          (e) => e.type === 'tool.permission' || (e.type === 'run.state' && TERMINAL_RUN_STATES.has(e.to)),
          perRoundTimeoutMs,
        );
      } catch {
        finalState = 'timeout';
        break;
      }
      if (ev.type === 'run.state') { finalState = ev.to; break; }
      // ev.type === 'tool.permission': puede que ya se haya contestado (si la proyección de
      // tool_calls todavía no vio el evento) — `findAwaitingPermissionCall` confirma el estado real.
      const pending = await findAwaitingPermissionCall(runtime, runId);
      if (!pending || pending.id !== ev.request.toolCallId) continue; // ya no está pendiente, sigue el loop
      if (rounds === 0) firstToolCallId = pending.id;
      rounds += 1;
      await controller.answerPermission(pending.id, answer(pending.id));
    }
    if (!TERMINAL_RUN_STATES.has(finalState)) {
      try {
        const ev = await watch.waitFor((e) => e.type === 'run.state' && TERMINAL_RUN_STATES.has(e.to), perRoundTimeoutMs);
        if (ev.type === 'run.state') finalState = ev.to;
      } catch {
        finalState = 'timeout';
      }
    }
  } finally {
    watch.unsubscribe();
  }
  return { rounds, firstToolCallId, finalState };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const projectDir = makeFixtureProject();
  const dataDir = mktemp('saurio-eval-data-');
  log('proyecto fixture:', projectDir);
  log('carpeta de datos (SQLite/blobs) — separada del proyecto:', dataDir);

  const hostAdapter = makeHostAdapter(dataDir);
  ensureHostDataDirs(hostAdapter.paths);

  // ── Construcción del runtime, igual que RuntimeHost/createRuntime.ts (persistence + migraciones,
  //    gateway con OllamaProvider real, scheduler 1 slot, ToolRegistry con las 10 builtins,
  //    PermissionEngine balanced (write=allow en workspace por defecto), CheckpointService,
  //    ContextBuilder + repo map, ModelManager) ──────────────────────────────────────────────────
  const runtime = createGlobalRuntime(hostAdapter);
  const recoverAtBoot = await initGlobalRuntime(runtime, projectDir);
  log(
    'runtime #1 inicializado contra', OLLAMA_BASE_URL,
    '— recover() al boot: orphaned=', recoverAtBoot.orphaned.length, 'abandoned=', recoverAtBoot.abandoned.length,
  );

  const project: Project = await runtime.persistence.repositories.projects.create({
    id: 'proj_eval', path: projectDir, name: 'saurio-eval-fixture',
    createdAt: Date.now(), lastOpenedAt: Date.now(),
  });
  const projectRuntime = createProjectRuntime(runtime, hostAdapter, project);

  let planRunId: string | undefined;
  let agentRunId: string | undefined;
  let chat: Chat | undefined;
  let checkpointId: string | undefined;
  let originalMathTs: string | undefined;

  // ── (a) listar modelos y elegir qwen3:8b (numCtx 8192) ──────────────────────────────────────
  let modelRef: ModelRef | undefined;
  try {
    const installed = await runtime.modelManager.listInstalled();
    const names = installed.map((m) => `${m.ref.name} (${m.parameterSize}, ${m.quantization})`).join(', ');
    const found = installed.find((m) => m.ref.name === MODEL_NAME);
    if (!found) throw new Error(`modelo "${MODEL_NAME}" no está instalado en Ollama; instalados: ${names || '(ninguno)'}`);
    modelRef = found.ref;
    const fit = await runtime.modelManager.fits(modelRef, 8192);
    report(
      '(a) listar modelos y elegir qwen3:8b (numCtx 8192)',
      true,
      `instalados: ${names}\nelegido: ${JSON.stringify(modelRef)}\n` +
        `fit(numCtx=8192): fitClass=${fit.fitClass} quality=${fit.quality} source=${fit.source} ` +
        `vramNeededBytes=${fit.vramNeededBytes} vramAvailableBytes=${fit.vramAvailableBytes}`,
    );
  } catch (err) {
    report('(a) listar modelos y elegir qwen3:8b (numCtx 8192)', false, String((err as Error).stack ?? err));
  }

  // El resto del recorrido necesita un modelRef válido; si (a) falló, no tiene sentido seguir
  // inventando datos — se reportan los pasos restantes como fallidos con evidencia real.
  if (modelRef) {
    chat = await runtime.persistence.repositories.chats.create({
      id: 'chat_eval_1', projectId: project.id, agentId: DEFAULT_AGENT_ID, mode: 'agent',
      modelRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
    });

    // ── (b) run en modo plan ───────────────────────────────────────────────────────────────────
    try {
      const t0 = Date.now();
      const { runId } = await projectRuntime.runController.start(
        chat.id, 'Explorá el proyecto y decime qué hace y dónde está el bug', 'plan',
      );
      planRunId = runId;
      const budget = Math.min(remainingMs() - 60_000, 240_000);
      const wait = await waitForRunTerminal(runtime.events, runId, Math.max(budget, 30_000));
      const elapsedS = (Date.now() - t0) / 1000;

      const toolCalls = await runtime.persistence.repositories.toolCalls.listByRun(runId);
      const readToolNames = new Set(['list_files', 'search_code', 'read_file']);
      const readCalls = toolCalls.filter((c) => readToolNames.has(c.toolName));
      const tasks = await runtime.persistence.repositories.tasks.listByChat(chat.id);
      const doneMsgs = wait.events.filter((e) => e.type === 'message.done');
      const tokPerSec = doneMsgs
        .map((e) => (e as Extract<RunEvent, { type: 'message.done' }>).metrics)
        .filter((m) => m.evalTokens && m.evalMs)
        .map((m) => (m.evalTokens! / (m.evalMs! / 1000)).toFixed(1));

      const errorEvents = wait.events.filter((e) => e.type === 'run.error') as Extract<RunEvent, { type: 'run.error' }>[];
      const ok = wait.finalState === 'completed' && readCalls.length > 0;
      report(
        '(b) run modo plan hasta completed, con tool calls de lectura y plan/tasks',
        ok,
        `runId=${runId} estado final=${wait.finalState} duración=${elapsedS.toFixed(1)}s\n` +
          `tool calls totales=${toolCalls.length} (lectura: ${readCalls.map((c) => c.toolName).join(', ') || '(ninguna)'})\n` +
          `tasks persistidas=${tasks.length} (${tasks.map((t) => `${t.id}:${t.status}`).join(', ') || '(ninguna)'})\n` +
          `tok/s medidos por respuesta: ${tokPerSec.join(', ') || '(sin evalTokens/evalMs)'}\n` +
          `run.error: ${errorEvents.map((e) => JSON.stringify(e.error)).join(' | ') || '(ninguno)'}\n` +
          `secuencia de eventos: ${wait.events.map((e) => e.type).join(' -> ')}`,
      );
    } catch (err) {
      report('(b) run modo plan hasta completed, con tool calls de lectura y plan/tasks', false, String((err as Error).stack ?? err));
    }

    // ── (c) run en modo agent: arreglar el bug ─────────────────────────────────────────────────
    try {
      originalMathTs = readFileSync(path.join(projectDir, 'src', 'math.ts'), 'utf8');
      const t0 = Date.now();
      const { runId } = await projectRuntime.runController.start(
        chat.id, 'Arreglá el bug de la función suma en src/math.ts', 'agent',
      );
      agentRunId = runId;
      const budget = Math.min(remainingMs() - 90_000, 240_000);
      const wait = await waitForRunTerminal(runtime.events, runId, Math.max(budget, 30_000));
      const elapsedS = (Date.now() - t0) / 1000;

      const editRegistered = wait.events.find(
        (e) => e.type === 'tool.registered' && e.call.toolName === 'edit_file',
      ) as Extract<RunEvent, { type: 'tool.registered' }> | undefined;
      const registeredPending = editRegistered?.call.status === 'pending';

      // El modelo puede reintentar edit_file (match ambiguo, etc.) antes de acertar: se toma el
      // checkpoint de la llamada edit_file que efectivamente terminó 'done' (no el primer
      // checkpoint.created cronológico, que puede ser de un intento fallido sin escritura real).
      const agentToolCallsSoFar = await runtime.persistence.repositories.toolCalls.listByRun(runId);
      const successfulEdit = agentToolCallsSoFar.find((c) => c.toolName === 'edit_file' && c.status === 'done');
      const checkpointCreatedEvents = wait.events.filter((e) => e.type === 'checkpoint.created') as
        Extract<RunEvent, { type: 'checkpoint.created' }>[];
      const checkpointCreated = successfulEdit
        ? checkpointCreatedEvents.find((e) => e.checkpoint.toolCallId === successfulEdit.id)
        : checkpointCreatedEvents[0];
      checkpointId = checkpointCreated?.checkpoint.id;

      const newMathTs = readFileSync(path.join(projectDir, 'src', 'math.ts'), 'utf8');
      const fileChanged = newMathTs !== originalMathTs;

      const doneMsgs = wait.events.filter((e) => e.type === 'message.done') as Extract<RunEvent, { type: 'message.done' }>[];
      const metricsPresent = doneMsgs.length > 0 && doneMsgs.every((e) => e.metrics !== undefined);
      const tokPerSec = doneMsgs
        .map((e) => e.metrics)
        .filter((m) => m.evalTokens && m.evalMs)
        .map((m) => (m.evalTokens! / (m.evalMs! / 1000)).toFixed(1));

      const errorEvents = wait.events.filter((e) => e.type === 'run.error') as Extract<RunEvent, { type: 'run.error' }>[];
      const ok = wait.finalState === 'completed' && registeredPending === true
        && checkpointId !== undefined && fileChanged && metricsPresent;
      report(
        '(c) run modo agent: edit_file pending->ejecutado, checkpoint creado, archivo cambiado, métricas presentes',
        ok,
        `runId=${runId} estado final=${wait.finalState} duración=${elapsedS.toFixed(1)}s\n` +
          `edit_file registrado con status inicial=${editRegistered?.call.status ?? '(no se registró edit_file)'}\n` +
          `checkpoint creado: ${checkpointId ?? '(ninguno)'} stats=${checkpointCreated ? JSON.stringify(checkpointCreated.checkpoint.stats) : '-'}\n` +
          `archivo src/math.ts cambió: ${fileChanged}\n` +
          `contenido nuevo de src/math.ts:\n${newMathTs}\n` +
          `mensajes con métricas: ${doneMsgs.length}, tok/s medidos: ${tokPerSec.join(', ') || '(sin evalTokens/evalMs)'}\n` +
          `run.error: ${errorEvents.map((e) => JSON.stringify(e.error)).join(' | ') || '(ninguno)'}\n` +
          `secuencia de eventos: ${wait.events.map((e) => e.type).join(' -> ')}`,
      );
    } catch (err) {
      report('(c) run modo agent: edit_file pending->ejecutado, checkpoint creado, archivo cambiado, métricas presentes', false, String((err as Error).stack ?? err));
    }

    // ── (d) diff del checkpoint ─────────────────────────────────────────────────────────────────
    if (checkpointId) {
      try {
        const diff = await projectRuntime.checkpointService.diff(checkpointId, 'src/math.ts');
        const ok = diff.added > 0 || diff.removed > 0;
        report(
          '(d) diff del checkpoint (+N -M)',
          ok,
          `checkpointId=${checkpointId} +${diff.added} -${diff.removed}\n${diff.unified}`,
        );
      } catch (err) {
        report('(d) diff del checkpoint (+N -M)', false, String((err as Error).stack ?? err));
      }
    } else {
      report('(d) diff del checkpoint (+N -M)', false, 'no hay checkpointId (paso (c) no creó checkpoint)');
    }

    // ── (e) revert del checkpoint ────────────────────────────────────────────────────────────────
    if (checkpointId && originalMathTs !== undefined) {
      try {
        const plan = await projectRuntime.checkpointService.planRevert([checkpointId]);
        const resolution: Record<string, 'restore' | 'keep_mine' | 'skip'> = {};
        for (const relPath of plan.restorable) resolution[relPath] = 'restore';
        const result = await projectRuntime.checkpointService.revert([checkpointId], resolution);
        const restoredContent = readFileSync(path.join(projectDir, 'src', 'math.ts'), 'utf8');
        const exact = restoredContent === originalMathTs;
        const ok = exact && result.restored.includes('src/math.ts');
        report(
          '(e) revert del checkpoint: el archivo vuelve a su contenido exacto',
          ok,
          `plan.restorable=${JSON.stringify(plan.restorable)} plan.conflicts=${JSON.stringify(plan.conflicts)}\n` +
            `revert.restored=${JSON.stringify(result.restored)} revert.skipped=${JSON.stringify(result.skipped)} ` +
            `revertCheckpointId=${result.revertCheckpointId}\n` +
            `contenido restaurado == original exacto: ${exact}`,
        );
      } catch (err) {
        report('(e) revert del checkpoint: el archivo vuelve a su contenido exacto', false, String((err as Error).stack ?? err));
      }
    } else {
      report('(e) revert del checkpoint: el archivo vuelve a su contenido exacto', false, 'no hay checkpointId u original capturado (paso (c)/(d) fallaron)');
    }

    // ── (k) modo plan: task_update + finish dejan tasks persistidas (doc 16 §4 ítem 6) ──────────
    if (chat) {
      try {
        const tasks = await runtime.persistence.repositories.tasks.listByChat(chat.id);
        const ok = tasks.length > 0;
        report(
          '(k) modo plan: el checklist queda persistido en tasks (task_update y/o finish.tasks)',
          ok,
          `tasks=${tasks.length}: ${tasks.map((t) => `${t.ord}:${t.status}:${t.title}`).join(' | ') || '(ninguna)'}`,
        );
      } catch (err) {
        report('(k) modo plan: el checklist queda persistido en tasks (task_update y/o finish.tasks)', false, String((err as Error).stack ?? err));
      }
    } else {
      report('(k) modo plan: el checklist queda persistido en tasks (task_update y/o finish.tasks)', false, 'saltado: no hay chat (paso (a) falló)');
    }

    // ── (l) edit_file ambiguo: coincidencias numeradas (doc 16 §4 ítem 6), sin modelo ───────────
    try {
      const ambigDir = mktemp('saurio-eval-ambig-');
      const ambigFile = 'dup.ts';
      writeFileSync(
        path.join(ambigDir, ambigFile),
        ['const total = 1;', 'foo();', 'const other = 2;', 'foo();', 'const last = 3;', ''].join('\n'),
        'utf8',
      );
      const fs = createWorkspaceFs(ambigDir);
      const readTracker = new ReadTracker();
      const builtins = createBuiltinTools({ toolOutputsDir: path.join(ambigDir, 'tool-outputs'), readTracker, pathLock: new PathLock() });
      const readTool = builtins.find((t) => t.name === 'read_file');
      const editTool = builtins.find((t) => t.name === 'edit_file');
      if (!readTool || !editTool) throw new Error('no se encontraron read_file/edit_file en createBuiltinTools()');

      const ctx: ToolContext = {
        projectRoot: ambigDir, cwd: ambigDir, runId: 'eval-ambig', toolCallId: 'eval-ambig-1',
        signal: new AbortController().signal, timeoutMs: 5000, fs,
        checkpoint: { checkpointId: '', before: async () => {}, after: async () => {} },
        emit: () => {}, log: () => {},
      };
      await readTool.handler({ path: ambigFile }, { ...ctx, toolCallId: 'eval-ambig-read' });
      const result = await editTool.handler(
        { path: ambigFile, old_string: 'foo();', new_string: 'bar();', replace_all: false }, ctx,
      );
      const text = result.content.find((c) => c.type === 'text');
      const message = text && text.type === 'text' ? text.text : '';
      const ok = result.isError === true
        && /Coincidencias encontradas/.test(message)
        && /1\. línea 2: foo\(\);/.test(message)
        && /2\. línea 4: foo\(\);/.test(message);
      report(
        '(l) edit_file con old_string ambiguo devuelve las coincidencias numeradas (línea + preview)',
        ok,
        `isError=${result.isError}\nmensaje: ${message}`,
      );
      rmSync(ambigDir, { recursive: true, force: true });
    } catch (err) {
      report('(l) edit_file con old_string ambiguo devuelve las coincidencias numeradas (línea + preview)', false, String((err as Error).stack ?? err));
    }

    // ── (g) permiso "ask" de punta a punta: allow_once, deny, allow_always (persiste + próximo run) ──
    // Cuatro sub-pasos, cada uno con su propio try/catch (doc de la tarea: un solo `report()` por
    // afirmación) — así un timeout en uno no se come la evidencia ya juntada de los otros.
    const strictAgentId = 'agent_eval_strict';
    const strictAgent: Partial<AgentConfig> & { id: string } = {
      id: strictAgentId, model: modelRef,
      permissions: { ...DEFAULT_PERMISSION_POLICY, preset: 'strict' },
    };
    const askController = await buildEnhancedRunController(runtime, hostAdapter, project, strictAgent);

    try {
      const chatOnce = await runtime.persistence.repositories.chats.create({
        id: 'chat_ask_once', projectId: project.id, agentId: strictAgentId, mode: 'agent',
        modelRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
      });
      writeFileSync(path.join(projectDir, 'src', 'ask1.ts'), 'export const ask1 = 1;\n', 'utf8');
      const runOnce = await askController.start(chatOnce.id, 'Editá src/ask1.ts: cambiá el valor de ask1 de 1 a 2, sin tocar nada más.', 'agent');
      const driveOnce = await driveThroughPermissionAsks(
        runtime, askController, runOnce.runId, (id) => ({ toolCallId: id, answer: 'allow_once' }),
      );
      const ask1Content = readFileSync(path.join(projectDir, 'src', 'ask1.ts'), 'utf8');
      const decisionsOnce = driveOnce.firstToolCallId
        ? await runtime.persistence.repositories.permissionDecisions.listByToolCall(driveOnce.firstToolCallId) : [];
      const ok = driveOnce.rounds > 0
        && driveOnce.finalState === 'completed' && ask1Content.includes('2') && decisionsOnce.some((d) => d.decision === 'allow');
      report(
        '(g.1) permiso ask -> allow_once: awaiting_permission, se aplica, permission_decisions registrada',
        ok,
        `rondas de permiso contestadas=${driveOnce.rounds} final=${driveOnce.finalState} archivo="${ask1Content.trim()}" permission_decisions=${JSON.stringify(decisionsOnce)}`,
      );
    } catch (err) {
      report('(g.1) permiso ask -> allow_once: awaiting_permission, se aplica, permission_decisions registrada', false, String((err as Error).stack ?? err));
    }

    try {
      const chatDeny = await runtime.persistence.repositories.chats.create({
        id: 'chat_ask_deny', projectId: project.id, agentId: strictAgentId, mode: 'agent',
        modelRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
      });
      writeFileSync(path.join(projectDir, 'src', 'ask2.ts'), 'export const ask2 = 1;\n', 'utf8');
      const runDeny = await askController.start(chatDeny.id, 'Editá src/ask2.ts: cambiá el valor de ask2 de 1 a 2, sin tocar nada más.', 'agent');
      const waitAskDeny = await waitForRunState(runtime.events, runDeny.runId, 'awaiting_permission', 90_000);
      const pendingDeny = waitAskDeny.finalState === 'awaiting_permission' ? await findAwaitingPermissionCall(runtime, runDeny.runId) : undefined;
      if (pendingDeny) {
        await askController.answerPermission(pendingDeny.id, { toolCallId: pendingDeny.id, answer: 'deny', reason: 'evaluación automática: denegado a propósito' });
      }
      // Tolerante: lo que importa es que la tool call haya quedado denegada y el archivo intacto,
      // no que el run llegue a completed dentro del timeout — tras un deny el modelo puede
      // reintentar varias veces antes de resignarse a llamar finish (no es un bug de permisos).
      const termDeny = await waitForRunTerminalTolerant(runtime.events, runDeny.runId, 120_000);
      if (termDeny.finalState === 'timeout') await askController.cancel(runDeny.runId).catch(() => {});
      const ask2Content = readFileSync(path.join(projectDir, 'src', 'ask2.ts'), 'utf8');
      const decisionsDeny = pendingDeny ? await runtime.persistence.repositories.permissionDecisions.listByToolCall(pendingDeny.id) : [];
      const ok = pendingDeny !== undefined && ask2Content.includes('ask2 = 1') && decisionsDeny.some((d) => d.decision === 'deny');
      report(
        '(g.2) permiso ask -> deny: el modelo recibe el motivo, el archivo no se toca',
        ok,
        `awaitingPermission=${waitAskDeny.finalState === 'awaiting_permission'} final=${termDeny.finalState} archivo="${ask2Content.trim()}" permission_decisions=${JSON.stringify(decisionsDeny)}`,
      );
    } catch (err) {
      report('(g.2) permiso ask -> deny: el modelo recibe el motivo, el archivo no se toca', false, String((err as Error).stack ?? err));
    }

    let editRuleForNextRun: unknown;
    try {
      const chatAlways = await runtime.persistence.repositories.chats.create({
        id: 'chat_ask_always', projectId: project.id, agentId: strictAgentId, mode: 'agent',
        modelRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
      });
      writeFileSync(path.join(projectDir, 'src', 'ask3.ts'), 'export const ask3 = 1;\n', 'utf8');
      const runAlways = await askController.start(chatAlways.id, 'Editá src/ask3.ts: cambiá el valor de ask3 de 1 a 2, sin tocar nada más.', 'agent');
      const driveAlways = await driveThroughPermissionAsks(
        runtime, askController, runAlways.runId, (id) => ({ toolCallId: id, answer: 'allow_always', rememberScope: 'project' }),
      );
      const ask3Content = readFileSync(path.join(projectDir, 'src', 'ask3.ts'), 'utf8');
      const rulesAfter = await runtime.persistence.repositories.permissionRules.listApplicable(project.id);
      const editRule = rulesAfter.find((r) => r.toolName === 'edit_file' && r.scope === 'project' && r.decision === 'allow');
      editRuleForNextRun = editRule;
      const ok = driveAlways.rounds > 0 && driveAlways.finalState === 'completed' && ask3Content.includes('2') && editRule !== undefined;
      report(
        '(g.3) permiso ask -> allow_always (scope project): se aplica y persiste en permission_rules',
        ok,
        `rondas de permiso contestadas=${driveAlways.rounds} final=${driveAlways.finalState} archivo="${ask3Content.trim()}"\n` +
          `permission_rules aplicables al proyecto: ${JSON.stringify(rulesAfter)}\nregla edit_file encontrada: ${JSON.stringify(editRule)}`,
      );
    } catch (err) {
      report('(g.3) permiso ask -> allow_always (scope project): se aplica y persiste en permission_rules', false, String((err as Error).stack ?? err));
    }

    try {
      // "se aplica en el siguiente run": UNA INSTANCIA NUEVA de RunController (mismo proceso, deps
      // frescas — simula que el usuario abre otro chat/run sin reiniciar la app) sobre el mismo
      // proyecto/DB debe cargar la regla persistida en g.3 y NO volver a preguntar.
      const askController2 = await buildEnhancedRunController(runtime, hostAdapter, project, strictAgent);
      const chatNextRun = await runtime.persistence.repositories.chats.create({
        id: 'chat_ask_next_run', projectId: project.id, agentId: strictAgentId, mode: 'agent',
        modelRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
      });
      writeFileSync(path.join(projectDir, 'src', 'ask4.ts'), 'export const ask4 = 1;\n', 'utf8');
      const runNext = await askController2.start(chatNextRun.id, 'Editá src/ask4.ts: cambiá el valor de ask4 de 1 a 2, sin tocar nada más.', 'agent');
      const termNext = await waitForRunTerminalTolerant(runtime.events, runNext.runId, 90_000);
      if (termNext.finalState === 'timeout') {
        // Si preguntó de nuevo, se queda esperando una respuesta que nunca llega — respondela para
        // no dejar el run colgado, pero eso ya alcanza para que `neverAskedAgain` dé false abajo.
        const stillPending = await findAwaitingPermissionCall(runtime, runNext.runId);
        if (stillPending) await askController2.answerPermission(stillPending.id, { toolCallId: stillPending.id, answer: 'allow_once' }).catch(() => {});
        else await askController2.cancel(runNext.runId).catch(() => {});
      }
      const ask4Content = readFileSync(path.join(projectDir, 'src', 'ask4.ts'), 'utf8');
      const allEventsNext = runtime.events.since(runNext.runId, 0);
      const permissionEvent = allEventsNext.find((e) => e.type === 'tool.permission') as Extract<RunEvent, { type: 'tool.permission' }> | undefined;
      const neverAskedAgain = permissionEvent === undefined;
      const ok = termNext.finalState !== 'timeout' && ask4Content.includes('2') && neverAskedAgain;
      report(
        '(g.4) la regla de g.3 se aplica en el siguiente run sin volver a preguntar',
        ok,
        `regla usada (de g.3): ${JSON.stringify(editRuleForNextRun)}\n` +
          `final=${termNext.finalState} archivo="${ask4Content.trim()}" nunca preguntó de nuevo=${neverAskedAgain}` +
          (permissionEvent ? `\npreguntó de nuevo con triggeredBy="${permissionEvent.request.triggeredBy}" (evidencia de que evaluate() no encontró/aplicó la regla persistida)` : ''),
      );
    } catch (err) {
      report('(g.4) la regla de g.3 se aplica en el siguiente run sin volver a preguntar', false, String((err as Error).stack ?? err));
    }

    // ── (h) reanudar un run awaiting_permission tras cerrar y reabrir el runtime (doc 10 §5.2) ──
    try {
      // Hallazgo (doc 16 §4 ítem 2, real): `edit_file`/`write_file` (packages/runtime/src/tools/,
      // fuera de mi zona) deciden "¿cambió el archivo desde que lo leí?" contra `ReadTracker`, un
      // Map en memoria del proceso — NUNCA contra `tool_calls.expected_pre_hash` (columna ya
      // reservada en el esquema desde la migración 1 exactamente para esto, doc 10 §3/§5.2, pero
      // nunca escrita por ningún handler). Un reinicio real de la app pierde el ReadTracker igual
      // que pierde cualquier otro estado en memoria, así que retomar una `edit_file` que dependía de
      // una lectura de ANTES del reinicio falla con "nunca lo leíste en este run" — no es un
      // problema de esta prueba, es un gap real no cerrado que excede packages/runtime/src/agent.
      // Para no confundir "resumeAfterRestart no funciona" con "el gap del ReadTracker no está
      // resuelto" (dos cosas distintas), este paso usa `write_file` sobre un archivo que TODAVÍA NO
      // EXISTE — el único caso que `write_file` exime del chequeo contra ReadTracker (doc 05 §2.8
      // punto 32) — para poder validar la reanudación en sí misma con una tool mutante real.
      const resumeProjectDir = mktemp('saurio-eval-resume-project-');
      mkdirSync(path.join(resumeProjectDir, 'src'), { recursive: true });
      const resumeDataDir = mktemp('saurio-eval-resume-data-');
      const resumeHostAdapter = makeHostAdapter(resumeDataDir);
      ensureHostDataDirs(resumeHostAdapter.paths);

      const runtime3 = createGlobalRuntime(resumeHostAdapter);
      await initGlobalRuntime(runtime3, resumeProjectDir);
      const project3 = await runtime3.persistence.repositories.projects.create({
        id: 'proj_resume', path: resumeProjectDir, name: 'saurio-eval-resume',
        createdAt: Date.now(), lastOpenedAt: Date.now(),
      });
      const resumeAgentId = 'agent_eval_resume';
      const resumeAgent: Partial<AgentConfig> & { id: string } = {
        id: resumeAgentId, model: modelRef, permissions: { ...DEFAULT_PERMISSION_POLICY, preset: 'strict' },
      };
      const controller3 = await buildEnhancedRunController(runtime3, resumeHostAdapter, project3, resumeAgent);
      const chat3 = await runtime3.persistence.repositories.chats.create({
        id: 'chat_resume', projectId: project3.id, agentId: resumeAgentId, mode: 'agent',
        modelRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
      });
      const run3 = await controller3.start(
        chat3.id,
        'Creá el archivo src/resume.ts (todavía no existe) con exactamente este contenido, usando write_file: export const resumeValue = 99;\n',
        'agent',
      );
      const wait3 = await waitForRunState(runtime3.events, run3.runId, 'awaiting_permission', 90_000);
      const pending3 = wait3.finalState === 'awaiting_permission' ? await findAwaitingPermissionCall(runtime3, run3.runId) : undefined;

      if (!pending3) {
        report('(h) reanudar un run awaiting_permission tras cerrar y reabrir el runtime', false, `el run no llegó a awaiting_permission (finalState=${wait3.finalState}); no se puede probar la reanudación`);
      } else {
        // "Cerrar la app": se cierra la conexión SQLite y se descartan runtime3/controller3 (nada
        // vive ya en memoria de ESE proceso para este run) — doc 10 §5.2 exige que responder el
        // permiso funcione igual sin haber vuelto a llamar a start().
        await new Promise((resolve) => setTimeout(resolve, 300));
        runtime3.persistence.close();

        const runtime4 = createGlobalRuntime(resumeHostAdapter);
        await initGlobalRuntime(runtime4, resumeProjectDir); // no debe tocar el run (awaiting_permission sobrevive intacto, doc 05 §1)
        const controller4 = await buildEnhancedRunController(runtime4, resumeHostAdapter, project3, resumeAgent);

        // Sin volver a llamar a start(): answerPermission debe rehidratar el run desde run_events/
        // tool_calls (doc 10 §5.2) y terminarlo, sin re-ejecutar nada que ya haya corrido.
        await controller4.answerPermission(pending3.id, { toolCallId: pending3.id, answer: 'allow_once' } as PermissionAnswer);
        const term4 = await waitForRunTerminal(runtime4.events, run3.runId, 60_000);

        const resumedExists = existsSync(path.join(resumeProjectDir, 'src', 'resume.ts'));
        const resumedContent = resumedExists ? readFileSync(path.join(resumeProjectDir, 'src', 'resume.ts'), 'utf8') : '(no existe)';
        const toolCallsAfter = await runtime4.persistence.repositories.toolCalls.listByRun(run3.runId);
        const mutatingCalls = toolCallsAfter.filter((c) => c.toolName === 'write_file' || c.toolName === 'edit_file');
        const exactlyOnceExecuted = mutatingCalls.filter((c) => c.status === 'done').length === 1;

        const ok = term4.finalState === 'completed' && resumedContent.includes('99') && exactlyOnceExecuted;
        report(
          '(h) reanudar un run awaiting_permission tras cerrar y reabrir el runtime',
          ok,
          `run=${run3.runId} quedó awaiting_permission antes de cerrar; tras reabrir en OTRA instancia de runtime/RunController, ` +
            `answerPermission(allow_once) sin volver a llamar start() -> estado final=${term4.finalState}\n` +
            `archivo tras reanudar: "${resumedContent.trim()}"\n` +
            `tool_calls mutantes tras reanudar: ${mutatingCalls.map((c) => `${c.toolName}:${c.status}`).join(', ')} (ejecutada exactamente una vez: ${exactlyOnceExecuted})\n` +
            `eventos completos del run (persistidos, incluye lo previo a reabrir): ${runtime4.events.since(run3.runId, 0).map((e) => e.type).join(' -> ')}`,
        );
        runtime4.persistence.close();
      }
      if (results.at(-1)?.ok) {
        rmSync(resumeProjectDir, { recursive: true, force: true });
        rmSync(resumeDataDir, { recursive: true, force: true });
      } else {
        log('(h) falló: se conservan para inspección', resumeProjectDir, resumeDataDir);
      }
    } catch (err) {
      report('(h) reanudar un run awaiting_permission tras cerrar y reabrir el runtime', false, String((err as Error).stack ?? err));
    }

    // ── (o) reinicio ENTRE lectura y edición + cambio externo en el medio => conflicto detectado
    // (doc 16 §4 ítem 16 / doc 10 §3, §5.2; punto 2 del encargo). A diferencia de (h) —donde
    // write_file sobre un archivo inexistente exime el chequeo a propósito—, acá SÍ debe dispararse
    // el conflicto: prueba que `tool_calls.expected_pre_hash` (escrito por `RunController` al
    // registrar la tool call, ANTES del reinicio) sigue siendo la fuente de verdad después de reabrir
    // el proceso, en vez del `ReadTracker` (vacío en el proceso nuevo, ver `buildEnhancedRunController`).
    try {
      const conflictResumeProjectDir = mktemp('saurio-eval-resume-conflict-project-');
      mkdirSync(path.join(conflictResumeProjectDir, 'src'), { recursive: true });
      const originalContent = 'export const resumeConflict = 1;\n';
      writeFileSync(path.join(conflictResumeProjectDir, 'src', 'resumeConflict.ts'), originalContent, 'utf8');
      const conflictResumeDataDir = mktemp('saurio-eval-resume-conflict-data-');
      const conflictResumeHostAdapter = makeHostAdapter(conflictResumeDataDir);
      ensureHostDataDirs(conflictResumeHostAdapter.paths);

      const runtime5 = createGlobalRuntime(conflictResumeHostAdapter);
      await initGlobalRuntime(runtime5, conflictResumeProjectDir);
      const project5 = await runtime5.persistence.repositories.projects.create({
        id: 'proj_resume_conflict', path: conflictResumeProjectDir, name: 'saurio-eval-resume-conflict',
        createdAt: Date.now(), lastOpenedAt: Date.now(),
      });
      const conflictResumeAgentId = 'agent_eval_resume_conflict';
      const conflictResumeAgent: Partial<AgentConfig> & { id: string } = {
        id: conflictResumeAgentId, model: modelRef, permissions: { ...DEFAULT_PERMISSION_POLICY, preset: 'strict' },
      };
      const controller5 = await buildEnhancedRunController(runtime5, conflictResumeHostAdapter, project5, conflictResumeAgent);
      const chat5 = await runtime5.persistence.repositories.chats.create({
        id: 'chat_resume_conflict', projectId: project5.id, agentId: conflictResumeAgentId, mode: 'agent',
        modelRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
      });
      const run5 = await controller5.start(
        chat5.id,
        'Primero leé src/resumeConflict.ts con read_file. Después, en otra llamada, editalo con edit_file: cambiá el valor de resumeConflict de 1 a 2, sin tocar nada más.',
        'agent',
      );
      const wait5 = await waitForRunState(runtime5.events, run5.runId, 'awaiting_permission', 90_000);
      const pending5 = wait5.finalState === 'awaiting_permission' ? await findAwaitingPermissionCall(runtime5, run5.runId) : undefined;

      if (!pending5 || pending5.toolName !== 'edit_file') {
        report(
          '(o) reinicio entre lectura y edición + cambio externo en el medio => conflicto detectado',
          false,
          `no se llegó a un edit_file en awaiting_permission (finalState=${wait5.finalState}, pending=${JSON.stringify(pending5)})`,
        );
      } else {
        const expectedPreHashBeforeRestart = (await runtime5.persistence.repositories.toolCalls.get(pending5.id))?.expectedPreHash;

        // "Cerrar la app": se cierra SQLite y se descartan runtime5/controller5 — el `ReadTracker` de
        // ESE proceso (con el hash real que vio `read_file`) desaparece, igual que en (h).
        await new Promise((resolve) => setTimeout(resolve, 300));
        runtime5.persistence.close();

        // Cambio externo mientras la app está "cerrada": exactamente el escenario que
        // `expected_pre_hash` tiene que detectar al reabrir.
        const externalContent = 'export const resumeConflict = 999; // cambiado por fuera, con la app cerrada\n';
        writeFileSync(path.join(conflictResumeProjectDir, 'src', 'resumeConflict.ts'), externalContent, 'utf8');

        const runtime6 = createGlobalRuntime(conflictResumeHostAdapter);
        await initGlobalRuntime(runtime6, conflictResumeProjectDir);
        const controller6 = await buildEnhancedRunController(runtime6, conflictResumeHostAdapter, project5, conflictResumeAgent);

        // Sin volver a llamar a start() ni a read_file: si `answerPermission` dependiera del
        // `ReadTracker` (vacío en este proceso nuevo), fallaría con "nunca lo leíste en este run" en
        // vez de detectar el conflicto real contra lo que pasó afuera.
        await controller6.answerPermission(pending5.id, { toolCallId: pending5.id, answer: 'allow_once' } as PermissionAnswer);
        const term6 = await waitForRunTerminalTolerant(runtime6.events, run5.runId, 90_000);
        if (term6.finalState === 'timeout') await controller6.cancel(run5.runId).catch(() => {});

        const toolCallsAfter6 = await runtime6.persistence.repositories.toolCalls.listByRun(run5.runId);
        const editCall = toolCallsAfter6.find((c) => c.id === pending5.id);
        const finalContent = readFileSync(path.join(conflictResumeProjectDir, 'src', 'resumeConflict.ts'), 'utf8');
        // Se evalúa sobre la tool call ORIGINAL (pending5.id), no sobre el estado final del run: el
        // modelo puede reintentar con una tool call nueva tras ver el error (releer y reeditar), lo
        // cual sería un comportamiento razonable del modelo, no una falla de esta prueba — lo que
        // importa acá es que ESA llamada puntual detectó el conflicto contra lo persistido.
        const conflictDetected = editCall?.status === 'failed'
          && (editCall.resultPreview ?? '').includes('cambió desde que lo leíste');
        const ok = expectedPreHashBeforeRestart !== undefined && conflictDetected;

        report(
          '(o) reinicio entre lectura y edición + cambio externo en el medio => conflicto detectado',
          ok,
          `expected_pre_hash persistido antes del reinicio: ${expectedPreHashBeforeRestart ?? '(ninguno)'}\n` +
            `tras reabrir en OTRA instancia y responder allow_once (sin volver a leer): estado del run=${term6.finalState}\n` +
            `tool call edit_file original (${pending5.id}) status=${editCall?.status ?? '(no encontrada)'} preview="${editCall?.resultPreview ?? ''}"\n` +
            `contenido del archivo al terminar: "${finalContent.trim()}" (== cambio externo: ${finalContent === externalContent})`,
        );
        runtime6.persistence.close();
      }
      if (results.at(-1)?.ok) {
        rmSync(conflictResumeProjectDir, { recursive: true, force: true });
        rmSync(conflictResumeDataDir, { recursive: true, force: true });
      } else {
        log('(o) falló: se conservan para inspección', conflictResumeProjectDir, conflictResumeDataDir);
      }
    } catch (err) {
      report('(o) reinicio entre lectura y edición + cambio externo en el medio => conflicto detectado', false, String((err as Error).stack ?? err));
    }

    // ── (i) TextToolProtocol de punta a punta con qwen2.5-coder:7b en modo agent (tool mutante) ──
    try {
      const coderRef: ModelRef = { providerId: 'ollama', name: 'qwen2.5-coder:7b', locality: 'local' };
      const installedCoder = (await runtime.modelManager.listInstalled()).some((m) => m.ref.name === coderRef.name);
      if (!installedCoder) {
        report('(i) TextToolProtocol con qwen2.5-coder:7b en modo agent (tool mutante)', false, 'modelo "qwen2.5-coder:7b" no está instalado en Ollama');
      } else {
        const coderAgentId = 'agent_eval_coder_text';
        const coderAgent: Partial<AgentConfig> & { id: string } = {
          id: coderAgentId, model: coderRef, toolTransport: 'text',
          permissions: { ...DEFAULT_PERMISSION_POLICY, preset: 'balanced' },
        };
        const coderController = await buildEnhancedRunController(runtime, hostAdapter, project, coderAgent);
        const coderChat = await runtime.persistence.repositories.chats.create({
          id: 'chat_coder_text', projectId: project.id, agentId: coderAgentId, mode: 'agent',
          modelRef: coderRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
        });
        writeFileSync(path.join(projectDir, 'src', 'coder.ts'), 'export function doble(n: number): number {\n  return n; // BUG: debería devolver n * 2\n}\n', 'utf8');
        const runCoder = await coderController.start(coderChat.id, 'Arreglá el bug de la función doble en src/coder.ts: tiene que devolver n * 2.', 'agent');
        const waitCoder = await waitForRunTerminal(runtime.events, runCoder.runId, 180_000);
        const coderToolCalls = await runtime.persistence.repositories.toolCalls.listByRun(runCoder.runId);
        const textEditCalls = coderToolCalls.filter((c) => c.toolName === 'edit_file' && c.transport === 'text');
        const newCoderContent = readFileSync(path.join(projectDir, 'src', 'coder.ts'), 'utf8');
        const ok = waitCoder.finalState === 'completed' && textEditCalls.some((c) => c.status === 'done') && /n\s*\*\s*2/.test(newCoderContent);
        const assistantMsgs = (runtime.events.since(runCoder.runId, 0).filter((e) => e.type === 'message.done') as Extract<RunEvent, { type: 'message.done' }>[])
          .filter((e) => e.message.role === 'assistant');
        report(
          '(i) TextToolProtocol con qwen2.5-coder:7b en modo agent (tool mutante)',
          ok,
          `estado final=${waitCoder.finalState}\ntool calls: ${coderToolCalls.map((c) => `${c.toolName}[${c.transport}]:${c.status}`).join(', ') || '(ninguna)'}\n` +
            `contenido nuevo:\n${newCoderContent}\n` +
            (ok ? '' : `mensajes del asistente (diagnóstico si falló el parseo de texto): ${assistantMsgs.map((e) => JSON.stringify(e.message.content)).join(' | ')}`),
        );
      }
    } catch (err) {
      report('(i) TextToolProtocol con qwen2.5-coder:7b en modo agent (tool mutante)', false, String((err as Error).stack ?? err));
    }

    // ── (j) capado automático de numCtx contra contextMax de /api/show (ADR-7) ──────────────────
    try {
      const bigCtxAgentId = 'agent_eval_bigctx';
      const bigCtxAgent: Partial<AgentConfig> & { id: string } = {
        id: bigCtxAgentId, model: modelRef,
        contextPolicy: { ...createDefaultAgentConfig(projectDir).contextPolicy, numCtx: 200_000 },
      };
      const bigCtxController = await buildEnhancedRunController(runtime, hostAdapter, project, bigCtxAgent);
      const bigCtxChat = await runtime.persistence.repositories.chats.create({
        id: 'chat_bigctx', projectId: project.id, agentId: bigCtxAgentId, mode: 'ask',
        modelRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
      });
      const desc = await runtime.modelManager.describeModel(modelRef);
      const runBigCtx = await bigCtxController.start(bigCtxChat.id, 'Decime en una palabra qué lenguaje usa este proyecto.', 'ask');
      const waitBigCtx = await waitForRunTerminal(runtime.events, runBigCtx.runId, 60_000);
      const runRecord = await runtime.persistence.repositories.runs.get(runBigCtx.runId);
      // `run.adjustment` se emite dentro de prepareAndQueue(), que `start()` espera ANTES de
      // devolver el runId — para cuando el harness llega a suscribirse con waitForRunTerminal, ese
      // evento ya pasó. `EventStore.since(runId, 0)` lee el historial persistido completo (no solo
      // lo que llegó después de suscribirse), así que es la fuente correcta acá.
      const allEventsForRun = runtime.events.since(runBigCtx.runId, 0);
      const adjustmentEvents = allEventsForRun.filter((e) => e.type === 'run.adjustment') as Extract<RunEvent, { type: 'run.adjustment' }>[];
      const numCtxAdjustment = adjustmentEvents.find((e) => e.adjustment.param === 'numCtx');
      const ok = waitBigCtx.finalState === 'completed' && desc.contextMax !== undefined
        && runRecord?.effectiveConfig?.numCtx === desc.contextMax && numCtxAdjustment !== undefined;
      report(
        '(j) capado automático de numCtx contra contextMax real de /api/show (ADR-7)',
        ok,
        `contextMax medido (/api/show)=${desc.contextMax}\nnumCtx pedido=200000\n` +
          `effectiveConfig.numCtx final=${runRecord?.effectiveConfig?.numCtx}\n` +
          `run.adjustment: ${numCtxAdjustment ? JSON.stringify(numCtxAdjustment.adjustment) : '(ninguno)'}`,
      );
    } catch (err) {
      report('(j) capado automático de numCtx contra contextMax real de /api/show (ADR-7)', false, String((err as Error).stack ?? err));
    }

    // ── (m) recuperación sin pérdida: usuario antes + agente + usuario después + revert keep_mine ──
    try {
      const conflictAgentId = 'agent_eval_conflict';
      const conflictAgent: Partial<AgentConfig> & { id: string } = { id: conflictAgentId, model: modelRef };
      const conflictController = await buildEnhancedRunController(runtime, hostAdapter, project, conflictAgent);
      const conflictChat = await runtime.persistence.repositories.chats.create({
        id: 'chat_conflict', projectId: project.id, agentId: conflictAgentId, mode: 'agent',
        modelRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
      });

      // 1) el usuario edita el archivo ANTES del run (estado base con el que el agente va a trabajar).
      const relPath = 'src/conflict.ts';
      const userBefore = 'export const conflictValue = 10;\n';
      writeFileSync(path.join(projectDir, relPath), userBefore, 'utf8');

      // 2) edición del agente.
      const runConflict = await conflictController.start(
        conflictChat.id, `Editá ${relPath}: cambiá el valor de conflictValue de 10 a 20, sin tocar nada más.`, 'agent',
      );
      const waitConflict = await waitForRunTerminal(runtime.events, runConflict.runId, 120_000);
      const conflictToolCalls = await runtime.persistence.repositories.toolCalls.listByRun(runConflict.runId);
      const conflictCheckpointEvent = waitConflict.events.find(
        (e) => e.type === 'checkpoint.created' && e.checkpoint.files.some((f) => f.relPath === relPath),
      ) as Extract<RunEvent, { type: 'checkpoint.created' }> | undefined;
      const afterAgent = readFileSync(path.join(projectDir, relPath), 'utf8');

      if (waitConflict.finalState !== 'completed' || !conflictCheckpointEvent) {
        report(
          '(m) recuperación sin pérdida: usuario antes + agente + usuario después + revert keep_mine',
          false,
          `el run del agente no completó con un checkpoint sobre ${relPath} (finalState=${waitConflict.finalState}, ` +
            `tool calls=${conflictToolCalls.map((c) => `${c.toolName}:${c.status}`).join(', ')})`,
        );
      } else {
        // 3) el usuario edita el archivo DESPUÉS de que el agente ya aplicó su cambio (tercer actor,
        //    fuera del run) — esto es lo que planRevert/revert deben detectar como conflicto.
        const userAfter = 'export const conflictValue = 20; // el usuario agregó este comentario después\n';
        writeFileSync(path.join(projectDir, relPath), userAfter, 'utf8');

        const checkpointId2 = conflictCheckpointEvent.checkpoint.id;
        const plan = await projectRuntime.checkpointService.planRevert([checkpointId2]);
        const conflictEntry = plan.conflicts.find((c) => c.relPath === relPath);

        // 4) revert con resolución keep_mine sobre el conflicto: no debe tocar lo que escribió el usuario.
        const resolution: Record<string, 'restore' | 'keep_mine' | 'skip'> = {};
        for (const rp of plan.restorable) resolution[rp] = 'restore';
        if (conflictEntry) resolution[relPath] = 'keep_mine';
        const revertResult = await projectRuntime.checkpointService.revert([checkpointId2], resolution);

        const finalContent = readFileSync(path.join(projectDir, relPath), 'utf8');
        const nadaSePerdio = finalContent === userAfter;
        const conflictoDetectado = conflictEntry !== undefined;
        const noRestaurado = !revertResult.restored.includes(relPath);
        const ok = afterAgent.includes('20') && conflictoDetectado && noRestaurado && nadaSePerdio;

        report(
          '(m) recuperación sin pérdida: usuario antes + agente + usuario después + revert keep_mine',
          ok,
          `1) usuario antes: "${userBefore.trim()}"\n2) agente aplicó (archivo tras el run): "${afterAgent.trim()}"\n` +
            `3) usuario después (fuera del run): "${userAfter.trim()}"\n` +
            `planRevert.conflicts incluye ${relPath}: ${conflictoDetectado} (${conflictEntry ? JSON.stringify(conflictEntry) : '-'})\n` +
            `revert con resolution keep_mine -> restored=${JSON.stringify(revertResult.restored)} skipped=${JSON.stringify(revertResult.skipped)}\n` +
            `contenido final == lo que escribió el usuario después (nada se perdió): ${nadaSePerdio}\n` +
            `contenido final real: "${finalContent.trim()}"`,
        );
      }
    } catch (err) {
      report('(m) recuperación sin pérdida: usuario antes + agente + usuario después + revert keep_mine', false, String((err as Error).stack ?? err));
    }

    // ── (n) compactación real: estado compacting + evento context.compacted (doc 16 §4 ítem 5) ──
    try {
      // compactEveryTurns=1 + keepLastTurns=1 fuerza el disparador por cantidad de turnos (doc 07
      // §7.1 punto 2) desde la segunda vuelta del loop, sin depender de llenar el ratio de tokens
      // — determinístico y rápido de reproducir contra un modelo real.
      const compactAgentId = 'agent_eval_compact';
      const compactAgent: Partial<AgentConfig> & { id: string } = {
        id: compactAgentId, model: modelRef,
        contextPolicy: { ...createDefaultAgentConfig(projectDir).contextPolicy, compactEveryTurns: 1, keepLastTurns: 1 },
      };
      const compactController = await buildEnhancedRunController(runtime, hostAdapter, project, compactAgent);
      const compactChat = await runtime.persistence.repositories.chats.create({
        id: 'chat_compact', projectId: project.id, agentId: compactAgentId, mode: 'agent',
        modelRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
      });
      writeFileSync(path.join(projectDir, 'src', 'compact.ts'), 'export const compactValue = 1;\n', 'utf8');
      const runCompact = await compactController.start(
        compactChat.id,
        'Primero leé src/compact.ts con read_file. Después, en un turno aparte, editalo con edit_file cambiando compactValue de 1 a 2.',
        'agent',
      );
      const waitCompact = await waitForRunTerminalTolerant(runtime.events, runCompact.runId, 150_000);
      const allEventsCompact = runtime.events.since(runCompact.runId, 0);
      const compactingTransition = allEventsCompact.find((e) => e.type === 'run.state' && e.to === 'compacting');
      const compactedEvent = allEventsCompact.find((e) => e.type === 'context.compacted') as Extract<RunEvent, { type: 'context.compacted' }> | undefined;
      let compactedByOk = true;
      let markedIds: string[] = [];
      if (compactedEvent?.summaryMessageId && compactedEvent.replacedMessageIds && compactedEvent.replacedMessageIds.length > 0) {
        const chatMessages = await runtime.persistence.repositories.messages.listByChat(compactChat.id);
        markedIds = compactedEvent.replacedMessageIds;
        // MessageRepository no expone compacted_by (no forma parte de ChatMessage, doc 03 §4.3 es
        // solo de persistencia) — se verifica directo contra la fila de SQLite.
        const row = runtime.persistence.driver.prepare<CompactedMessageRow>(
          `SELECT id, compacted_by FROM messages WHERE id IN (${markedIds.map(() => '?').join(',')})`,
        ).all(...markedIds);
        compactedByOk = row.length === markedIds.length && row.every((r) => r.compacted_by === compactedEvent.summaryMessageId);
        void chatMessages;
      }
      const ok = waitCompact.finalState !== 'timeout' && compactingTransition !== undefined && compactedEvent !== undefined && compactedByOk;
      report(
        '(n) compactación real: run.state -> compacting y evento context.compacted, mensajes marcados compacted_by',
        ok,
        `estado final=${waitCompact.finalState}\ntransición a compacting: ${compactingTransition !== undefined}\n` +
          `context.compacted: ${compactedEvent ? JSON.stringify(compactedEvent) : '(nunca se emitió)'}\n` +
          `mensajes marcados compacted_by correctamente: ${compactedByOk} (ids: ${JSON.stringify(markedIds)})\n` +
          `secuencia de run.state: ${allEventsCompact.filter((e) => e.type === 'run.state').map((e) => (e as Extract<RunEvent, {type:'run.state'}>).to).join(' -> ')}`,
      );
    } catch (err) {
      report('(n) compactación real: run.state -> compacting y evento context.compacted, mensajes marcados compacted_by', false, String((err as Error).stack ?? err));
    }

    // ── (p) doc 19 T04: chat directo con un agente PERSONAL (E2a "Mis agentes") ────────────────
    try {
      const personalProfile = await runtime.persistence.repositories.agents.createProfile({
        name: 'Agente eval personal', role: 'custom', modelMode: 'fixed', model: modelRef,
        systemPrompt: 'Sos "Agente eval personal", un agente de prueba. Cuando te saluden, respondé identificándote por tu nombre en una frase corta y después llamá a finish.',
        permissionPreset: 'balanced', memoryScope: 'global',
      });
      const personalAgentConfig = await runtime.persistence.repositories.agents.get(personalProfile.id);
      if (!personalAgentConfig) throw new Error('createProfile no dejó un AgentConfig resoluble (doc 19 §1.5)');
      const personalController = await buildEnhancedRunController(runtime, hostAdapter, project, personalAgentConfig);
      const personalChat = await runtime.persistence.repositories.chats.create({
        id: 'chat_personal_agent', projectId: project.id, agentId: personalProfile.id, mode: 'agent',
        modelRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
      });
      const runPersonal = await personalController.start(personalChat.id, 'Hola, ¿quién sos?', 'agent');
      const waitPersonal = await waitForRunTerminalTolerant(runtime.events, runPersonal.runId, 120_000);
      const personalMessages = await runtime.persistence.repositories.messages.listByChat(personalChat.id);
      const assistantMsg = personalMessages.find((m) => m.role === 'assistant' && m.content.trim().length > 0);
      const readChat = await runtime.persistence.repositories.chats.get(personalChat.id);
      const ok = waitPersonal.finalState === 'completed' && assistantMsg !== undefined && readChat?.agentId === personalProfile.id;
      report(
        '(p) doc 19 T04: chat directo con un agente personal — identidad visible, chat.agentId refleja el agente',
        ok,
        `agente creado: ${personalProfile.id} (ownerKind=${personalProfile.ownerKind})\n` +
          `estado final=${waitPersonal.finalState}\nchat.agentId=${readChat?.agentId}\n` +
          `respuesta del agente: ${assistantMsg ? JSON.stringify(assistantMsg.content.slice(0, 300)) : '(ninguna)'}`,
      );
    } catch (err) {
      report('(p) doc 19 T04: chat directo con un agente personal — identidad visible, chat.agentId refleja el agente', false, String((err as Error).stack ?? err));
    }

    // ── (q) doc 19 T06/T07: delegación a un worker temporal, entregable vuelve al padre (E3a) ──
    try {
      const delegatorAgentId = 'agent_eval_delegator';
      const delegatorAgent: Partial<AgentConfig> & { id: string } = {
        id: delegatorAgentId, model: modelRef,
        systemPrompt: 'Sos un agente que delega tareas chicas. Cuando te pidan algo simple, usá la tool `delegate` SIN indicar targetAgentId (así se crea un worker temporal) con una `task`/`expectedDeliverable` claros. Esperá el resultado de la tool y después llamá a finish resumiendo lo que devolvió el worker.',
        allowedTools: ['list_files', 'read_file', 'finish', 'delegate'],
      };
      const delegatorController = await buildEnhancedRunController(runtime, hostAdapter, project, delegatorAgent);
      const delegatorChat = await runtime.persistence.repositories.chats.create({
        id: 'chat_delegator', projectId: project.id, agentId: delegatorAgentId, mode: 'agent',
        modelRef, createdAt: Date.now(), updatedAt: Date.now(), archived: false,
      });
      const runDelegator = await delegatorController.start(
        delegatorChat.id,
        'Delegale a un worker temporal la tarea de listar 3 ideas de nombres para una mascota (entregable: una lista corta). Esperá el resultado y después resumímelo con finish.',
        'agent',
      );
      // Doc 19 §2.5: `delegate` es category 'delegate' -> default 'ask' (permissions/engine.ts,
      // mismo criterio cauteloso que terminal/network/mcp) — el agente `balanced` de este harness
      // (preset por defecto de `createDefaultAgentConfig`) SÍ pasa por el permiso, a diferencia de
      // los pasos (b)/(c)/(n) que usan tools de categoría read/write ya permitidas por defecto. Sin
      // este paso, el run queda en awaiting_permission para siempre y el hallazgo real de esta
      // sesión (visto en la primera corrida del harness) es justamente eso: el paso reportaba
      // "timeout" no porque la delegación esté rota, sino porque nadie contestaba el pedido.
      // (ver comentario de `driveThroughPermissionAsks`, arriba): el modelo puede llamar `delegate`
      // más de una vez en el mismo run (ej. si no queda conforme con el resultado del primer worker),
      // y cada llamada nueva es su propia `ask` — contestar solo la primera deja el run colgado
      // esperando una segunda respuesta que nunca llega.
      const driveDelegate = await driveThroughPermissionAsks(
        runtime, delegatorController, runDelegator.runId, (id) => ({ toolCallId: id, answer: 'allow_once' }),
        { perRoundTimeoutMs: 180_000, maxRounds: 3 },
      ).catch((err) => { log('(q): driveThroughPermissionAsks falló:', String(err)); return { rounds: 0, firstToolCallId: undefined, finalState: 'timeout' }; });
      const pendingDelegate = driveDelegate.firstToolCallId ? { id: driveDelegate.firstToolCallId } : undefined;
      const waitDelegator = { finalState: driveDelegate.finalState };
      const allEventsDelegator = runtime.events.since(runDelegator.runId, 0);
      const delegatedEvent = allEventsDelegator.find((e) => e.type === 'run.delegated') as Extract<RunEvent, { type: 'run.delegated' }> | undefined;
      const delegateToolCalls = (await runtime.persistence.repositories.toolCalls.listByRun(runDelegator.runId))
        .filter((c) => c.toolName === 'delegate');
      let childOk = false;
      let childEvidence = '(no se emitió run.delegated)';
      if (delegatedEvent) {
        const childRun = await runtime.persistence.repositories.runs.get(delegatedEvent.childRunId);
        const childChat = await runtime.persistence.repositories.chats.get(delegatedEvent.childChatId);
        const workerProfile = await runtime.persistence.repositories.agents.getProfile(delegatedEvent.targetAgentId);
        childOk = childRun?.state === 'completed' && childRun?.parentRunId === runDelegator.runId
          && childRun?.delegationDepth === 1 && childChat?.originRunId === runDelegator.runId
          && workerProfile?.ownerKind === 'worker';
        childEvidence = `childRunId=${delegatedEvent.childRunId} state=${childRun?.state} parentRunId=${childRun?.parentRunId} ` +
          `delegationDepth=${childRun?.delegationDepth} childChat.originRunId=${childChat?.originRunId} ` +
          `worker.ownerKind=${workerProfile?.ownerKind}`;
      }
      const ok = waitDelegator.finalState === 'completed' && delegateToolCalls.length > 0
        && delegateToolCalls[0]?.category === 'delegate' && delegateToolCalls[0]?.resultIsError === false && childOk;
      report(
        '(q) doc 19 T06/T07: delegación a un worker temporal — entregable estructurado vuelve al padre',
        ok,
        `permiso de delegate contestado: ${pendingDelegate !== undefined}\n` +
          `run padre estado final=${waitDelegator.finalState}\n` +
          `tool calls delegate: ${delegateToolCalls.length} (status=${delegateToolCalls.map((c) => c.status).join(',')}, resultIsError=${delegateToolCalls.map((c) => c.resultIsError).join(',')})\n` +
          `run.delegated: ${childEvidence}\n` +
          `resultPreview del delegate: ${delegateToolCalls[0]?.resultPreview ?? '(ninguno)'}`,
      );
    } catch (err) {
      report('(q) doc 19 T06/T07: delegación a un worker temporal — entregable estructurado vuelve al padre', false, String((err as Error).stack ?? err));
    }
  } else {
    for (const step of [
      '(b) run modo plan hasta completed, con tool calls de lectura y plan/tasks',
      '(c) run modo agent: edit_file pending->ejecutado, checkpoint creado, archivo cambiado, métricas presentes',
      '(d) diff del checkpoint (+N -M)',
      '(e) revert del checkpoint: el archivo vuelve a su contenido exacto',
      '(g.1) permiso ask -> allow_once: awaiting_permission, se aplica, permission_decisions registrada',
      '(g.2) permiso ask -> deny: el modelo recibe el motivo, el archivo no se toca',
      '(g.3) permiso ask -> allow_always (scope project): se aplica y persiste en permission_rules',
      '(g.4) la regla de g.3 se aplica en el siguiente run sin volver a preguntar',
      '(h) reanudar un run awaiting_permission tras cerrar y reabrir el runtime',
      '(o) reinicio entre lectura y edición + cambio externo en el medio => conflicto detectado',
      '(i) TextToolProtocol con qwen2.5-coder:7b en modo agent (tool mutante)',
      '(j) capado automático de numCtx contra contextMax real de /api/show (ADR-7)',
      '(k) modo plan: el checklist queda persistido en tasks (task_update y/o finish.tasks)',
      '(l) edit_file con old_string ambiguo devuelve las coincidencias numeradas (línea + preview)',
      '(m) recuperación sin pérdida: usuario antes + agente + usuario después + revert keep_mine',
      '(n) compactación real: run.state -> compacting y evento context.compacted, mensajes marcados compacted_by',
    ]) {
      report(step, false, 'saltado: (a) no encontró un modelRef válido');
    }
  }

  // ── (f) cerrar el runtime, abrir OTRA instancia sobre la misma base ────────────────────────────
  // Margen antes de cerrar: deja drenar cualquier callback en vuelo de un run que ya llegó a
  // estado terminal (backoff/retry pendiente, etc.) para no cerrar la conexión SQLite debajo suyo.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  runtime.persistence.close();
  log('runtime #1 cerrado; abriendo runtime #2 sobre la misma base:', hostAdapter.paths.dbPath);
  try {
    const runtime2 = createGlobalRuntime(hostAdapter);
    const recoverAtReopen = await initGlobalRuntime(runtime2, projectDir);

    const readChat = chat ? await runtime2.persistence.repositories.chats.get(chat.id) : undefined;
    const messages = chat ? await runtime2.persistence.repositories.messages.listByChat(chat.id) : [];
    const planToolCalls = planRunId ? await runtime2.persistence.repositories.toolCalls.listByRun(planRunId) : [];
    const agentToolCalls = agentRunId ? await runtime2.persistence.repositories.toolCalls.listByRun(agentRunId) : [];
    const checkpoints = chat ? await runtime2.persistence.repositories.checkpoints.listByChat(chat.id) : [];

    const ok = readChat !== undefined && messages.length > 0
      && (planToolCalls.length > 0 || agentToolCalls.length > 0) && checkpoints.length > 0
      && recoverAtReopen.orphaned.length === 0 && recoverAtReopen.abandoned.length === 0;

    report(
      '(f) reabrir la base en otra instancia: historial conservado, recover() sin runs activos',
      ok,
      `chat leído: ${readChat ? readChat.id : '(no encontrado)'}\n` +
        `mensajes=${messages.length} tool calls plan=${planToolCalls.length} tool calls agent=${agentToolCalls.length} checkpoints=${checkpoints.length}\n` +
        `recover() al reabrir: orphaned=${recoverAtReopen.orphaned.length} abandoned=${recoverAtReopen.abandoned.length}`,
    );
    runtime2.persistence.close();
  } catch (err) {
    report('(f) reabrir la base en otra instancia: historial conservado, recover() sin runs activos', false, String((err as Error).stack ?? err));
  }

  // ── resumen ──────────────────────────────────────────────────────────────────────────────────
  console.log('\n=== Resumen recorrido #1 ===');
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.step}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\nTotal: ${results.length - failed.length}/${results.length} pasos OK, duración total ${((Date.now() - harnessStart) / 1000).toFixed(1)}s`);

  // Limpieza de las carpetas temporales: solo si TODO pasó (best-effort). Si algo falló, se dejan
  // para poder inspeccionarlas a mano.
  if (failed.length === 0) {
    for (const dir of [projectDir, dataDir]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* no-op */ }
    }
  } else {
    console.log(`\n(carpetas conservadas para inspección: proyecto=${projectDir} datos=${dataDir})`);
  }

  if (failed.length > 0) process.exitCode = 1;
}

process.on('unhandledRejection', (err) => {
  console.error('[harness] unhandledRejection (probablemente un run que siguió corriendo en background tras cerrar la base):', err);
});

main().catch((err) => {
  console.error('[harness] error no manejado:', err);
  process.exitCode = 1;
});
