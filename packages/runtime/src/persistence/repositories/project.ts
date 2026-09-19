// ProjectRepository (doc 03 §4.1, doc 04 §2 Project) — packages/runtime/src/persistence/repositories/project.ts.
import type { SqliteDriver, SqliteRow } from '../driver.js';
import type { ProjectRepository } from '../types.js';
import type { Project } from '@saurio/shared';

interface ProjectRow extends SqliteRow {
  id: string; path: string; name: string | null; created_at: number;
  last_opened_at: number | null; settings_json: string | null;
  removed_from_recents: number;
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
    async listRecent(): Promise<{ project: Project; chatCount: number }[]> {
      const rows = driver.prepare<ProjectRow & { chat_count: number }>(
        `SELECT p.*, (SELECT COUNT(*) FROM chats c WHERE c.project_id = p.id AND c.deleted_at IS NULL) AS chat_count
         FROM projects p WHERE p.removed_from_recents = 0 ORDER BY p.last_opened_at DESC`,
      ).all();
      return rows.map((row) => ({ project: rowToProject(row), chatCount: row.chat_count }));
    },
    async setRemovedFromRecents(id: string, removed: boolean): Promise<void> {
      driver.prepare('UPDATE projects SET removed_from_recents = ? WHERE id = ?').run(removed ? 1 : 0, id);
    },
    async rename(id: string, name: string): Promise<Project> {
      driver.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id);
      const updated = await this.get(id);
      if (!updated) throw new Error(`proyecto ${id} no existe`);
      return updated;
    },
    async relocate(id: string, path: string): Promise<Project> {
      driver.prepare('UPDATE projects SET path = ? WHERE id = ?').run(path, id);
      const updated = await this.get(id);
      if (!updated) throw new Error(`proyecto ${id} no existe`);
      return updated;
    },
  };
}
