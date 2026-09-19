import type { NonLocalCallAuditEntry } from '@saurio/shared';

export interface AuditLogFilters {
  query: string;
  providerId: string;
  since?: number;
  until?: number;
}

export interface AuditLogPage {
  items: NonLocalCallAuditEntry[];
  page: number;
  pageCount: number;
  total: number;
}

/** El canal entrega como máximo los 200 registros más recientes; el filtrado es local a ese alcance. */
export function filterAuditLog(entries: NonLocalCallAuditEntry[], filters: AuditLogFilters): NonLocalCallAuditEntry[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (filters.providerId && entry.providerId !== filters.providerId) return false;
    if (filters.since !== undefined && entry.ts < filters.since) return false;
    if (filters.until !== undefined && entry.ts > filters.until) return false;
    if (query && !`${entry.modelName} ${entry.runId}`.toLocaleLowerCase().includes(query)) return false;
    return true;
  });
}

export function paginateAuditLog(entries: NonLocalCallAuditEntry[], page: number, pageSize = 20): AuditLogPage {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(entries.length / safePageSize));
  const safePage = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  return {
    items: entries.slice(safePage * safePageSize, (safePage + 1) * safePageSize),
    page: safePage,
    pageCount,
    total: entries.length,
  };
}
