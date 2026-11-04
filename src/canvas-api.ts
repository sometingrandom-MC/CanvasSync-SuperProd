// Talks to the Canvas REST API through the HTTP helper Super Productivity gives
// issue-provider plugins. That helper runs in the app (no CORS on desktop,
// native HTTP on Android), sends the headers from `getHeaders`, and returns
// only the parsed body: no response headers. So pagination uses numbered
// pages instead of Canvas's `Link` header.

import type { PluginHttp } from '../vendor/plugin-api/index.ts';
import type { Settings } from './config.ts';

export interface CanvasTerm {
  name?: string | null;
  start_at?: string | null;
  end_at?: string | null;
}

export interface CanvasCourse {
  id: number | string;
  name?: string;
  course_code?: string;
  start_at?: string | null;
  end_at?: string | null;
  term?: CanvasTerm | null;
  access_restricted_by_date?: boolean;
}

export interface CanvasSubmission {
  submitted_at?: string | null;
  workflow_state?: string;
  excused?: boolean | null;
  missing?: boolean;
}

export interface CanvasAssignment {
  id: number | string;
  course_id?: number | string;
  name?: string;
  description?: string | null;
  due_at?: string | null;
  html_url?: string;
  points_possible?: number | null;
  updated_at?: string | null;
  submission?: CanvasSubmission | null;
}

/** Per-request timeout. SP caps it at 120 s; Canvas pages normally take < 2 s. */
export const REQUEST_TIMEOUT_MS = 45_000;
const PER_PAGE = 100;
const MAX_PAGES = 20;
const MAX_ATTEMPTS = 3;
/** Courses fetched in parallel. Canvas throttles bursts per token. */
export const COURSE_CONCURRENCY = 3;

const RETRYABLE_STATUS = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

let sleepImpl = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Test hook: replace the backoff sleep. */
export const setSleep = (fn: (ms: number) => Promise<void>): void => {
  sleepImpl = fn;
};

const errorStatus = (err: unknown): number | undefined => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

const errorText = (err: unknown): string => {
  if (!err) return '';
  const e = err as { error?: unknown; message?: unknown };
  const parts: string[] = [];
  if (typeof e.message === 'string') parts.push(e.message);
  if (typeof e.error === 'string') parts.push(e.error);
  else if (e.error) {
    try {
      parts.push(JSON.stringify(e.error));
    } catch {
      /* ignore */
    }
  }
  return parts.join(' ');
};

/** Canvas signals throttling with 403 + "Rate Limit Exceeded" (sometimes 429). */
const isRateLimited = (err: unknown): boolean =>
  errorStatus(err) === 403 && /rate limit/i.test(errorText(err));

export const isRetryable = (err: unknown): boolean => {
  const status = errorStatus(err);
  if (status === undefined) {
    // Timeouts and network failures carry no HTTP status.
    return true;
  }
  return RETRYABLE_STATUS.has(status) || isRateLimited(err);
};

/** Turns an HTTP failure into a message a user can act on. */
export const describeError = (err: unknown): string => {
  const status = errorStatus(err);
  if (status === 200) {
    // A 200 that failed to parse is an HTML page (login/SSO), not the API.
    return 'Canvas returned a web page instead of data. Check the Canvas URL.';
  }
  if (status === 401) return 'Canvas rejected the access token (401). Generate a new token.';
  if (isRateLimited(err)) return 'Canvas rate limit hit (403). It will retry on the next poll.';
  if (status === 403) return 'Canvas denied access (403).';
  if (status === 404) return 'Not found on Canvas (404). Check the Canvas URL.';
  if (status !== undefined && status >= 500) return `Canvas server error (${status}).`;
  if (status === 0 || status === undefined) {
    const text = errorText(err);
    if (/timeout/i.test(text)) return 'Canvas did not answer in time.';
    return `Could not reach Canvas${text ? `: ${text}` : '.'}`;
  }
  return `Canvas request failed (${status}).`;
};

export class CanvasClient {
  private readonly http: PluginHttp;
  private readonly settings: Settings;

  constructor(http: PluginHttp, settings: Settings) {
    this.http = http;
    this.settings = settings;
  }

  private url(path: string): string {
    return `${this.settings.baseUrl}/api/v1${path}`;
  }

  /** GET with retry + exponential backoff on throttling, 5xx and timeouts. */
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.http.get<T>(this.url(path), {
          params,
          timeout: REQUEST_TIMEOUT_MS,
        });
        if (typeof res === 'string') {
          // An HTML login/SSO page instead of JSON means the URL is wrong.
          // status 200 marks it as not retryable; describeError explains it.
          throw Object.assign(
            new Error('Canvas returned a web page instead of data. Check the Canvas URL.'),
            { status: 200 },
          );
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_ATTEMPTS || !isRetryable(err)) {
          break;
        }
        const base = isRateLimited(err) || errorStatus(err) === 429 ? 4000 : 1000;
        await sleepImpl(base * 2 ** (attempt - 1));
      }
    }
    throw lastErr;
  }

  /** Fetches every page of a list endpoint using `page=N`. */
  async getAll<T extends { id: number | string }>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = await this.get<T[]>(path, {
        ...params,
        per_page: String(PER_PAGE),
        page: String(page),
      });
      if (!Array.isArray(items) || items.length === 0) {
        break;
      }
      let added = 0;
      for (const item of items) {
        const key = String(item.id);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(item);
          added++;
        }
      }
      // A short page is the last one. A page with nothing new means the
      // endpoint ignores `page` (bookmark pagination): stop instead of looping.
      if (items.length < PER_PAGE || added === 0) {
        break;
      }
    }
    return out;
  }

  getSelf(): Promise<{ id: number | string; name?: string }> {
    return this.get('/users/self');
  }

  getActiveCourses(): Promise<CanvasCourse[]> {
    return this.getAll<CanvasCourse>('/courses', {
      enrollment_state: 'active',
      'include[]': 'term',
    });
  }

  getAssignments(courseId: string): Promise<CanvasAssignment[]> {
    return this.getAll<CanvasAssignment>(
      `/courses/${encodeURIComponent(courseId)}/assignments`,
      { 'include[]': 'submission', order_by: 'due_at' },
    );
  }

  getAssignment(courseId: string, assignmentId: string): Promise<CanvasAssignment> {
    return this.get<CanvasAssignment>(
      `/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}`,
      { 'include[]': 'submission' },
    );
  }
}

/** Runs `fn` over `items` with at most `limit` in flight; keeps input order. */
export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};
