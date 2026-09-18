// Test de humo del driver: abre una DB temporal real (WAL no funciona en :memory:), activa WAL,
// crea una tabla FTS5 y consulta (doc 02 §1, requisito de verificación del scaffolding).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDriver, type SqliteDriver } from './driver.js';

describe('persistence/driver', () => {
  let dir: string;
  let dbPath: string;
  let driver: SqliteDriver;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'saurio-driver-test-'));
    dbPath = path.join(dir, 'smoke.db');
    driver = openDriver(dbPath);
  });

  afterEach(() => {
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('activa WAL en una base de archivo real', () => {
    const rows = driver.pragma('journal_mode') as Array<{ journal_mode: string }>;
    const journalMode = rows[0]?.journal_mode;
    expect(journalMode?.toLowerCase()).toBe('wal');
    expect(existsSync(dbPath)).toBe(true);
  });

  it('crea una tabla FTS5 y consulta resultados', () => {
    driver.exec(`CREATE VIRTUAL TABLE docs USING fts5(body);`);
    const insert = driver.prepare('INSERT INTO docs (body) VALUES (?)');
    insert.run('SaurioLLM indexa el repo con tree-sitter');
    insert.run('El scheduler vive dentro del ModelGateway');

    const rows = driver.prepare<{ body: string }>(
      `SELECT body FROM docs WHERE docs MATCH ? ORDER BY rank`,
    ).all('scheduler');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toContain('ModelGateway');
  });
});
