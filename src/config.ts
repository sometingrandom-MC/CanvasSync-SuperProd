// Plugin configuration: the raw values SP stores for the integration, and the
// normalised settings the rest of the plugin works with.
//
// The form has no per-field defaults, so an untouched checkbox is `undefined`.
// Every checkbox is therefore named so that "off" is the default behaviour.

export type ReminderOption = 'none' | 'atDue' | '15m' | '1h' | '3h' | '1d';

export interface RawConfig {
  host?: string;
  token?: string;
  courseIds?: string[] | string;
  daysAhead?: string | number;
  includeOverdue?: boolean;
  includeUndated?: boolean;
  includeSubmitted?: boolean;
  scheduleWholeDay?: boolean;
  keepInDefaultProject?: boolean;
  deadlineReminder?: ReminderOption;
}

export interface Settings {
  /** Canvas base URL without trailing slash, e.g. https://school.instructure.com */
  baseUrl: string;
  token: string;
  /** Explicitly picked courses; empty means "all courses currently in session". */
  courseIds: string[];
  daysAhead: number;
  includeOverdue: boolean;
  includeUndated: boolean;
  includeSubmitted: boolean;
  scheduleWholeDay: boolean;
  projectPerCourse: boolean;
  reminderOffsetMs: number | null;
}

export const DEFAULT_DAYS_AHEAD = 60;

const REMINDER_OFFSETS: Record<ReminderOption, number | null> = {
  none: null,
  atDue: 0,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '3h': 3 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

/**
 * Normalises what the user typed for the Canvas address. Accepts a bare host
 * ("school.instructure.com"), a full URL, or a pasted page URL, and keeps only
 * scheme + host (+ port). Defaults to https.
 */
export const normaliseBaseUrl = (input: string | undefined): string => {
  const raw = (input ?? '').trim();
  if (!raw) {
    throw new Error('Canvas URL is not configured.');
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${raw}" is not a valid Canvas URL.`);
  }
  return `${url.protocol}//${url.host}`;
};

export const toSettings = (config: Record<string, unknown>): Settings => {
  const cfg = config as RawConfig;
  const token = (cfg.token ?? '').trim();
  if (!token) {
    throw new Error('Canvas access token is not configured.');
  }
  const days = parseInt(String(cfg.daysAhead ?? ''), 10);
  const courseIds = Array.isArray(cfg.courseIds)
    ? cfg.courseIds
    : typeof cfg.courseIds === 'string' && cfg.courseIds
      ? [cfg.courseIds]
      : [];
  return {
    baseUrl: normaliseBaseUrl(cfg.host),
    token,
    courseIds: courseIds.map(String).filter(Boolean),
    daysAhead: Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS_AHEAD,
    includeOverdue: !!cfg.includeOverdue,
    includeUndated: !!cfg.includeUndated,
    includeSubmitted: !!cfg.includeSubmitted,
    scheduleWholeDay: !!cfg.scheduleWholeDay,
    projectPerCourse: !cfg.keepInDefaultProject,
    reminderOffsetMs: REMINDER_OFFSETS[cfg.deadlineReminder ?? 'none'] ?? null,
  };
};
