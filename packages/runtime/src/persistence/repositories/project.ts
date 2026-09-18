// ProjectRepository (doc 03 §4.1, doc 04 §2 Project) — packages/runtime/src/persistence/repositories/project.ts.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { ProjectRepository } from '../types.js';
import type { Project } from '@saurio/shared';

interface ProjectRow extends SqliteRow {
  id: string; path: string; name: string | null; created_at: number;
  last_opened_at: number | null; settings_json: string | null;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    path: row.path,
    name: row.name ?? '',
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at ?? row.created_at,
    settings: row.settings_json ? (JSON.parse(row.settings_json) as Record<string, unknown>) : undefined,
  };
}

export function createProjectRepository(driver: SqliteDriver): ProjectRepository {
  return {
    async create(project: Project): Promise<Project> {
      driver.prepare(
        `INSERT INTO projects (id, path, name, created_at, last_opened_at, settings_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        project.id, project.path, project.name, project.createdAt, project.lastOpenedAt,
        project.settings ? JSON.stringify(project.settings) : null,
      );
      return project;
    },
    async get(id: string): Promise<Project | undefined> {
      const row = driver.prepare<ProjectRow>('SELECT * FROM projects WHERE id = ?').get(id);
      return row ? rowToProject(row) : undefined;
    },
    async list(): Promise<Project[]> {
      return driver.prepare<ProjectRow>('SELECT * FROM projects ORDER BY last_opened_at DESC').all().map(rowToProject);
    },
    async touchLastOpened(id: string, at: number): Promise<void> {
      driver.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(at, id);
    },
  };
}
