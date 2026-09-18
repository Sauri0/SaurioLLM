// Migración 3 — packages/runtime/src/persistence/migrations/0003_messages_model_ref.ts.
// Punto 4 del encargo (doc 16 §10.4/§10.9: "el badge NUBE por mensaje refleja el modelo VIGENTE del
// chat, no el que generó ese mensaje puntual... requeriría persistir modelRef/locality por mensaje,
// columna nueva en messages"): agrega `messages.model_ref_json` (nullable, sin CHECK) con
// `{ providerId, name, locality }` del modelo que efectivamente generó ESE mensaje — `ALTER TABLE ...
// ADD COLUMN` simple alcanza (no hay que reconstruir la tabla, doc 03 §8 solo lo exige para
// ensanchar un CHECK existente, no para agregar una columna nueva). Mensajes viejos (de antes de esta
// migración) quedan con `NULL`; la UI cae al modelo VIGENTE del chat como hacía hasta ahora (doc 16
// §10.4, limitación ya documentada, ahora resuelta hacia adelante).
import type { Migration } from './types.js';

export const migration0003: Migration = {
  version: 3,
  name: '0003_messages_model_ref',
  sql: `
ALTER TABLE messages ADD COLUMN model_ref_json TEXT;
`,
};
