// Punto de entrada de @saurio/runtime (doc 02 §1, doc 04). Reexporta los contratos de tipos de
// cada submódulo (fase de contratos); las implementaciones concretas se conectan acá a medida que
// se completan en fases posteriores. persistence/driver.js ya tiene implementación (fuera de esta
// fase) y se sigue reexportando tal cual.
export * from './gateway/index.js';
export * from './tools/types.js';
export * from './agent/types.js';
export * from './permissions/types.js';
export * from './checkpoint/types.js';
export * from './context/types.js';
export * from './models/types.js';
export * from './telemetry/types.js';
export * from './persistence/types.js';
export * from './tasks/types.js';
export * from './benchmark/types.js';

export * from './persistence/driver.js';
