// Forma de una migración embebida y numerada (doc 03 §8 "Estrategia de migraciones") —
// packages/runtime/src/persistence/migrations/types.ts.
export interface Migration {
  /** Corresponde a PRAGMA user_version tras aplicar esta migración. */
  version: number;
  name: string;
  /** DDL/DML de esta migración únicamente (no acumulativo); se ejecuta con driver.exec dentro
   *  de su propia transacción (doc 03 §8 punto 4: "cada una en su propia transacción"). */
  sql: string;
}
