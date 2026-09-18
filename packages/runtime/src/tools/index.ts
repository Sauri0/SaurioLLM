// ToolRegistry, WorkspaceFs, protocolos y builtins — packages/runtime/src/tools/index.ts.
// Define: doc 02 §1 (packages/runtime/src/tools/) y doc 04 §4 (Tool System). Punto de entrada público
// del módulo tools/ para el resto del runtime (AgentRuntime, ipc/, etc.).
export * from './types.js';
export * from './errors.js';
export { createToolRegistry, ToolRegistryImpl } from './ToolRegistry.js';
export { createWorkspaceFs, WorkspaceFsImpl, type WorkspaceFsOptions } from './WorkspaceFs.js';
export { PathLock } from './pathLock.js';
export { ReadTracker } from './readTracker.js';
export { matchCascade, replaceAtCascade, type MatchResult, type MatchFailure } from './matching.js';
export { createNativeToolProtocol, NativeToolProtocol } from './protocols/native.js';
export { createTextToolProtocol, TextToolProtocol } from './protocols/text.js';
export { scanToolCallBlocks } from './protocols/scanToolCalls.js';
export { repairJson } from './protocols/jsonRepair.js';
export {
  createBuiltinTools,
  defaultBuiltinToolsDeps,
  classifyCommand,
  type BuiltinToolsDeps,
} from './builtin/index.js';
