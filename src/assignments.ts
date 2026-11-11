// Canvas data -> the plugin's own assignment model, the import filters, and the
// shapes Super Productivity expects (search results and issues).

import type { PluginIssue, PluginSearchResult } from '../vendor/plugin-api/index.ts';
import type { CanvasAssignment, CanvasCourse, CanvasSubmission } from './canvas-api.ts';
import type { Settings } from './config.ts';

export interface Assignment {
  /** SP issue id: `<courseId>:<assignmentId>`, so it can be fetched without lookups. */
  issueId: string;
  /** Canvas assignment id; also what the `[canvas-sync:<id>]` notes marker holds. */
  assignmentId: string;
  courseId: string;
  courseName: string;
  title: string;
  dueMs: number | null;
  url: string;
  points: number | null;
  submitted: boolean;
  updatedMs: number;
  description: string;
}

export const makeIssueId = (courseId: string, assignmentId: string): string =>
  `${courseId}:${assignmentId}`;

export const parseIssueId = (
  issueId: string,
): { courseId: string; assignmentId: string } | null => {
  const m = /^(\d+):(\d+)$/.exec(String(issueId));
  return m ? { courseId: m[1], assignmentId: m[2] } : null;
};

export const toMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
};

export const isSubmitted = (s: CanvasSubmission | null | undefined): boolean => {
  if (!s) return false;
  if (s.excused) return true;
  if (s.submitted_at) return true;
  return ['submitted', 'graded', 'pending_review', 'complete'].includes(
    s.workflow_state ?? '',
  );
};

export const courseName = (c: CanvasCourse): string =>
  (c.name || c.course_code || `Course ${c.id}`).trim();

/** True when today falls inside the course's (or its term's) dates. */
export const isInSession = (c: CanvasCourse, now = Date.now()): boolean => {
  if (c.access_restricted_by_date) return false;
  const start = toMs(c.start_at) ?? toMs(c.term?.start_at);
  const end = toMs(c.end_at) ?? toMs(c.term?.end_at);
  if (start !== null && now < start) return false;
  if (end !== null && now > end) return false;
  return true;
};

/** Courses to sync: the picked ones, or every in-session course if none picked. */
export const selectCourses = (
  courses: CanvasCourse[],
  settings: Settings,
  now = Date.now(),
): CanvasCourse[] => {
  // Canvas lists courses you can't open (restricted by date) without a name.
  const usable = courses.filter((c) => c && c.id != null && !c.access_restricted_by_date);
  if (settings.courseIds.length) {
    const picked = new Set(settings.courseIds);
    return usable.filter((c) => picked.has(String(c.id)));
  }
  return usable.filter((c) => isInSession(c, now));
};

/** Converts Canvas's HTML description to readable plain text with links kept. */
export const htmlToText = (html: string | null | undefined): string => {
  if (!html) return '';
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<a\s[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const label = String(text).replace(/<[^>]+>/g, '').trim();
      return label && label !== href ? `[${label}](${href})` : href;
    })
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|tr|table|blockquote)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export const toAssignment = (
  a: CanvasAssignment,
  courseId: string,
  courseTitle: string,
  baseUrl: string,
): Assignment => {
  const assignmentId = String(a.id);
  return {
    issueId: makeIssueId(courseId, assignmentId),
    assignmentId,
    courseId,
    courseName: courseTitle,
    title: (a.name || 'Assignment').trim(),
    dueMs: toMs(a.due_at),
    url: a.html_url || `${baseUrl}/courses/${courseId}/assignments/${assignmentId}`,
    points: typeof a.points_possible === 'number' ? a.points_possible : null,
    submitted: isSubmitted(a.submission),
    updatedMs: toMs(a.updated_at) ?? 0,
    description: htmlToText(a.description),
  };
};

export type SkipReason = 'submitted' | 'undated' | 'overdue' | 'tooFar' | null;

/** Why an assignment should not be auto-imported, or null to import it. */
export const skipReason = (
  a: Assignment,
  settings: Settings,
  now = Date.now(),
): SkipReason => {
  if (a.submitted && !settings.includeSubmitted) return 'submitted';
  if (a.dueMs === null) return settings.includeUndated ? null : 'undated';
  if (a.dueMs < now && !settings.includeOverdue) return 'overdue';
  if (a.dueMs > now + settings.daysAhead * 86_400_000) return 'tooFar';
  return null;
};

export const formatDue = (ms: number | null): string =>
  ms === null
    ? 'No due date'
    : new Date(ms).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });

const stateOf = (a: Assignment): string => (a.submitted ? 'submitted' : 'open');

/**
 * SP reads `#word` at the start of a title or after a space as a tag when it
 * creates a task ("Homework #3" -> tag "3"). Adding a space after the `#`
 * stops that; the plugin restores the exact title right after import.
 */
export const withoutTagSyntax = (title: string): string =>
  title.replace(/(^|\s)#(?=[^\s+#@!])/g, '$1# ');

/**
 * Search/import result. On import SP schedules the task at `dueWithTime`, or on
 * the day of `start` when whole-day scheduling is on. Extra fields ride along
 * for the issue panel.
 */
export const toSearchResult = (a: Assignment, settings: Settings): PluginSearchResult => {
  const schedule: Partial<PluginSearchResult> =
    a.dueMs === null
      ? {}
      : settings.scheduleWholeDay
        ? { start: a.dueMs, isAllDay: true }
        : { dueWithTime: a.dueMs };
  return {
    id: a.issueId,
    title: withoutTagSyntax(a.title),
    url: a.url,
    status: stateOf(a),
    description: a.description,
    ...schedule,
    courseName: a.courseName,
    dueText: formatDue(a.dueMs),
  };
};

export const toIssue = (a: Assignment): PluginIssue => ({
  id: a.issueId,
  title: a.title,
  body: a.description,
  url: a.url,
  state: stateOf(a),
  lastUpdated: a.updatedMs,
  courseName: a.courseName,
  dueText: formatDue(a.dueMs),
  pointsText: a.points === null ? '' : `${a.points} pts`,
  summary: a.title,
});
