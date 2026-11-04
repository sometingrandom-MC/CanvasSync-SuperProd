// Canvas Assignments: a Super Productivity issue provider for Canvas LMS.
//
// SP owns the integration flow: settings live in the integration dialog, SP
// polls on its own timer, imports new assignments to the provider's project,
// refreshes linked tasks, and makes every HTTP request (CORS-free on desktop,
// native on Android). This file supplies the Canvas side of that flow, plus a
// `taskCreated` hook that finishes each imported task (see task-sync.ts).

import type {
  PluginAPI as PluginAPIType,
  PluginHttp,
  PluginIssue,
  PluginSearchResult,
} from '../vendor/plugin-api/index.ts';
import {
  type Assignment,
  courseName,
  isInSession,
  parseIssueId,
  selectCourses,
  skipReason,
  toAssignment,
  toIssue,
  toSearchResult,
} from './assignments.ts';
import {
  COURSE_CONCURRENCY,
  type CanvasCourse,
  CanvasClient,
  describeError,
  mapLimit,
} from './canvas-api.ts';
import { normaliseBaseUrl, type Settings, toSettings } from './config.ts';
import { ISSUE_TYPE, type Notice, TaskSync } from './task-sync.ts';

declare const PluginAPI: PluginAPIType;

const sync = new TaskSync(PluginAPI);

// --- user notices -----------------------------------------------------------

const lastShown = new Map<string, number>();
/** Shows a snack, but the same message at most once an hour (polls repeat). */
const notify = (n: Notice): void => {
  const now = Date.now();
  if ((lastShown.get(n.msg) ?? 0) > now - 60 * 60_000) return;
  lastShown.set(n.msg, now);
  try {
    PluginAPI.showSnack({ msg: n.msg, type: n.type ?? 'INFO', ico: 'school' });
  } catch {
    /* snacks are best-effort */
  }
};

const log = (...args: unknown[]): void => {
  try {
    PluginAPI.log.err('[Canvas]', ...args);
  } catch {
    /* ignore */
  }
};

// --- Canvas fetching ----------------------------------------------------------

interface FetchResult {
  assignments: Assignment[];
  failedCourses: string[];
  firstError: unknown;
}

const fetchCourseAssignments = async (
  client: CanvasClient,
  courses: CanvasCourse[],
  settings: Settings,
): Promise<FetchResult> => {
  const failedCourses: string[] = [];
  let firstError: unknown;
  const lists = await mapLimit(courses, COURSE_CONCURRENCY, async (c) => {
    const id = String(c.id);
    try {
      const raw = await client.getAssignments(id);
      return raw.map((a) => toAssignment(a, id, courseName(c), settings.baseUrl));
    } catch (err) {
      failedCourses.push(courseName(c));
      firstError ??= err;
      return [] as Assignment[];
    }
  });
  const assignments = lists.flat();
  sync.remember(assignments);
  return { assignments, failedCourses, firstError };
};

const fetchSelected = async (http: PluginHttp, settings: Settings): Promise<FetchResult> => {
  const client = new CanvasClient(http, settings);
  const courses = selectCourses(await client.getActiveCourses(), settings);
  return fetchCourseAssignments(client, courses, settings);
};

/** Course names by id, for assignments fetched one at a time. */
let courseNameCache: Map<string, string> | null = null;
const courseNames = async (client: CanvasClient): Promise<Map<string, string>> => {
  if (!courseNameCache) {
    const courses = await client.getActiveCourses();
    courseNameCache = new Map(courses.map((c) => [String(c.id), courseName(c)]));
  }
  return courseNameCache;
};

const settingsOf = (config: Record<string, unknown>): Settings => {
  const settings = toSettings(config);
  sync.settings = settings;
  return settings;
};

// --- provider ---------------------------------------------------------------

