// Tool System: registro, protocolo y contexto de ejecución — packages/runtime/src/tools/types.ts.
// Define: doc 04 §4. Solo interfaces/tipos (sin implementación); las 10 builtins se implementan en
// packages/runtime/src/tools/builtin/. `source.kind = 'mcp' | 'delegate'` existen en el tipo desde
// el día 1 (principio 8 de la columna) pero sin implementación hasta v0.3/v0.4.
import type { ZodType } from 'zod';
import type { PermissionCategory, Risk, Mode, ChatMessage, ToolCall, ToolResult } from '@saurio/shared';

/** classify() es donde se declaran peligrosidad y efectos secundarios reales de una llamada
 *  concreta (p. ej. run_command según el comando parseado); category/mutating son la base estática. */
export interface ToolClassification {
  category: PermissionCategory; risk: Risk; summary: string;
  paths?: string[];              // edit_file/write_file/delete_file: para protected paths
  command?: string;              // run_command: comando parseado, para CommandParser
}

export interface ToolDefinition<A = unknown> {
  name: string;                                    // [A-Za-z0-9_.-]{1,128}; MCP: mcp__<server>__<tool>
  description: string;
  inputSchema: object;                             // JSON Schema; contrato con el modelo y con MCP
  argsSchema?: ZodType<A>;                          // builtins: fuente de verdad; deriva inputSchema
  category: PermissionCategory;                     // categoría base, antes de classify()
  mutating: boolean;                                // dispara CheckpointService.begin
  idempotent: boolean;                               // [DECISIÓN DE DISEÑO, agregado en doc 04]
                                                      // true: reintentar tras un fallo de red no duplica efecto
                                                      // (list_files, search_code, read_file, read_output, task_update);
                                                      // false: edit_file, write_file, delete_file, run_command — nunca
                                                      // se reintentan solas (columna §12, "idempotencia")
  allowedInModes: Mode[];
  source: { kind: 'builtin' } | { kind: 'mcp'; serverId: string } | { kind: 'delegate' };  // mcp/delegate: v0.3/v0.4
  classify?(args: A): ToolClassification;           // si falta, se usa { category, risk: 'low', summary: name }
  handler: ToolHandler<A>;
}

export type ToolHandler<A> = (args: A, ctx: ToolContext) => Promise<ToolResult>;

export interface CheckpointHandle {
  checkpointId: string;
  before(relPath: string): Promise<void>;
  after(relPath: string): Promise<void>;
}

export interface ToolContext {
  projectRoot: string; cwd: string; runId: string; toolCallId: string;
  signal: AbortSignal; timeoutMs: number;
  fs: WorkspaceFs;                                  // confinado al workspace; aplica protected paths y .saurioignore
  checkpoint: CheckpointHandle;                      // begin ya hecho por el runtime si mutating === true
  emit(ev: { toolCallId: string; text: string }): void;   // shape del payload de 'tool.progress' (doc 04 §6); RunEvent no tiene campo `payload`
  log(e: unknown): void;
}

/** Acceso a archivos confinado; ninguna tool ni MCP toca fs/child_process directamente. */
export interface WorkspaceFs {
  readFile(relPath: string): Promise<{ content: string; hash: string; eol: 'LF' | 'CRLF'; bom: boolean }>;
  writeFileAtomic(relPath: string, content: string, opts?: { eol?: 'LF' | 'CRLF'; bom?: boolean }): Promise<void>;
  deleteFile(relPath: string): Promise<void>;
  /** Punto 4 del encargo: crea `relPath` (y sus carpetas intermedias) dentro del workspace, sin
   *  comandos de shell. No falla si la carpeta ya existe (mismo criterio que `fs.mkdir(...,
   *  {recursive: true})` — "ya existe" no es un error para esta operación). */
  makeDir(relPath: string): Promise<void>;
  listDir(relPath: string, depth: number): Promise<{ path: string; isDir: boolean }[]>;
  isProtected(relPath: string): boolean;             // .git/**, .saurio/**, .env*, *.pem, id_rsa*, .vscode/**, .idea/**
  isIgnored(relPath: string): boolean;               // .gitignore + .saurioignore
  resolve(relPath: string): string;                  // rechaza '..' que salga del workspace
}

/** Dos transportes detrás de una interfaz (ADR-6): NativeToolProtocol usa la API tools;
 *  TextToolProtocol imprime <tool_call> en el prompt y escanea content. */
export interface ToolProtocol {
  renderTools(tools: ToolDefinition[]): { apiTools?: import('../gateway/types.js').JsonSchemaTool[]; systemSuffix?: string; stop?: string[] };
  /** `tools` (opcional): las tools disponibles EN ESTE TURNO (mismo `availableTools` que
   *  `RunController` ya le pasó a `renderTools()` una línea antes, doc 16 §4 ítem 3/§9.7, punto 3 del
   *  encargo) — el fallback de bloques JSON narrados (`scanToolCallBlocks`) las usa para preferir el
   *  PRIMER bloque que corresponda a una tool EXISTENTE con argumentos VÁLIDOS, en vez del último
   *  bloque a secas. Sin este argumento, se conserva el criterio permisivo previo (primer `name`
   *  string, sin validar existencia/argumentos). */
  parse(message: ChatMessage, tools?: ToolDefinition[]): { toolCalls: ToolCall[]; text: string; parseErrors: string[] };
  renderResult(call: ToolCall, result: ToolResult): ChatMessage;   // native: role 'tool'; text: role 'user' + <tool_result>
}

/** Registro único: builtins, MCP (v0.3) y delegate (v0.4) conviven detrás de la misma interfaz;
 *  el AgentRuntime nunca distingue el origen de una tool al invocarla. */
export interface ToolRegistry {
  register(def: ToolDefinition): void;
  unregister(name: string): void;
  list(filter?: { names?: string[]; mode?: Mode }): ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  onChanged(cb: () => void): () => void;             // MCP tools/list_changed; no-op hasta v0.3
}

/** Firma de las builtins del registro (nombres únicos, implementación fuera de este documento).
 *  `make_dir` (punto 4 del encargo, feedback real v0.2.1) se agregó a las 10 originales del MVP. */
export type BuiltinToolName =
  | 'list_files' | 'search_code' | 'read_file' | 'read_output'
  | 'edit_file' | 'write_file' | 'delete_file' | 'run_command'
  | 'task_update' | 'finish' | 'make_dir';
