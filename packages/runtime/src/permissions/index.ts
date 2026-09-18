// Punto de entrada del módulo permissions — packages/runtime/src/permissions/index.ts.
// Reexporta el `PermissionEngine` (engine.ts), `CommandParser` (command-parser.ts), invariantes
// (protected.ts, critical.ts), utilidades de patrones (patterns.ts) y la memoria de decisiones
// (memory.ts, repository.ts) — ver doc 06-permisos-y-modos.md.
export * from './types.js';
export * from './engine.js';
export * from './command-parser.js';
export * from './protected.js';
export * from './critical.js';
export * from './patterns.js';
export * from './memory.js';
export * from './repository.js';