PluginAPI.registerIssueProvider({
  configFields: [
    {
      key: 'host',
      type: 'input',
      label: 'Canvas URL',
      description: 'Your Canvas address, e.g. https://school.instructure.com',
      required: true,
    },
    {
      key: 'token',
      type: 'password',
      label: 'Access token',
      description: 'Canvas → Account → Settings → Approved Integrations → New Access Token',
      required: true,
    },
    {
      key: 'tokenHelp',
      type: 'link',
      label: 'How to create a Canvas access token',
      url: 'https://community.canvaslms.com/t5/Canvas-Basics-Guide/How-do-I-manage-API-access-tokens-in-my-user-account/ta-p/615312',
    },
    {
      key: 'courseIds',
      type: 'multiSelect',
      label: 'Courses',
      description:
        'Load your courses, then pick the ones to import. Leave empty to import every course currently in session.',
      async loadOptions(config, http) {
        const client = new CanvasClient(http, settingsOf(config));
        const courses = await client.getActiveCourses();
        return courses
          .filter((c) => !c.access_restricted_by_date)
          .sort((a, b) => Number(isInSession(b)) - Number(isInSession(a)))
          .map((c) => ({
            value: String(c.id),
            label: isInSession(c) ? courseName(c) : `${courseName(c)} (not in session)`,
          }));
      },
    },
    {
      key: 'daysAhead',
      type: 'input',
      label: 'Import assignments due within (days)',
      description: 'Default 60.',
      pattern: '^\\d*$',
    },
    {
      key: 'deadlineReminder',
      type: 'select',
      label: 'Deadline reminder',
      description: 'Never shown for tasks you have already completed.',
      options: [
        { value: 'none', label: 'None' },
        { value: 'atDue', label: 'At the due time' },
        { value: '15m', label: '15 minutes before' },
        { value: '1h', label: '1 hour before' },
        { value: '3h', label: '3 hours before' },
        { value: '1d', label: '1 day before' },
      ],
    },
    {
      key: 'includeOverdue',
      type: 'checkbox',
      label: 'Also import assignments that are already past due',
      advanced: true,
    },
    {
      key: 'includeUndated',
      type: 'checkbox',
      label: 'Also import assignments without a due date (unscheduled)',
      advanced: true,
    },
    {
      key: 'includeSubmitted',
      type: 'checkbox',
      label: 'Also import assignments you have already submitted',
      advanced: true,
    },
    {
      key: 'scheduleWholeDay',
      type: 'checkbox',
      label: 'Schedule on the due day instead of at the exact due time',
      description: 'The deadline always keeps the exact due time.',
      advanced: true,
    },
    {
      key: 'keepInDefaultProject',
      type: 'checkbox',
      label: "Keep tasks in this integration's project (no project per course)",
      advanced: true,
    },
  ],

  getHeaders(config): Record<string, string> {
    const token = String((config as { token?: unknown }).token ?? '').trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  },

  async testConnection(config, http) {
    try {
      await new CanvasClient(http, settingsOf(config)).getSelf();
      return true;
    } catch (err) {
      log('connection test failed', describeError(err));
      return false;
    }
  },

  async getNewIssuesForBacklog(config, http): Promise<PluginSearchResult[]> {
    let settings: Settings;
    try {
      settings = settingsOf(config);
    } catch (err) {
      notify({ type: 'WARNING', msg: `Canvas: ${(err as Error).message}` });
      return [];
    }

    let result: FetchResult;
    try {
      result = await fetchSelected(http, settings);
    } catch (err) {
      notify({ type: 'ERROR', msg: `Canvas: ${describeError(err)}` });
      return [];
    }
    if (result.failedCourses.length) {
      notify({
        type: 'WARNING',
        msg: `Canvas: couldn't load ${result.failedCourses.join(', ')} (${describeError(result.firstError)}). Other courses were imported.`,
      });
    }

    try {
      (await sync.reconcile(result.assignments, settings)).forEach(notify);
    } catch (err) {
      log('updating deadlines failed', err);
    }

    const excluded = await sync.excludedAssignmentIds();
    const now = Date.now();
    return result.assignments
      .filter((a) => !excluded.has(a.assignmentId) && skipReason(a, settings, now) === null)
      .map((a) => toSearchResult(a, settings));
  },

  async searchIssues(searchTerm, config, http): Promise<PluginSearchResult[]> {
    const settings = settingsOf(config);
    const { assignments } = await fetchSelected(http, settings);
    const term = searchTerm.trim().toLowerCase();
    const now = Date.now();
    return assignments
      .filter((a) =>
        term
          ? a.title.toLowerCase().includes(term) || a.courseName.toLowerCase().includes(term)
          : a.dueMs === null || a.dueMs >= now,
      )
      .sort((a, b) => (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity))
      .slice(0, 50)
      .map((a) => toSearchResult(a, settings));
  },

  async getById(issueId, config, http): Promise<PluginIssue> {
    const settings = settingsOf(config);
    const ids = parseIssueId(issueId);
    if (!ids) throw new Error(`Unknown Canvas assignment id "${issueId}"`);
    const client = new CanvasClient(http, settings);
    const raw = await client.getAssignment(ids.courseId, ids.assignmentId);
    const name =
      sync.known.get(ids.assignmentId)?.courseName ??
      (await courseNames(client).catch(() => new Map<string, string>())).get(ids.courseId) ??
      `Course ${ids.courseId}`;
    const a = toAssignment(raw, ids.courseId, name, settings.baseUrl);
    sync.remember([a]);
    return toIssue(a);
  },

  /** Batch refresh: one assignment list per course instead of one call per task. */
  async getByIds(issueIds, config, http): Promise<PluginIssue[]> {
    const settings = settingsOf(config);
    const client = new CanvasClient(http, settings);
    const wanted = new Set(issueIds);
    const courseIds = [
      ...new Set(issueIds.map((id) => parseIssueId(id)?.courseId).filter((c): c is string => !!c)),
    ];
    const names = await courseNames(client).catch(() => new Map<string, string>());
    const courses: CanvasCourse[] = courseIds.map((id) => ({ id, name: names.get(id) }));
    const { assignments } = await fetchCourseAssignments(client, courses, settings);
    const found = assignments.filter((a) => wanted.has(a.issueId));
    try {
      (await sync.reconcile(found, settings)).forEach(notify);
    } catch (err) {
      log('updating deadlines failed', err);
    }
    return found.map(toIssue);
  },

  getIssueLink(issueId, config) {
    const ids = parseIssueId(issueId);
    let base = '';
    try {
      base = normaliseBaseUrl((config as { host?: string }).host);
    } catch {
      /* unconfigured */
    }
    return ids ? `${base}/courses/${ids.courseId}/assignments/${ids.assignmentId}` : base;
  },

  issueDisplay: [
    { field: 'summary', label: 'Assignment', type: 'link', linkField: 'url' },
    { field: 'courseName', label: 'Course', type: 'text' },
    { field: 'dueText', label: 'Due', type: 'text' },
    { field: 'pointsText', label: 'Points', type: 'text', hideEmpty: true },
    { field: 'state', label: 'Status', type: 'text' },
    { field: 'body', label: 'Description', type: 'markdown', hideEmpty: true },
  ],

  // Submitting in Canvas never ticks a task off (or reopens it): done stays yours.
  doneStates: [],
});

// Finish each task SP imports from Canvas (deadline, title, marker, project).
PluginAPI.registerHook(PluginAPI.Hooks.TASK_CREATED, (payload) => {
  const task = (payload as { taskId?: string; task?: { issueType?: string | null } }) ?? {};
  if (task.taskId && task.task?.issueType === ISSUE_TYPE) {
    sync.processNewTask(task.taskId).catch((err) => log('finishing imported task failed', err));
  }
});
