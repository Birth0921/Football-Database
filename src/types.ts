/** Types shared across the platform. */

export type ProviderName = 'api-football';

export interface ProviderResponse<T = unknown> {
  get: string;
  parameters: Record<string, unknown>;
  errors: unknown[] | Record<string, string>;
  results: number;
  paging: { current: number; total: number };
  response: T[];
}

export interface ProviderRequestResult<T = unknown> {
  data: ProviderResponse<T>;
  httpStatus: number;
  fromCache: boolean;
  dailyRemaining: number | null;
  minuteRemaining: number | null;
}

export type FixtureStatusShort =
  | 'TBD'
  | 'NS'
  | '1H'
  | 'HT'
  | '2H'
  | 'ET'
  | 'BT'
  | 'P'
  | 'FT'
  | 'AET'
  | 'PEN'
  | 'PST'
  | 'CANC'
  | 'ABD'
  | 'SUSP'
  | 'INT'
  | 'LIVE';

export const COMPLETED_STATUSES = new Set(['FT', 'AET', 'PEN']);
export const LIVE_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT', 'LIVE']);

export interface SyncTaskRow {
  id: number;
  job_id: number | null;
  task_key: string;
  task_type: string;
  params: Record<string, unknown>;
  priority: number;
  status: string;
  attempts: number;
  max_attempts: number;
  quota_defers: number | null;
  scheduled_for: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  result_summary: unknown;
  last_error: string | null;
  error_info: unknown;
}

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode = 500,
    public code = 'INTERNAL',
    public details?: unknown,
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Rate limit exceeded') {
    super(message, 429, 'RATE_LIMITED');
  }
}
