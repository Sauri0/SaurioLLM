// Agent Runtime: RunController, RunStateMachine, LoopDetector, DegenerationDetector, recover()
// (doc 02 §1: packages/runtime/src/agent/). Barrel del módulo: reexporta el contrato de tipos
// (types.ts, sin modificar), los puertos locales (ports.ts) y las implementaciones de esta fase.
// `types.ts` también declara una interfaz `RunController` (doc 04 §5, contrato resumido) y
// `RunController.ts` de esta fase exporta la clase que la implementa con el mismo nombre; se
// reexporta la interfaz como `RunControllerContract` para no chocar (TS2308) y se deja `RunController`
// como el valor (la clase) — el uso habitual en este módulo.
export type {
  ContextPolicy, AgentConfig, EffectiveConfig, Run, RunController as RunControllerContract,
  Adjustment, RunError, ToolCallRecord,
} from './types.js';
export { RUN_TRANSITIONS } from './types.js';
export * from './ports.js';
export * from './defaults.js';
export * from './modelPolicy.js';
export * from './personalProject.js';
export * from './hash.js';
export * from './RunStateMachine.js';
export * from './LoopDetector.js';
export * from './DegenerationDetector.js';
export * from './recover.js';
export * from './RunController.js';
