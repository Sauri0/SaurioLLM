// Interfaz del driver SQLite y su implementación elegida; punto único de reemplazo por node:sqlite (doc 02 §1,
// ADR-003 en docs/architecture/12-decisiones.md). SQLITE_DRIVER = better-sqlite3 (ver N:\saurio-smoke\RESULTADOS-electron.md).
import Database from 'better-sqlite3';

/** Fila devuelta por una consulta; el shape real lo define quien tipa la query. */
export type SqliteRow = Record<string, unknown>;

/** Statement preparado, envuelto para no exponer la API concreta de better-sqlite3 al resto del runtime. */
export interface PreparedStatement<Row extends SqliteRow = SqliteRow> {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}

/**
 * Interfaz mínima que necesita el resto de packages/runtime/src/persistence/*: abrir, ejecutar SQL suelto,
 * preparar statements, leer/escribir pragmas y cerrar. Cualquier código fuera de este archivo depende SOLO
 * de esta interfaz, nunca de better-sqlite3 directamente (así se puede migrar a node:sqlite sin tocar el resto).
 */
export interface SqliteDriver {
  exec(sql: string): void;
  prepare<Row extends SqliteRow = SqliteRow>(sql: string): PreparedStatement<Row>;
  pragma(pragma: string): unknown;
  close(): void;
}

class BetterSqlite3Driver implements SqliteDriver {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare<Row extends SqliteRow = SqliteRow>(sql: string): PreparedStatement<Row> {
    const statement = this.db.prepare(sql);
    return {
      run: (...params: unknown[]) => statement.run(...params),
      get: (...params: unknown[]) => statement.get(...params) as Row | undefined,
      all: (...params: unknown[]) => statement.all(...params) as Row[],
    };
  }

  pragma(pragma: string): unknown {
    return this.db.pragma(pragma);
  }

  close(): void {
    this.db.close();
  }
}

/** Abre la base en `path`, aplica los PRAGMAs de conexión de doc 03 §2 y devuelve el driver.
 *  `path` puede ser ':memory:' para tests (WAL no aplica ahí; el resto de los pragmas sí). */
export function openDriver(path: string): SqliteDriver {
  const driver = new BetterSqlite3Driver(path);
  driver.pragma('journal_mode = WAL');
  driver.pragma('synchronous = NORMAL');
  driver.pragma('foreign_keys = ON');
  driver.pragma('busy_timeout = 5000');
  driver.pragma('temp_store = MEMORY');
  return driver;
}
