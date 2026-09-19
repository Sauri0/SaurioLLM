export function fileSearchOffset(page: number, pageSize: number): number {
  return Math.min(100_000, Math.max(0, Math.floor(page)) * Math.max(1, Math.floor(pageSize)));
}
