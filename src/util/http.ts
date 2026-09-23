/** Pagination envelope shared by list endpoints. */
export interface PageInfo {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export function parsePaging(query: Record<string, unknown>, defaultPerPage = 25, maxPerPage = 100): { page: number; perPage: number; offset: number } {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const perPage = Math.min(maxPerPage, Math.max(1, parseInt(String(query.perPage ?? String(defaultPerPage)), 10) || defaultPerPage));
  return { page, perPage, offset: (page - 1) * perPage };
}

export function pageInfo(page: number, perPage: number, total: number): PageInfo {
  return {
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/** Consistent success envelope. */
export function ok<T>(data: T, meta?: Record<string, unknown>) {
  return { success: true as const, data, ...(meta ? { meta } : {}) };
}

/** Consistent error envelope. */
export function fail(status: number, message: string, details?: unknown) {
  return { success: false as const, error: { status, message, ...(details ? { details } : {}) } };
}
