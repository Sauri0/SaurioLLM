import { describe, expect, it } from 'vitest';
import type { NonLocalCallAuditEntry } from '@saurio/shared';
import { filterAuditLog, paginateAuditLog } from './auditLogFilters.js';

const entries: NonLocalCallAuditEntry[] = [
  { id: 4, ts: 4000, providerId: 'openrouter', modelName: 'qwen/qwen3', locality: 'cloud', runId: 'run-new' },
  { id: 3, ts: 3000, providerId: 'openai', modelName: 'gpt-4o', locality: 'cloud', runId: 'run-old' },
  { id: 2, ts: 2000, providerId: 'openrouter', modelName: 'mistral', locality: 'cloud', runId: 'run-mid' },
  { id: 1, ts: 1000, providerId: 'openai', modelName: 'gpt-4o-mini', locality: 'cloud', runId: 'run-old-2' },
];

describe('audit log filters', () => {
  it('filters model/run, provider and inclusive date range together', () => {
    expect(filterAuditLog(entries, { query: 'OLD', providerId: 'openai', since: 2500, until: 3500 })).toEqual([entries[1]]);
    expect(filterAuditLog(entries, { query: 'qwen', providerId: '', since: 4000, until: 4000 })).toEqual([entries[0]]);
  });

  it('paginates heterogeneous records in their received order', () => {
    const page = paginateAuditLog(entries, 1, 2);
    expect(page).toMatchObject({ page: 1, pageCount: 2, total: 4 });
    expect(page.items.map((entry) => entry.id)).toEqual([2, 1]);
  });
});
